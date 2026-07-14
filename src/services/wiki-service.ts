import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  CONCEPT_ID_PREFIX,
  FRONTMATTER_DELIMITER,
  SCHEMA_VERSION,
  TEXT_ENCODING,
} from "../domain/constants.js";
import type {
  CompileCandidate,
  ConceptDraft,
  EvidenceReference,
  WikiBaseRevision,
} from "../domain/compile-models.js";
import {
  CandidateMatchReason,
  DirectoryName,
  KnowledgeStatus,
  VaultFileName,
  WikiPageType,
} from "../domain/enums.js";
import { pathExists, safeJoin } from "../infrastructure/filesystem.js";
import { sha256 } from "../infrastructure/hash.js";
import { serializeYaml } from "../infrastructure/serialization.js";
import { walkFiles } from "../infrastructure/walk.js";

const execFileAsync = promisify(execFile);

/** 已解析的 Wiki Concept 页面。 */
export interface WikiPage {
  path: string;
  absolute_path: string;
  content: string;
  content_sha256: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** 解析 Markdown YAML frontmatter，并拒绝不完整页面。 */
export function parseWikiPage(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalized = content.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    throw new Error("Wiki 页面缺少 YAML frontmatter");
  }
  const closingIndex = lines.indexOf(FRONTMATTER_DELIMITER, 1);
  if (closingIndex < 0) {
    throw new Error("Wiki 页面 frontmatter 缺少结束分隔符");
  }
  const parsed = parseYaml(lines.slice(1, closingIndex).join("\n")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Wiki 页面 frontmatter 必须是对象");
  }
  return {
    frontmatter: parsed as Record<string, unknown>,
    body: lines.slice(closingIndex + 1).join("\n").trim(),
  };
}

/** 读取所有知识页面；index.md 与 log.md 不属于 Concept。 */
export async function listWikiPages(root: string): Promise<WikiPage[]> {
  const pagesRoot = safeJoin(root, DirectoryName.Wiki, DirectoryName.Pages);
  const files = (await walkFiles(pagesRoot))
    .filter((filePath) => path.extname(filePath).toLowerCase() === ".md")
    .sort((left, right) => left.localeCompare(right));
  const pages: WikiPage[] = [];

  for (const absolutePath of files) {
    const content = await readFile(absolutePath, TEXT_ENCODING);
    const parsed = parseWikiPage(content);
    pages.push({
      path: path.relative(root, absolutePath).split(path.sep).join("/"),
      absolute_path: absolutePath,
      content,
      content_sha256: sha256(content),
      ...parsed,
    });
  }
  return pages;
}

/** 对 Wiki Bundle 的全部文件做稳定哈希，作为乐观并发基线。 */
export async function getWikiRevision(root: string): Promise<WikiBaseRevision> {
  const wikiRoot = safeJoin(root, DirectoryName.Wiki);
  const files = (await walkFiles(wikiRoot)).sort((left, right) =>
    left.localeCompare(right),
  );
  const entries: string[] = [];
  for (const filePath of files) {
    const relativePath = path.relative(wikiRoot, filePath).split(path.sep).join("/");
    entries.push(`${relativePath}\0${sha256(await readFile(filePath))}`);
  }

  let gitHead: string | undefined;
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    gitHead = result.stdout.trim() || undefined;
  } catch {
    // Vault 不一定是 Git 仓库；Wiki 内容哈希才是强制并发基线。
  }

  return {
    wiki_sha256: sha256(entries.join("\n")),
    ...(gitHead ? { git_head: gitHead } : {}),
  };
}

/** 生成中英文混合检索词；中文额外生成双字片段以提升简单召回率。 */
function searchTerms(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase().normalize("NFKC");
  const terms = new Set(
    normalized.split(/[^\p{L}\p{N}]+/gu).filter((item) => item.length >= 2),
  );
  const chineseRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  for (const run of chineseRuns) {
    for (let index = 0; index < run.length - 1; index += 1) {
      terms.add(run.slice(index, index + 2));
    }
  }
  return terms;
}

/**
 * 使用标题、标签、正文与历史 Evidence 做确定性候选召回。
 * 这里不负责语义判断，只为后续 Skill 提供规模受控的可更新页面集合。
 */
