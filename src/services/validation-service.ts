import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import { parse as parseYaml } from "yaml";
import {
  FRONTMATTER_DELIMITER,
  TEXT_ENCODING,
} from "../domain/constants.js";
import {
  DiagnosticCode,
  DirectoryName,
  ValidationSeverity,
  VaultFileName,
} from "../domain/enums.js";
import type {
  LatestSnapshotPointer,
  SnapshotManifest,
  SourceMetadata,
  ValidationDiagnostic,
  ValidationReport,
} from "../domain/models.js";
import {
  pathExists,
  safeJoin,
} from "../infrastructure/filesystem.js";
import { walkFiles } from "../infrastructure/walk.js";
import { createSnapshotId, sha256 } from "../infrastructure/hash.js";

interface Validators {
  concept: ValidateFunction;
  source: ValidateFunction;
  snapshot: ValidateFunction;
  latest: ValidateFunction;
  changeSet: ValidateFunction;
}

interface ParsedFrontmatter {
  attributes: unknown;
  body: string;
}

const applyFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

const RESERVED_WIKI_FILES = new Set<string>([
  VaultFileName.Index,
  VaultFileName.Log,
]);

/** 将 Ajv 的结构化错误压缩成适合 CLI 展示的一行文本。 */
function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "Schema 校验失败";
  }

  return errors
    .map(
      (error) =>
        `${error.instancePath || "/"} 未通过 '${error.keyword}' 规则校验`,
    )
    .join("; ");
}

/** 创建统一格式的诊断，保证所有检查器输出一致。 */
function diagnostic(
  severity: ValidationSeverity,
  code: DiagnosticCode,
  targetPath: string,
  message: string,
): ValidationDiagnostic {
  return { severity, code, path: targetPath, message };
}

/**
 * 解析 OKF 文档头部的 YAML frontmatter。
 * 返回 undefined 表示文档没有 frontmatter，抛错表示格式存在但已损坏。
 */
function parseFrontmatter(content: string): ParsedFrontmatter | undefined {
  const normalized = content.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    return undefined;
  }

  const closingIndex = lines.indexOf(FRONTMATTER_DELIMITER, 1);
  if (closingIndex < 0) {
    throw new Error("frontmatter 缺少结束分隔符");
  }

  const yamlContent = lines.slice(1, closingIndex).join("\n");
  return {
    attributes: parseYaml(yamlContent),
    body: lines.slice(closingIndex + 1).join("\n"),
  };
}

/** 编译 Vault 自带的 JSON Schema；Schema 自身非法时也会在这里失败。 */
async function createValidators(root: string): Promise<Validators> {
  const schemaRoot = safeJoin(root, DirectoryName.Schema);
  const conceptSchema = JSON.parse(
    await readFile(
      safeJoin(schemaRoot, VaultFileName.ConceptSchema),
      TEXT_ENCODING,
    ),
  ) as Record<string, unknown>;
  const sourceSchema = JSON.parse(
    await readFile(safeJoin(schemaRoot, VaultFileName.SourceSchema), TEXT_ENCODING),
  ) as Record<string, unknown>;
  const changeSetSchema = JSON.parse(
    await readFile(
      safeJoin(schemaRoot, VaultFileName.ChangeSetSchema),
      TEXT_ENCODING,
    ),
  ) as Record<string, unknown>;

  const ajv = new Ajv({ allErrors: true, strict: true });
  applyFormats(ajv);
  ajv.addSchema(sourceSchema, "source-root");

  return {
    concept: ajv.compile(conceptSchema),
    source: ajv.compile({ $ref: "source-root#/definitions/source" }),
    snapshot: ajv.compile({ $ref: "source-root#/definitions/snapshot" }),
    latest: ajv.compile({ $ref: "source-root#/definitions/latest" }),
    changeSet: ajv.compile(changeSetSchema),
  };
}

/** 记录路径身份与元数据身份不一致的问题。 */
function pushIdentityMismatch(
  diagnostics: ValidationDiagnostic[],
  relativePath: string,
  expected: string,
  actual: string,
): void {
  diagnostics.push(
    diagnostic(
      ValidationSeverity.Error,
      DiagnosticCode.IdentityMismatch,
      relativePath,
      `路径身份 '${expected}' 与元数据身份 '${actual}' 不一致`,
    ),
  );
}

/**
 * 重新读取 Snapshot 内容并计算哈希。
 * 这是 Raw append-only 约束的实际保障，而不是只相信 manifest 中的声明。
 */
