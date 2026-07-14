import {
  DEFAULT_MIN_WIKI_QUERY_SCORE,
  DEFAULT_QUERY_RESULT_LIMIT,
  DEFAULT_RAW_EXCERPT_CONTEXT_LINES,
  DEFAULT_RAW_QUERY_RESULT_LIMIT,
  RAW_QUERY_TERM_WEIGHT,
  RAW_QUERY_TITLE_WEIGHT,
  SCHEMA_VERSION,
  TEXT_ENCODING,
  WIKI_PAGE_PATH_PATTERN,
} from "../domain/constants.js";
import type {
  QueryPacket,
  QueryPolicySnapshot,
  RawQueryEvidence,
  WikiSearchResult,
} from "../domain/query-models.js";
import {
  DirectoryName,
  ErrorCode,
  ExitCode,
  MediaType,
  QueryFallbackPolicy,
  RawFallbackMode,
  RawFallbackReason,
  SourceStatus,
  VaultFileName,
} from "../domain/enums.js";
import { LoreError } from "../errors.js";
import { safeJoin } from "../infrastructure/filesystem.js";
import { sha256 } from "../infrastructure/hash.js";
import { readYamlFile } from "../infrastructure/serialization.js";
import { listSources, readSourceSnapshot } from "./source-service.js";
import {
  getWikiRevision,
  readWikiPage,
  searchWiki,
  tokenizeForSearch,
} from "./wiki-service.js";
import { createQueryId, recordQueryUsage } from "./usage-service.js";

const QUERYABLE_MEDIA_TYPES = new Set<string>([
  MediaType.Markdown,
  MediaType.PlainText,
  MediaType.Json,
  MediaType.Yaml,
  MediaType.Html,
  MediaType.Csv,
]);

export interface PrepareQueryOptions {
  fallback_mode?: RawFallbackMode;
  max_wiki_results?: number;
  max_raw_results?: number;
  now?: Date;
  track_usage?: boolean;
}

/** 读取 Wiki 页面；调用方只需提供 prepare/search 返回的受控相对路径。 */
export async function showWikiPage(
  root: string,
  relativePath: string,
): Promise<WikiSearchResult> {
  if (!new RegExp(WIKI_PAGE_PATH_PATTERN, "u").test(relativePath)) {
    throw new LoreError(
      ErrorCode.InvalidArgument,
      `Wiki 页面路径无效：${relativePath}`,
      ExitCode.InvalidArgument,
    );
  }
  const page = await readWikiPage(root, relativePath);
  const title =
    typeof page.frontmatter.title === "string"
      ? page.frontmatter.title
      : relativePath.split("/").at(-1)?.replace(/\.md$/u, "") ?? relativePath;
  const description =
    typeof page.frontmatter.description === "string"
      ? page.frontmatter.description
      : undefined;
  const tags = Array.isArray(page.frontmatter.tags)
    ? page.frontmatter.tags.filter((item): item is string => typeof item === "string")
    : [];
  return {
    path: page.path,
    title,
    page_type:
      typeof page.frontmatter.type === "string" ? page.frontmatter.type : "concept",
    ...(description ? { description } : {}),
    tags,
    score: 0,
    match_fields: [],
    excerpt: page.body.split("\n").find((line) => line.trim().length > 0) ?? "",
    content_sha256: page.content_sha256,
    frontmatter: page.frontmatter,
    body: page.body,
  };
}

/** 将不可信的 Profile 数值收敛为正整数。 */
function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

/** 读取查询策略；命令参数只覆盖本次查询，不会改写 Profile。 */
async function readQueryPolicy(
  root: string,
  options: PrepareQueryOptions,
): Promise<QueryPolicySnapshot> {
  const profile = await readYamlFile<Record<string, unknown>>(
    safeJoin(root, DirectoryName.Schema, VaultFileName.Profile),
  );
  const query =
    profile.query && typeof profile.query === "object" && !Array.isArray(profile.query)
      ? (profile.query as Record<string, unknown>)
      : {};
  const configuredFallback =
    query.raw_fallback === QueryFallbackPolicy.WhenEvidenceIsInsufficient
      ? RawFallbackMode.Auto
      : RawFallbackMode.Never;
  return {
    wiki_first: query.wiki_first !== false,
    fallback_mode: options.fallback_mode ?? configuredFallback,
    minimum_wiki_score:
      typeof query.minimum_wiki_score === "number" &&
      Number.isFinite(query.minimum_wiki_score) &&
      query.minimum_wiki_score >= 0
        ? query.minimum_wiki_score
        : DEFAULT_MIN_WIKI_QUERY_SCORE,
    max_wiki_results: positiveInteger(
      options.max_wiki_results ?? query.max_candidate_pages,
      DEFAULT_QUERY_RESULT_LIMIT,
    ),
    max_raw_results: positiveInteger(
      options.max_raw_results ?? query.max_raw_evidence,
      DEFAULT_RAW_QUERY_RESULT_LIMIT,
    ),
  };
}