export async function findCompileCandidates(
  root: string,
  sourceId: string,
  sourceTitle: string,
  snapshotContent: string,
  maximum: number,
): Promise<CompileCandidate[]> {
  const inputTerms = searchTerms(`${sourceTitle}\n${snapshotContent}`);
  const candidates: CompileCandidate[] = [];

  for (const page of await listWikiPages(root)) {
    const title = typeof page.frontmatter.title === "string" ? page.frontmatter.title : "";
    const tags = Array.isArray(page.frontmatter.tags)
      ? page.frontmatter.tags.filter((item): item is string => typeof item === "string")
      : [];
    const lore = page.frontmatter.lore;
    const evidence =
      lore && typeof lore === "object" && !Array.isArray(lore)
        ? (lore as Record<string, unknown>).evidence
        : undefined;
    const reasons = new Set<CandidateMatchReason>();
    let score = 0;

    const scoreField = (
      value: string,
      weight: number,
      reason: CandidateMatchReason,
    ): void => {
      const matches = [...searchTerms(value)].filter((term) => inputTerms.has(term));
      if (matches.length > 0) {
        score += Math.min(matches.length, 10) * weight;
        reasons.add(reason);
      }
    };

    scoreField(title, 8, CandidateMatchReason.Title);
    scoreField(tags.join(" "), 5, CandidateMatchReason.Tag);
    scoreField(page.body, 1, CandidateMatchReason.Body);
    if (
      Array.isArray(evidence) &&
      evidence.some(
        (item) =>
          item &&
          typeof item === "object" &&
          (item as Record<string, unknown>).source_id === sourceId,
      )
    ) {
      score += 20;
      reasons.add(CandidateMatchReason.ExistingEvidence);
    }

    if (score > 0) {
      candidates.push({
        path: page.path,
        content_sha256: page.content_sha256,
        score,
        match_reasons: [...reasons],
        frontmatter: page.frontmatter,
        body: page.body,
      });
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, maximum);
}

/** 将结构化 Concept 渲染为 OKF Markdown，并保留更新页面中的未知字段。 */
export function renderConceptPage(
  runId: string,
  targetPath: string,
  concept: ConceptDraft,
  existingFrontmatter: Record<string, unknown> | undefined,
  timestamp: string,
): string {
  const existingLore =
    existingFrontmatter?.lore &&
    typeof existingFrontmatter.lore === "object" &&
    !Array.isArray(existingFrontmatter.lore)
      ? (existingFrontmatter.lore as Record<string, unknown>)
      : {};
  const suppliedLore = concept.lore ?? {};
  const lore = {
    ...existingLore,
    ...suppliedLore,
    id:
      suppliedLore.id ??
      (typeof existingLore.id === "string"
        ? existingLore.id
        : `${CONCEPT_ID_PREFIX}${sha256(`${runId}\0${targetPath}`).slice(0, 12)}`),
    schema_version: suppliedLore.schema_version ?? SCHEMA_VERSION,
    status: suppliedLore.status ?? KnowledgeStatus.Active,
  };
  const frontmatter: Record<string, unknown> = {
    ...existingFrontmatter,
    type: concept.type,
    ...(concept.title ? { title: concept.title } : {}),
    ...(concept.description ? { description: concept.description } : {}),
    ...(concept.resource ? { resource: concept.resource } : {}),
    ...(concept.tags ? { tags: concept.tags } : {}),
    timestamp: concept.timestamp ?? timestamp,
    lore,
  };
  // 去掉 Lore 上次生成的尾部证据区，避免更新页面时重复追加同一段。
  const body = concept.body.trim().replace(/\n+## 证据\n\n(?:- \[[^\n]+\]\([^\n]+\)\n?)+$/u, "");
  const citations = (lore.evidence as EvidenceReference[] | undefined) ?? [];
  const citationSection = citations.length
    ? `\n\n## 证据\n\n${citations
        .map(
          (item) =>
            `- [${item.source_id}/${item.snapshot_id}](lore://source/${item.source_id}/snapshot/${item.snapshot_id}#${item.locator})`,
        )
        .join("\n")}`
    : "";
  return `${FRONTMATTER_DELIMITER}\n${serializeYaml(frontmatter).trimEnd()}\n${FRONTMATTER_DELIMITER}\n\n${body}${citationSection}\n`;
}

/** 由当前页面集合重建导航索引，避免索引与页面事实分叉。 */
export async function renderWikiIndex(root: string): Promise<string> {
  const pages = await listWikiPages(root);
  const groups = new Map<string, WikiPage[]>();
  for (const page of pages) {
    const type =
      typeof page.frontmatter.type === "string"
        ? page.frontmatter.type
        : WikiPageType.Concept;
    groups.set(type, [...(groups.get(type) ?? []), page]);
  }
  const sections = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, entries]) => {
      const links = entries
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((page) => {
          const title =
            typeof page.frontmatter.title === "string"
              ? page.frontmatter.title
              : path.basename(page.path, ".md");
          return `- [${title}](./${path.relative("wiki", page.path)})`;
        })
        .join("\n");
      return `## ${type}\n\n${links}`;
    });
  return `# Lore 知识库\n\n这是由 Lore 维护的 OKF 编译知识包。\n\n${
    sections.length > 0 ? sections.join("\n\n") : "## 知识页面\n\n尚未编译任何知识页面。"
  }\n`;
}

/** 生成一次编译写入日志的追加段落。 */
export function renderCompileLogEntry(
  runId: string,
  timestamp: string,
  summary: string,
  changedPaths: string[],
): string {
  const paths = changedPaths.map((item) => `  - \`${item}\``).join("\n");
  return `\n## ${timestamp}\n\n* **知识编译**（${runId}）：${summary}\n${paths}\n`;
}

/** 判断 Wiki 页面路径当前是否存在。 */
export async function wikiPageExists(root: string, relativePath: string): Promise<boolean> {
  return pathExists(safeJoin(root, relativePath));
}

/** 读取单个 Wiki 页面。 */
export async function readWikiPage(root: string, relativePath: string): Promise<WikiPage> {
  const absolutePath = safeJoin(root, relativePath);
  const content = await readFile(absolutePath, TEXT_ENCODING);
  const parsed = parseWikiPage(content);
  return {
    path: relativePath,
    absolute_path: absolutePath,
    content,
    content_sha256: sha256(content),
    ...parsed,
  };
}