async function validateSnapshotIntegrity(
  root: string,
  manifestPath: string,
  manifest: SnapshotManifest,
  diagnostics: ValidationDiagnostic[],
): Promise<void> {
  const relativePath = path.relative(root, manifestPath);
  const snapshotDirectory = path.dirname(manifestPath);
  const expectedSnapshotId = path.basename(snapshotDirectory);
  const expectedSourceId = path.basename(
    path.dirname(path.dirname(snapshotDirectory)),
  );

  if (manifest.snapshot_id !== expectedSnapshotId) {
    pushIdentityMismatch(
      diagnostics,
      relativePath,
      expectedSnapshotId,
      manifest.snapshot_id,
    );
  }
  if (manifest.source_id !== expectedSourceId) {
    pushIdentityMismatch(
      diagnostics,
      relativePath,
      expectedSourceId,
      manifest.source_id,
    );
  }

  let contentPath: string;
  try {
    contentPath = safeJoin(snapshotDirectory, manifest.content_path);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        ValidationSeverity.Error,
        DiagnosticCode.MissingSnapshotContent,
        relativePath,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return;
  }

  if (!(await pathExists(contentPath))) {
    diagnostics.push(
      diagnostic(
        ValidationSeverity.Error,
        DiagnosticCode.MissingSnapshotContent,
        relativePath,
        `Snapshot 内容不存在：${manifest.content_path}`,
      ),
    );
    return;
  }

  const content = await readFile(contentPath);
  const actualChecksum = sha256(content);
  const actualSnapshotId = createSnapshotId(content);
  if (
    manifest.content_sha256 !== actualChecksum ||
    manifest.snapshot_id !== actualSnapshotId
  ) {
    diagnostics.push(
      diagnostic(
        ValidationSeverity.Error,
        DiagnosticCode.SnapshotChecksumMismatch,
        relativePath,
        "Snapshot 内容已不再匹配不可变 manifest",
      ),
    );
  }
}

/** 校验 latest.yaml 是否仍指向同一 Source 下真实存在的 Snapshot。 */
async function validateLatestPointer(
  root: string,
  latestPath: string,
  latest: LatestSnapshotPointer,
  diagnostics: ValidationDiagnostic[],
): Promise<void> {
  const relativePath = path.relative(root, latestPath);
  const sourceDirectory = path.dirname(latestPath);
  const expectedSourceId = path.basename(sourceDirectory);
  if (latest.source_id !== expectedSourceId) {
    pushIdentityMismatch(
      diagnostics,
      relativePath,
      expectedSourceId,
      latest.source_id,
    );
  }

  const manifestPath = safeJoin(
    sourceDirectory,
    DirectoryName.Snapshots,
    latest.snapshot_id,
    VaultFileName.SnapshotManifest,
  );
  if (!(await pathExists(manifestPath))) {
    diagnostics.push(
      diagnostic(
        ValidationSeverity.Error,
        DiagnosticCode.InvalidLatestPointer,
        relativePath,
        `latest 指针引用了不存在的 Snapshot：${latest.snapshot_id}`,
      ),
    );
  }
}

/** 将 Markdown 链接解析为本地目标；外部链接不参与文件存在性检查。 */
function resolveMarkdownLink(
  wikiRoot: string,
  sourceFile: string,
  rawTarget: string,
): string | undefined {
  const withoutTitle = rawTarget.trim().split(/\s+/u)[0];
  if (!withoutTitle) {
    return undefined;
  }

  const withoutAnchor = withoutTitle.split("#", 1)[0];
  if (
    !withoutAnchor ||
    withoutAnchor.startsWith("http://") ||
    withoutAnchor.startsWith("https://") ||
    withoutAnchor.startsWith("mailto:")
  ) {
    return undefined;
  }

  const decoded = decodeURIComponent(withoutAnchor);
  if (decoded.startsWith("/")) {
    return safeJoin(wikiRoot, decoded.slice(1));
  }
  return path.resolve(path.dirname(sourceFile), decoded);
}