/** 统计一行文本命中了多少个不同查询词。 */
function lineMatchCount(line: string, queryTerms: Set<string>): number {
  const lineTerms = new Set(tokenizeForSearch(line));
  return [...queryTerms].filter((term) => lineTerms.has(term)).length;
}

/**
 * 从所有 Active Source 的 latest Snapshot 中检索逐行证据。
 * Raw 只作为 Wiki 证据不足时的回退，不参与规范知识页面排序。
 */
async function searchRawEvidence(
  root: string,
  question: string,
  limit: number,
): Promise<RawQueryEvidence[]> {
  const queryTerms = new Set(tokenizeForSearch(question));
  if (queryTerms.size === 0) {
    return [];
  }
  const evidence: RawQueryEvidence[] = [];
  for (const source of await listSources(root)) {
    if (source.status !== SourceStatus.Active) {
      continue;
    }
    const captured = await readSourceSnapshot(root, source.source_id);
    if (!QUERYABLE_MEDIA_TYPES.has(captured.snapshot.media_type)) {
      continue;
    }
    const content = captured.content.toString(TEXT_ENCODING).replaceAll("\r\n", "\n");
    const lines = content.split("\n");
    const titleMatches = lineMatchCount(source.title, queryTerms);
    const selectedRanges: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      const matchedTerms = lineMatchCount(lines[index] ?? "", queryTerms);
      if (matchedTerms === 0) {
        continue;
      }
      const start = Math.max(1, index + 1 - DEFAULT_RAW_EXCERPT_CONTEXT_LINES);
      const end = Math.min(
        lines.length,
        index + 1 + DEFAULT_RAW_EXCERPT_CONTEXT_LINES,
      );
      if (selectedRanges.some((range) => start <= range.end && end >= range.start)) {
        continue;
      }
      selectedRanges.push({ start, end });
      const quote = lines.slice(start - 1, end).join("\n");
      const locator = `line:${start}-${end}`;
      evidence.push({
        source_id: source.source_id,
        source_title: source.title,
        snapshot_id: captured.snapshot.snapshot_id,
        locator,
        quote,
        quote_sha256: sha256(quote),
        score:
          matchedTerms * RAW_QUERY_TERM_WEIGHT +
          titleMatches * RAW_QUERY_TITLE_WEIGHT,
        uri: `lore://source/${source.source_id}/snapshot/${captured.snapshot.snapshot_id}#${locator}`,
      });
    }
  }
  return evidence
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.source_id.localeCompare(right.source_id) ||
        left.locator.localeCompare(right.locator),
    )
    .slice(0, limit);
}

/**
 * 生成查询上下文包：始终先检索 Wiki，仅在策略要求时补充 Raw 摘录。
 * 该函数不调用模型；默认只向 `.lore/usage` 写入隐私安全的召回统计。
 */
export async function prepareQuery(
  root: string,
  question: string,
  options: PrepareQueryOptions = {},
): Promise<QueryPacket> {
  const normalizedQuestion = question.trim();
  if (normalizedQuestion.length === 0) {
    throw new LoreError(
      ErrorCode.InvalidArgument,
      "查询问题不能为空",
      ExitCode.InvalidArgument,
    );
  }
  const policy = await readQueryPolicy(root, options);
  const wikiCandidates = await searchWiki(
    root,
    normalizedQuestion,
    policy.max_wiki_results,
  );
  const topWikiScore = wikiCandidates[0]?.score ?? 0;
  let reason: RawFallbackReason;
  let shouldFallback: boolean;
  if (policy.fallback_mode === RawFallbackMode.Never) {
    shouldFallback = false;
    reason = RawFallbackReason.Disabled;
  } else if (policy.fallback_mode === RawFallbackMode.Always || !policy.wiki_first) {
    shouldFallback = true;
    reason = RawFallbackReason.Forced;
  } else if (wikiCandidates.length === 0) {
    shouldFallback = true;
    reason = RawFallbackReason.NoWikiCandidate;
  } else if (topWikiScore < policy.minimum_wiki_score) {
    shouldFallback = true;
    reason = RawFallbackReason.WikiEvidenceInsufficient;
  } else {
    shouldFallback = false;
    reason = RawFallbackReason.WikiEvidenceSufficient;
  }
  const packet: QueryPacket = {
    version: SCHEMA_VERSION,
    query_id: createQueryId(),
    usage_tracked: false,
    question: normalizedQuestion,
    created_at: (options.now ?? new Date()).toISOString(),
    wiki_revision: await getWikiRevision(root),
    policy,
    wiki_candidates: wikiCandidates,
    raw_evidence: shouldFallback
      ? await searchRawEvidence(root, normalizedQuestion, policy.max_raw_results)
      : [],
    fallback: { used: shouldFallback, reason },
  };
  const usageTracked = await recordQueryUsage(root, packet, {
    ...(options.track_usage === undefined ? {} : { track: options.track_usage }),
  });
  return { ...packet, usage_tracked: usageTracked };
}