/** 校验 OKF concept frontmatter 与 Wiki 内部链接。 */
async function validateWiki(
  root: string,
  validators: Validators,
  diagnostics: ValidationDiagnostic[],
): Promise<void> {
  const wikiRoot = safeJoin(root, DirectoryName.Wiki);
  const markdownFiles = (await walkFiles(wikiRoot)).filter(
    (filePath) => path.extname(filePath).toLowerCase() === ".md",
  );
  const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/gu;

  for (const filePath of markdownFiles) {
    const relativePath = path.relative(root, filePath);
    const content = await readFile(filePath, TEXT_ENCODING);
    const isReserved = RESERVED_WIKI_FILES.has(path.basename(filePath));

    if (!isReserved) {
      try {
        const frontmatter = parseFrontmatter(content);
        if (!frontmatter) {
          diagnostics.push(
            diagnostic(
              ValidationSeverity.Error,
              DiagnosticCode.MissingFrontmatter,
              relativePath,
              "OKF Concept 文档必须包含 YAML frontmatter",
            ),
          );
        } else if (!validators.concept(frontmatter.attributes)) {
          diagnostics.push(
            diagnostic(
              ValidationSeverity.Error,
              DiagnosticCode.InvalidConcept,
              relativePath,
              formatAjvErrors(validators.concept.errors),
            ),
          );
        }
      } catch (error) {
        diagnostics.push(
          diagnostic(
            ValidationSeverity.Error,
            DiagnosticCode.InvalidFrontmatter,
            relativePath,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }

    for (const match of content.matchAll(markdownLinkPattern)) {
      const rawTarget = match[1];
      if (!rawTarget) {
        continue;
      }

      try {
        const resolvedTarget = resolveMarkdownLink(wikiRoot, filePath, rawTarget);
        if (resolvedTarget && !(await pathExists(resolvedTarget))) {
          diagnostics.push(
            diagnostic(
              ValidationSeverity.Warning,
              DiagnosticCode.BrokenLink,
              relativePath,
              `Markdown 链接目标不存在：${rawTarget}`,
            ),
          );
        }
      } catch (error) {
        diagnostics.push(
          diagnostic(
            ValidationSeverity.Warning,
            DiagnosticCode.BrokenLink,
            relativePath,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
  }
}

/** 校验 Source、Snapshot、latest 元数据及 Raw 内容完整性。 */
async function validateSources(
  root: string,
  validators: Validators,
  diagnostics: ValidationDiagnostic[],
): Promise<void> {
  const sourcesRoot = safeJoin(root, DirectoryName.Raw, DirectoryName.Sources);
  const files = await walkFiles(sourcesRoot);

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    if (
      fileName !== VaultFileName.SourceMetadata &&
      fileName !== VaultFileName.SnapshotManifest &&
      fileName !== VaultFileName.LatestSnapshot
    ) {
      continue;
    }

    const relativePath = path.relative(root, filePath);
    try {
      const parsed = parseYaml(await readFile(filePath, TEXT_ENCODING)) as unknown;
      const validator =
        fileName === VaultFileName.SourceMetadata
          ? validators.source
          : fileName === VaultFileName.SnapshotManifest
            ? validators.snapshot
            : validators.latest;
      if (!validator(parsed)) {
        diagnostics.push(
          diagnostic(
            ValidationSeverity.Error,
            fileName === VaultFileName.SourceMetadata
              ? DiagnosticCode.InvalidSource
              : fileName === VaultFileName.SnapshotManifest
                ? DiagnosticCode.InvalidSnapshot
                : DiagnosticCode.InvalidLatestPointer,
            relativePath,
            formatAjvErrors(validator.errors),
          ),
        );
        continue;
      }

      if (fileName === VaultFileName.SourceMetadata) {
        const source = parsed as SourceMetadata;
        const expectedSourceId = path.basename(path.dirname(filePath));
        if (source.source_id !== expectedSourceId) {
          pushIdentityMismatch(
            diagnostics,
            relativePath,
            expectedSourceId,
            source.source_id,
          );
        }
      } else if (fileName === VaultFileName.SnapshotManifest) {
        await validateSnapshotIntegrity(
          root,
          filePath,
          parsed as SnapshotManifest,
          diagnostics,
        );
      } else {
        await validateLatestPointer(
          root,
          filePath,
          parsed as LatestSnapshotPointer,
          diagnostics,
        );
      }
    } catch (error) {
      diagnostics.push(
        diagnostic(
          ValidationSeverity.Error,
          DiagnosticCode.InvalidYaml,
          relativePath,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
}

/**
 * 执行完整 Vault 校验。
 * Error 会令 valid=false；Warning 只提示可维护性问题，不阻止使用。
 */
export async function validateVault(root: string): Promise<ValidationReport> {
  const diagnostics: ValidationDiagnostic[] = [];
  const requiredPaths = [
    VaultFileName.Config,
    DirectoryName.Raw,
    `${DirectoryName.Raw}/${DirectoryName.Sources}`,
    DirectoryName.Wiki,
    `${DirectoryName.Wiki}/${VaultFileName.Index}`,
    `${DirectoryName.Wiki}/${VaultFileName.Log}`,
    DirectoryName.Schema,
    `${DirectoryName.Schema}/${VaultFileName.Profile}`,
    `${DirectoryName.Schema}/${VaultFileName.ConceptSchema}`,
    `${DirectoryName.Schema}/${VaultFileName.SourceSchema}`,
    `${DirectoryName.Schema}/${VaultFileName.ChangeSetSchema}`,
  ];

  for (const relativePath of requiredPaths) {
    if (!(await pathExists(safeJoin(root, relativePath)))) {
      diagnostics.push(
        diagnostic(
          ValidationSeverity.Error,
          DiagnosticCode.MissingPath,
          relativePath,
          "缺少 Lore 必需路径",
        ),
      );
    }
  }

  let validators: Validators | undefined;
  if (diagnostics.length === 0) {
    try {
      validators = await createValidators(root);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          ValidationSeverity.Error,
          DiagnosticCode.InvalidJsonSchema,
          DirectoryName.Schema,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  if (validators) {
    await validateWiki(root, validators, diagnostics);
    await validateSources(root, validators, diagnostics);
  }

  diagnostics.sort((left, right) => {
    const pathComparison = left.path.localeCompare(right.path);
    return pathComparison !== 0
      ? pathComparison
      : left.code.localeCompare(right.code);
  });

  const errors = diagnostics.filter(
    (item) => item.severity === ValidationSeverity.Error,
  ).length;
  const warnings = diagnostics.filter(
    (item) => item.severity === ValidationSeverity.Warning,
  ).length;

  return {
    valid: errors === 0,
    errors,
    warnings,
    diagnostics,
  };
}
