import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_GIT_DIFF_CONTEXT_LINES,
  DEFAULT_MAX_COLLECTED_FILE_BYTES,
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_MAX_SOURCE_FILES,
  DEFAULT_WEB_TIMEOUT_MILLISECONDS,
  LORE_VERSION,
  SCHEMA_VERSION,
  TEXT_ENCODING,
} from "../domain/constants.js";
import type { CompilationRecord, EvidenceReference } from "../domain/compile-models.js";
import {
  CompileRunStatus,
  DirectoryName,
  ErrorCode,
  ExitCode,
  MediaType,
  MutationOperation,
  SourceKind,
  SourceLifecycleAction,
  SensitiveContentKind,
  SourceStatus,
  SyncPolicy,
  TransactionStatus,
  VaultFileName,
} from "../domain/enums.js";
import type {
  AddSourceResult,
  LatestSnapshotPointer,
  SnapshotManifest,
  SourceHistory,
  SourceImpact,
  SourceMetadata,
} from "../domain/models.js";
import { LoreError } from "../errors.js";
import {
  atomicWriteFile,
  canonicalFilePath,
  assertPathWithinRoot,
  ensureDirectory,
  pathExists,
  safeJoin,
} from "../infrastructure/filesystem.js";
import { createSnapshotId, createSourceId, sha256 } from "../infrastructure/hash.js";
import { readYamlFile, writeYamlFile } from "../infrastructure/serialization.js";
import { walkFiles } from "../infrastructure/walk.js";
import { listWikiPages } from "./wiki-service.js";
import {
  acquireMutationLock,
  prepareTransaction,
  restorePreparedTransaction,
  updateTransactionStatus,
} from "./mutation-service.js";

const execFileAsync = promisify(execFile);

/** 当前版本可实际采集的来源类型；协议预留值不会出现在 CLI 选项中。 */
export const SUPPORTED_SOURCE_KINDS: readonly SourceKind[] = [
  SourceKind.File,
  SourceKind.Text,
  SourceKind.Directory,
  SourceKind.Web,
  SourceKind.LarkDocument,
  SourceKind.GitRepository,
  SourceKind.GitDiff,
];

const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, MediaType>> = {
  ".md": MediaType.Markdown,
  ".markdown": MediaType.Markdown,
  ".txt": MediaType.PlainText,
  ".json": MediaType.Json,
  ".yaml": MediaType.Yaml,
  ".yml": MediaType.Yaml,
  ".html": MediaType.Html,
  ".htm": MediaType.Html,
  ".csv": MediaType.Csv,
};

const COLLECTED_TEXT_EXTENSIONS = new Set([
  ...Object.keys(MEDIA_TYPE_BY_EXTENSION),
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".py",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".sh",
  ".zsh",
  ".toml",
  ".xml",
  ".css",
  ".scss",
  ".sql",
]);

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".lore",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

interface CollectedSource {
  kind: SourceKind;
  canonical_uri: string;
  title: string;
  content: Buffer;
  media_type: MediaType;
  extension: string;
  collector: string;
}

/**
 * 在统一写锁内执行来源事务。
 * 事务先备份所有既有目标并写 Prepared 日志；失败时恢复事务前状态。
 */
async function runSourceTransaction<T>(
  root: string,
  transactionId: string,
  subject: string,
  targetPaths: string[],
  action: () => Promise<T>,
): Promise<T> {
  const transactionRoot = safeJoin(
    root,
    DirectoryName.Runtime,
    DirectoryName.SourceTransactions,
    transactionId,
  );
  const backupRoot = safeJoin(transactionRoot, DirectoryName.Backup);
  const journalPath = safeJoin(transactionRoot, VaultFileName.TransactionJournal);
  const changedFiles = [...new Set(targetPaths.map((targetPath) => {
    assertPathWithinRoot(root, targetPath);
    return path.relative(root, targetPath);
  }))].sort();

  // 同一个内容寻址事务可重复执行；每次都必须从当前状态重新建立备份。
  await rm(transactionRoot, { recursive: true, force: true });
  await ensureDirectory(backupRoot);
  for (const relativePath of changedFiles) {
    const targetPath = safeJoin(root, relativePath);
    if (await pathExists(targetPath)) {
      await atomicWriteFile(
        safeJoin(backupRoot, relativePath),
        await readFile(targetPath),
      );
    }
  }
  const journal = await prepareTransaction(journalPath, {
    transaction_id: transactionId,
    operation: MutationOperation.SourceUpdate,
    subject,
    backup_root: path.relative(root, backupRoot),
    changed_files: changedFiles,
  });
  try {
    const result = await action();
    await updateTransactionStatus(journalPath, TransactionStatus.Committed);
    return result;
  } catch (error) {
    await restorePreparedTransaction(root, journal);
    await updateTransactionStatus(journalPath, TransactionStatus.Recovered);
    throw error;
  }
}

/** `source add` 的可选参数；now 仅用于测试和可复现任务。 */
export interface AddSourceOptions {
  kind?: SourceKind;
  title?: string;
  revision?: string;
  allow_sensitive?: boolean;
  now?: Date;
}

/** 编译与查询阶段读取的不可变 Snapshot 及其内容。 */
export interface SourceSnapshot {
  source: SourceMetadata;
  snapshot: SnapshotManifest;
  content: Buffer;
}

/** 根据扩展名推断媒体类型，无法识别时按二进制处理。 */
function mediaTypeForPath(sourcePath: string): MediaType {
  return MEDIA_TYPE_BY_EXTENSION[path.extname(sourcePath).toLowerCase()] ?? MediaType.Binary;
}

/** 防止单次采集意外吞入超出个人知识库规模的内容。 */
function assertSourceSize(content: Buffer, label: string): void {
  if (content.byteLength > DEFAULT_MAX_SOURCE_BYTES) {
    throw new LoreError(
      ErrorCode.InvalidArgument,
      `${label} 超过单次采集上限 ${DEFAULT_MAX_SOURCE_BYTES} 字节`,
      ExitCode.InvalidArgument,
    );
  }
}

/** 判断 Buffer 是否像文本；NUL 字节通常表示二进制内容。 */
function isProbablyText(content: Buffer): boolean {
  return !content.includes(0);
}

/** 只匹配高置信度凭证格式，避免用宽泛 `token=` 规则阻塞正常代码。 */
function detectSensitiveContent(content: Buffer): SensitiveContentKind[] {
  const text = content.toString(TEXT_ENCODING);
  const detected = new Set<SensitiveContentKind>();
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)) {
    detected.add(SensitiveContentKind.PrivateKey);
  }
  if (/\bAKIA[0-9A-Z]{16}\b/u.test(text)) {
    detected.add(SensitiveContentKind.AwsAccessKey);
  }
  if (/\bghp_[A-Za-z0-9]{36,}\b/u.test(text)) {
    detected.add(SensitiveContentKind.GithubToken);
  }
  if (/\bsk-[A-Za-z0-9_-]{32,}\b/u.test(text)) {
    detected.add(SensitiveContentKind.OpenAiKey);
  }
  return [...detected];
}

/** 获取真实目录路径，同时拒绝普通文件和不存在的路径。 */
async function canonicalDirectoryPath(input: string): Promise<string> {
  const resolved = path.resolve(input);
  const metadata = await stat(resolved).catch(() => undefined);
  if (!metadata?.isDirectory()) {
    throw new LoreError(
      ErrorCode.SourceNotFound,
      `来源目录不存在：${resolved}`,
      ExitCode.NotFound,
    );
  }
  return realpath(resolved);
}

/** 将 glob 的常用子集转换成正则；支持 `*`、`**`、`?` 与 `!` 否定。 */
function ignorePatternMatcher(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//u, "");
  const marker = "__DOUBLE_STAR__";
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", marker)
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll(marker, ".*");
  return normalized.includes("/")
    ? new RegExp(`^${escaped}$`, "u")
    : new RegExp(`(?:^|/)${escaped}$`, "u");
}

/** 读取 Vault 与来源目录的 ignore 规则。 */
async function readIgnorePatterns(root: string, sourceRoot: string): Promise<string[]> {
  const candidates = [
    safeJoin(root, VaultFileName.LoreIgnore),
    safeJoin(sourceRoot, VaultFileName.LoreIgnore),
  ];
  const patterns: string[] = [];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    const content = await readFile(candidate, TEXT_ENCODING);
    patterns.push(
      ...content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#")),
    );
  }
  return patterns;
}

/** 根据按顺序应用的 ignore/否定规则判断相对路径。 */
function isIgnored(relativePath: string, patterns: string[]): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  if (
    normalized
      .split("/")
      .some((segment) => DEFAULT_IGNORED_DIRECTORIES.has(segment))
  ) {
    return true;
  }
  let ignored = false;
  for (const rawPattern of patterns) {
    const negated = rawPattern.startsWith("!");
    const pattern = negated ? rawPattern.slice(1) : rawPattern;
    if (pattern.length > 0 && ignorePatternMatcher(pattern).test(normalized)) {
      ignored = !negated;
    }
  }
  return ignored;
}

/** 将一组文本文件渲染成稳定、可逐行引用的 Markdown Snapshot。 */
async function renderFilesAsMarkdown(
  collectionRoot: string,
  files: string[],
  heading: string,
  preamble: string[] = [],
): Promise<Buffer> {
  const sections = [`# ${heading}`, ...preamble];
  let totalBytes = Buffer.byteLength(sections.join("\n\n"), TEXT_ENCODING);
  let includedFiles = 0;
  for (const filePath of files) {
    if (includedFiles >= DEFAULT_MAX_SOURCE_FILES) {
      break;
    }
    const metadata = await stat(filePath).catch(() => undefined);
    if (!metadata?.isFile() || metadata.size > DEFAULT_MAX_COLLECTED_FILE_BYTES) {
      continue;
    }
    const content = await readFile(filePath);
    if (!isProbablyText(content)) {
      continue;
    }
    const relativePath = path.relative(collectionRoot, filePath).split(path.sep).join("/");
    const section = `## ${relativePath}\n\n\`\`\`\`text\n${content.toString(TEXT_ENCODING).trimEnd()}\n\`\`\`\``;
    const sectionBytes = Buffer.byteLength(section, TEXT_ENCODING);
    if (totalBytes + sectionBytes > DEFAULT_MAX_SOURCE_BYTES) {
      break;
    }
    sections.push(section);
    totalBytes += sectionBytes;
    includedFiles += 1;
  }
  return Buffer.from(`${sections.join("\n\n")}\n`, TEXT_ENCODING);
}

/** 采集单个本地文件。 */
async function collectFile(root: string, input: string): Promise<CollectedSource> {
  const sourcePath = await canonicalFilePath(input);
  const patterns = await readIgnorePatterns(root, path.dirname(sourcePath));
  if (isIgnored(path.basename(sourcePath), patterns)) {
    throw new LoreError(
      ErrorCode.IgnoredSource,
      `来源路径被 .loreignore 排除：${path.basename(sourcePath)}`,
      ExitCode.InvalidArgument,
    );
  }
  const content = await readFile(sourcePath);
  assertSourceSize(content, sourcePath);
  const extension = path.extname(sourcePath).toLowerCase() || ".bin";
  return {
    kind: SourceKind.File,
    canonical_uri: pathToFileURL(sourcePath).toString(),
    title: path.basename(sourcePath),
    content,
    media_type: mediaTypeForPath(sourcePath),
    extension,
    collector: `lore-file@${LORE_VERSION}`,
  };
}

/** 将直接文本采集成内容寻址的一次性 Source。 */
function collectText(input: string): CollectedSource {
  const content = Buffer.from(input, TEXT_ENCODING);
  assertSourceSize(content, "直接文本");
  const digest = sha256(content);
  return {
    kind: SourceKind.Text,
    canonical_uri: `lore+text://sha256/${digest}`,
    title: `直接文本 ${digest.slice(0, 12)}`,
    content,
    media_type: MediaType.PlainText,
    extension: ".txt",
    collector: `lore-text@${LORE_VERSION}`,
  };
}

/** 递归采集目录中的受支持文本文件，并执行 `.loreignore`。 */
async function collectDirectory(root: string, input: string): Promise<CollectedSource> {
  const sourceRoot = await canonicalDirectoryPath(input);
  const patterns = await readIgnorePatterns(root, sourceRoot);
  const files = (await walkFiles(sourceRoot)).filter((filePath) => {
    const relativePath = path.relative(sourceRoot, filePath);
    return (
      !isIgnored(relativePath, patterns) &&
      COLLECTED_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())
    );
  });
  const content = await renderFilesAsMarkdown(
    sourceRoot,
    files,
    `目录快照：${path.basename(sourceRoot)}`,
  );
  return {
    kind: SourceKind.Directory,
    canonical_uri: pathToFileURL(sourceRoot).toString(),
    title: path.basename(sourceRoot),
    content,
    media_type: MediaType.Markdown,
    extension: ".md",
    collector: `lore-directory@${LORE_VERSION}`,
  };
}

/** 采集 HTTP(S) 响应，保留服务端返回的原始文本内容。 */
async function collectWeb(input: string): Promise<CollectedSource> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new LoreError(
      ErrorCode.InvalidArgument,
      `Web 来源 URL 无效：${input}`,
      ExitCode.InvalidArgument,
    );
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new LoreError(
      ErrorCode.InvalidArgument,
      `Web 来源只允许 http/https：${url.protocol}`,
      ExitCode.InvalidArgument,
    );
  }
  url.hash = "";
  const response = await fetch(url, {
    headers: { "user-agent": `Lore/${LORE_VERSION}` },
    signal: AbortSignal.timeout(DEFAULT_WEB_TIMEOUT_MILLISECONDS),
  });
  if (!response.ok) {
    throw new LoreError(
      ErrorCode.SourceNotFound,
      `Web 来源请求失败：HTTP ${response.status}`,
      ExitCode.NotFound,
    );
  }
  const content = Buffer.from(await response.arrayBuffer());
  assertSourceSize(content, url.toString());
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const mediaType =
    contentType === MediaType.Html
      ? MediaType.Html
      : contentType === MediaType.Json
        ? MediaType.Json
        : MediaType.PlainText;
  const extension =
    mediaType === MediaType.Html ? ".html" : mediaType === MediaType.Json ? ".json" : ".txt";
  return {
    kind: SourceKind.Web,
    canonical_uri: url.toString(),
    title: `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`,
    content,
    media_type: mediaType,
    extension,
    collector: `lore-web@${LORE_VERSION}`,
  };
}

/** 执行只读 Git 命令，并统一输出上限。 */
async function executeGit(repository: string, arguments_: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", arguments_, {
      cwd: repository,
      maxBuffer: DEFAULT_MAX_SOURCE_BYTES,
      encoding: TEXT_ENCODING,
    });
    return result.stdout;
  } catch (error) {
    throw new LoreError(
      ErrorCode.InvalidArgument,
      error instanceof Error ? `Git 采集失败：${error.message}` : String(error),
      ExitCode.InvalidArgument,
    );
  }
}

/** 采集 Git HEAD 以及全部 tracked 文本文件。 */
async function collectGitRepository(
  root: string,
  input: string,
): Promise<CollectedSource> {
  const repository = await canonicalDirectoryPath(input);
  const topLevel = (await executeGit(repository, ["rev-parse", "--show-toplevel"])).trim();
  const canonicalRepository = await realpath(topLevel);
  const head = (await executeGit(canonicalRepository, ["rev-parse", "HEAD"])).trim();
  const trackedRelativePaths = (await executeGit(canonicalRepository, ["ls-files", "-z"]))
    .split("\0")
    .filter(Boolean);
  const patterns = await readIgnorePatterns(root, canonicalRepository);
  const tracked: string[] = [];
  for (const relativePath of trackedRelativePaths) {
    const filePath = path.resolve(canonicalRepository, relativePath);
    assertPathWithinRoot(canonicalRepository, filePath);
    const metadata = await lstat(filePath).catch(() => undefined);
    if (
      metadata?.isFile() &&
      !metadata.isSymbolicLink() &&
      !isIgnored(relativePath, patterns) &&
      COLLECTED_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())
    ) {
      tracked.push(filePath);
    }
  }
  const content = await renderFilesAsMarkdown(
    canonicalRepository,
    tracked,
    `Git 仓库快照：${path.basename(canonicalRepository)}`,
    [`- HEAD: \`${head}\``],
  );
  return {
    kind: SourceKind.GitRepository,
    canonical_uri: pathToFileURL(canonicalRepository).toString(),
    title: path.basename(canonicalRepository),
    content,
    media_type: MediaType.Markdown,
    extension: ".md",
    collector: `lore-git@${LORE_VERSION}`,
  };
}

/** 采集指定 base 到 HEAD 的文本 diff。 */
async function collectGitDiff(input: string, revision?: string): Promise<CollectedSource> {
  const repository = await canonicalDirectoryPath(input);
  const topLevel = (await executeGit(repository, ["rev-parse", "--show-toplevel"])).trim();
  const canonicalRepository = await realpath(topLevel);
  const base = revision?.trim() || "HEAD~1";
  const content = Buffer.from(
    await executeGit(canonicalRepository, [
      "diff",
      "--no-ext-diff",
      `--unified=${DEFAULT_GIT_DIFF_CONTEXT_LINES}`,
      `${base}..HEAD`,
      "--",
    ]),
    TEXT_ENCODING,
  );
  assertSourceSize(content, "Git diff");
  const canonicalUri = new URL("lore+git-diff://snapshot");
  canonicalUri.searchParams.set("repository", pathToFileURL(canonicalRepository).toString());
  canonicalUri.searchParams.set("base", base);
  return {
    kind: SourceKind.GitDiff,
    canonical_uri: canonicalUri.toString(),
    title: `${path.basename(canonicalRepository)}：${base}..HEAD`,
    content,
    media_type: MediaType.PlainText,
    extension: ".diff",
    collector: `lore-git-diff@${LORE_VERSION}`,
  };
}

/**
 * 通过用户已配置的 lark-cli 读取飞书文档 Markdown。
 * Lore 只消费稳定 JSON 信封，不接触或保存飞书认证信息。
 */
async function collectLarkDocument(input: string): Promise<CollectedSource> {
  const executable = process.env.LORE_LARK_CLI_BIN || "lark-cli";
  let stdout: string;
  try {
    const result = await execFileAsync(
      executable,
      [
        "docs",
        "+fetch",
        "--doc",
        input,
        "--as",
        "user",
        "--format",
        "json",
      ],
      {
        encoding: TEXT_ENCODING,
        maxBuffer: DEFAULT_MAX_SOURCE_BYTES,
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
      },
    );
    stdout = result.stdout;
  } catch (error) {
    const processError = error as Error & { stderr?: string };
    throw new LoreError(
      ErrorCode.SourceNotFound,
      `飞书文档读取失败：${processError.stderr || processError.message}`,
      ExitCode.NotFound,
    );
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new LoreError(
      ErrorCode.Conflict,
      "lark-cli 没有返回有效 JSON",
      ExitCode.Conflict,
    );
  }
  const data = envelope.data;
  const document =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).document
      : undefined;
  if (
    envelope.ok !== true ||
    !document ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    throw new LoreError(
      ErrorCode.SourceNotFound,
      "lark-cli 返回了失败或缺少 document 的信封",
      ExitCode.NotFound,
      envelope,
    );
  }
  const documentRecord = document as Record<string, unknown>;
  const documentId = documentRecord.document_id;
  const markdown = documentRecord.content;
  if (typeof documentId !== "string" || typeof markdown !== "string") {
    throw new LoreError(
      ErrorCode.Conflict,
      "飞书文档响应缺少 document_id 或 content",
      ExitCode.Conflict,
    );
  }
  const content = Buffer.from(markdown, TEXT_ENCODING);
  assertSourceSize(content, "飞书文档");
  const firstHeading = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^#{1,6}\s+/u.test(line));
  const xmlTitle = /<title(?:\s[^>]*)?>([^<]+)<\/title>/u.exec(markdown)?.[1];
  const revision = documentRecord.revision_id;
  return {
    kind: SourceKind.LarkDocument,
    canonical_uri: `lark+doc://document/${encodeURIComponent(documentId)}`,
    title:
      firstHeading?.replace(/^#{1,6}\s+/u, "") ||
      xmlTitle ||
      `飞书文档 ${documentId}`,
    content,
    media_type: MediaType.PlainText,
    extension: ".xml",
    collector: `lore-lark-doc@${LORE_VERSION}${
      typeof revision === "number" ? `+revision.${revision}` : ""
    }`,
  };
}

/** 根据稳定 SourceKind 路由到具体采集器。 */
async function collectInput(
  root: string,
  input: string,
  options: AddSourceOptions,
): Promise<CollectedSource> {
  const kind = options.kind ?? SourceKind.File;
  switch (kind) {
    case SourceKind.File:
      return collectFile(root, input);
    case SourceKind.Text:
      return collectText(input);
    case SourceKind.Directory:
      return collectDirectory(root, input);
    case SourceKind.Web:
      return collectWeb(input);
    case SourceKind.GitRepository:
      return collectGitRepository(root, input);
    case SourceKind.GitDiff:
      return collectGitDiff(input, options.revision);
    case SourceKind.LarkDocument:
      return collectLarkDocument(input);
    default:
      throw new LoreError(
        ErrorCode.UnsupportedSourceKind,
        `暂未实现 '${kind}' 类型的来源采集器`,
        ExitCode.InvalidArgument,
      );
  }
}

/** 将采集结果写入 append-only Raw Source/Snapshot 结构。 */
async function persistCollection(
  root: string,
  collected: CollectedSource,
  options: AddSourceOptions,
): Promise<AddSourceResult> {
  const sensitiveContent = detectSensitiveContent(collected.content);
  if (sensitiveContent.length > 0 && options.allow_sensitive !== true) {
    throw new LoreError(
      ErrorCode.SensitiveContentDetected,
      `采集内容疑似包含敏感凭证（${sensitiveContent.join("、")}）；确认安全后使用 --allow-sensitive`,
      ExitCode.InvalidArgument,
      { kinds: sensitiveContent },
    );
  }
  const sourceId = createSourceId(collected.kind, collected.canonical_uri);
  const snapshotId = createSnapshotId(collected.content);
  const capturedAt = (options.now ?? new Date()).toISOString();
  const sourceDirectory = safeJoin(
    root,
    DirectoryName.Raw,
    DirectoryName.Sources,
    sourceId,
  );
  const snapshotDirectory = safeJoin(
    sourceDirectory,
    DirectoryName.Snapshots,
    snapshotId,
  );
  const sourceMetadataPath = safeJoin(sourceDirectory, VaultFileName.SourceMetadata);
  const snapshotManifestPath = safeJoin(
    snapshotDirectory,
    VaultFileName.SnapshotManifest,
  );
  const contentPath = `content${collected.extension}`;
  const snapshotContentPath = safeJoin(snapshotDirectory, contentPath);
  const latestSnapshotPath = safeJoin(
    sourceDirectory,
    VaultFileName.LatestSnapshot,
  );

  let source: SourceMetadata = {
    version: SCHEMA_VERSION,
    source_id: sourceId,
    kind: collected.kind,
    canonical_uri: collected.canonical_uri,
    title: options.title ?? collected.title,
    status: SourceStatus.Active,
    sync_policy: SyncPolicy.Manual,
    created_at: capturedAt,
  };
  let sourceCreated = false;
  if (await pathExists(sourceMetadataPath)) {
    const existingSource = await readYamlFile<SourceMetadata>(sourceMetadataPath);
    if (
      existingSource.source_id !== sourceId ||
      existingSource.canonical_uri !== collected.canonical_uri ||
      existingSource.kind !== collected.kind
    ) {
      throw new LoreError(
        ErrorCode.Conflict,
        `来源身份与已有元数据冲突：${sourceMetadataPath}`,
        ExitCode.Conflict,
      );
    }
    source = existingSource;
  } else {
    sourceCreated = true;
  }

  let snapshot: SnapshotManifest = {
    version: SCHEMA_VERSION,
    snapshot_id: snapshotId,
    source_id: sourceId,
    captured_at: capturedAt,
    media_type: collected.media_type,
    content_path: contentPath,
    content_sha256: sha256(collected.content),
    collector: collected.collector,
  };
  let snapshotCreated = false;
  if (await pathExists(snapshotManifestPath)) {
    snapshot = await readYamlFile<SnapshotManifest>(snapshotManifestPath);
  } else {
    snapshotCreated = true;
  }
  const latest: LatestSnapshotPointer = {
    version: SCHEMA_VERSION,
    source_id: sourceId,
    snapshot_id: snapshotId,
    updated_at: capturedAt,
  };
  return runSourceTransaction(
    root,
    `source_${sourceId}_${snapshotId}`,
    sourceId,
    [
      sourceMetadataPath,
      snapshotContentPath,
      snapshotManifestPath,
      latestSnapshotPath,
    ],
    async () => {
      await ensureDirectory(snapshotDirectory);
      if (sourceCreated) {
        await writeYamlFile(sourceMetadataPath, source);
      }
      if (snapshotCreated) {
        await atomicWriteFile(snapshotContentPath, collected.content);
        await writeYamlFile(snapshotManifestPath, snapshot);
      }
      await writeYamlFile(latestSnapshotPath, latest);
      return {
        source,
        snapshot,
        source_created: sourceCreated,
        snapshot_created: snapshotCreated,
      };
    },
  );
}

/** 采集来源并生成不可变 Snapshot。 */
export async function addSource(
  root: string,
  input: string,
  options: AddSourceOptions = {},
): Promise<AddSourceResult> {
  // 网络、Git 与目录采集可能较慢；只在真正写入 Raw 时占用 Vault 锁。
  const collected = await collectInput(root, input, options);
  const lock = await acquireMutationLock(
    root,
    MutationOperation.SourceUpdate,
    `add:${options.kind ?? SourceKind.File}`,
  );
  try {
    return await persistCollection(root, collected, options);
  } finally {
    await lock.release();
  }
}

/** 读取 Vault 内的全部来源，并按稳定 ID 排序。 */
export async function listSources(root: string): Promise<SourceMetadata[]> {
  const sourcesRoot = safeJoin(root, DirectoryName.Raw, DirectoryName.Sources);
  const entries = await readdir(sourcesRoot, { withFileTypes: true }).catch(() => []);
  const sources: SourceMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const metadataPath = safeJoin(
      sourcesRoot,
      entry.name,
      VaultFileName.SourceMetadata,
    );
    if (await pathExists(metadataPath)) {
      sources.push(await readYamlFile<SourceMetadata>(metadataPath));
    }
  }
  return sources.sort((left, right) => left.source_id.localeCompare(right.source_id));
}

/** 读取来源元数据和 latest 指针。 */
export async function showSource(
  root: string,
  sourceId: string,
): Promise<{ source: SourceMetadata; latest: LatestSnapshotPointer }> {
  const sourceDirectory = safeJoin(
    root,
    DirectoryName.Raw,
    DirectoryName.Sources,
    sourceId,
  );
  const metadataPath = safeJoin(sourceDirectory, VaultFileName.SourceMetadata);
  const latestPath = safeJoin(sourceDirectory, VaultFileName.LatestSnapshot);
  if (!(await pathExists(metadataPath)) || !(await pathExists(latestPath))) {
    throw new LoreError(
      ErrorCode.SourceNotFound,
      `未找到来源：${sourceId}`,
      ExitCode.NotFound,
    );
  }
  return {
    source: await readYamlFile<SourceMetadata>(metadataPath),
    latest: await readYamlFile<LatestSnapshotPointer>(latestPath),
  };
}

/** 读取指定 Snapshot；未传 snapshotId 时读取 latest 指针。 */
export async function readSourceSnapshot(
  root: string,
  sourceId: string,
  snapshotId?: string,
): Promise<SourceSnapshot> {
  const { source, latest } = await showSource(root, sourceId);
  const selectedSnapshotId = snapshotId ?? latest.snapshot_id;
  const snapshotDirectory = safeJoin(
    root,
    DirectoryName.Raw,
    DirectoryName.Sources,
    sourceId,
    DirectoryName.Snapshots,
    selectedSnapshotId,
  );
  const manifestPath = safeJoin(snapshotDirectory, VaultFileName.SnapshotManifest);
  if (!(await pathExists(manifestPath))) {
    throw new LoreError(
      ErrorCode.SourceNotFound,
      `来源 ${sourceId} 不存在 Snapshot：${selectedSnapshotId}`,
      ExitCode.NotFound,
    );
  }
  const snapshot = await readYamlFile<SnapshotManifest>(manifestPath);
  if (snapshot.source_id !== sourceId || snapshot.snapshot_id !== selectedSnapshotId) {
    throw new LoreError(
      ErrorCode.Conflict,
      `Snapshot 元数据身份与路径不一致：${selectedSnapshotId}`,
      ExitCode.Conflict,
    );
  }
  const content = await readFile(safeJoin(snapshotDirectory, snapshot.content_path));
  if (sha256(content) !== snapshot.content_sha256) {
    throw new LoreError(
      ErrorCode.Conflict,
      `Snapshot 内容校验失败：${selectedSnapshotId}`,
      ExitCode.Conflict,
    );
  }
  return { source, snapshot, content };
}

/** 从 canonical URI 重建采集输入并生成新的 Snapshot。 */
export async function syncSource(
  root: string,
  sourceId: string,
  now: Date = new Date(),
  allowSensitive = false,
): Promise<AddSourceResult> {
  const initial = await showSource(root, sourceId);
  const source = initial.source;
  if (source.status !== SourceStatus.Active) {
    throw new LoreError(
      ErrorCode.Conflict,
      `不能同步非 active 状态的来源：${sourceId}`,
      ExitCode.Conflict,
    );
  }
  let input = source.canonical_uri;
  let revision: string | undefined;
  if (
    source.kind === SourceKind.File ||
    source.kind === SourceKind.Directory ||
    source.kind === SourceKind.GitRepository
  ) {
    input = fileURLToPath(source.canonical_uri);
  } else if (source.kind === SourceKind.GitDiff) {
    const canonical = new URL(source.canonical_uri);
    const repository = canonical.searchParams.get("repository");
    if (!repository) {
      throw new LoreError(
        ErrorCode.Conflict,
        `Git diff 来源缺少 repository：${sourceId}`,
        ExitCode.Conflict,
      );
    }
    input = fileURLToPath(repository);
    revision = canonical.searchParams.get("base") ?? undefined;
  } else if (source.kind === SourceKind.LarkDocument) {
    const canonical = new URL(source.canonical_uri);
    const documentId = canonical.pathname.split("/").filter(Boolean).at(-1);
    if (!documentId) {
      throw new LoreError(
        ErrorCode.Conflict,
        `飞书文档来源缺少 document_id：${sourceId}`,
        ExitCode.Conflict,
      );
    }
    input = decodeURIComponent(documentId);
  }
  const options: AddSourceOptions = {
    kind: source.kind,
    title: source.title,
    ...(revision ? { revision } : {}),
    allow_sensitive: allowSensitive,
    now,
  };
  let collected: CollectedSource;
  if (source.kind === SourceKind.Text) {
    const current = await readSourceSnapshot(root, sourceId);
    collected = {
      kind: source.kind,
      canonical_uri: source.canonical_uri,
      title: source.title,
      content: current.content,
      media_type: current.snapshot.media_type as MediaType,
      extension: path.extname(current.snapshot.content_path) || ".txt",
      collector: `lore-text@${LORE_VERSION}`,
    };
  } else {
    collected = await collectInput(root, input, options);
  }

  const lock = await acquireMutationLock(
    root,
    MutationOperation.SourceUpdate,
    `sync:${sourceId}`,
    now,
  );
  try {
    const current = await showSource(root, sourceId);
    if (
      current.source.status !== SourceStatus.Active ||
      current.source.canonical_uri !== source.canonical_uri ||
      current.latest.snapshot_id !== initial.latest.snapshot_id
    ) {
      throw new LoreError(
        ErrorCode.Conflict,
        `来源 ${sourceId} 在采集期间发生变化，请重试同步`,
        ExitCode.Conflict,
      );
    }
    return await persistCollection(root, collected, options);
  } finally {
    await lock.release();
  }
}

/** 逻辑删除或恢复 Source，不删除任何 Snapshot 与编译账本。 */
export async function updateSourceLifecycle(
  root: string,
  sourceId: string,
  action: SourceLifecycleAction,
): Promise<SourceMetadata> {
  const lock = await acquireMutationLock(
    root,
    MutationOperation.SourceUpdate,
    `${action}:${sourceId}`,
  );
  try {
    const { source } = await showSource(root, sourceId);
    const status =
      action === SourceLifecycleAction.Tombstone
        ? SourceStatus.Tombstoned
        : SourceStatus.Active;
    const updated = { ...source, status };
    const sourceMetadataPath = safeJoin(
      root,
      DirectoryName.Raw,
      DirectoryName.Sources,
      sourceId,
      VaultFileName.SourceMetadata,
    );
    return await runSourceTransaction(
      root,
      `source_${sourceId}_${action}`,
      sourceId,
      [sourceMetadataPath],
      async () => {
        await writeYamlFile(sourceMetadataPath, updated);
        return updated;
      },
    );
  } finally {
    await lock.release();
  }
}

/** 返回 Source 的全部 Snapshot 与编译历史。 */
export async function getSourceHistory(
  root: string,
  sourceId: string,
): Promise<SourceHistory> {
  const { source, latest } = await showSource(root, sourceId);
  const sourceRoot = safeJoin(
    root,
    DirectoryName.Raw,
    DirectoryName.Sources,
    sourceId,
  );
  const snapshots: SnapshotManifest[] = [];
  const compilations: CompilationRecord[] = [];
  for (const filePath of await walkFiles(sourceRoot)) {
    if (path.basename(filePath) === VaultFileName.SnapshotManifest) {
      snapshots.push(await readYamlFile<SnapshotManifest>(filePath));
    } else if (
      path.extname(filePath).toLowerCase() === ".yaml" &&
      filePath.includes(`${path.sep}${DirectoryName.Compilations}${path.sep}`)
    ) {
      compilations.push(await readYamlFile<CompilationRecord>(filePath));
    }
  }
  return {
    source,
    latest,
    snapshots: snapshots.sort((left, right) =>
      left.captured_at.localeCompare(right.captured_at),
    ),
    compilations: compilations.sort((left, right) =>
      left.applied_at.localeCompare(right.applied_at),
    ),
  };
}

/** 查询 Source 通过 Evidence 和编译账本影响了哪些 Wiki 页面。 */
export async function getSourceImpact(
  root: string,
  sourceId: string,
): Promise<SourceImpact> {
  const history = await getSourceHistory(root, sourceId);
  const wikiPages: SourceImpact["wiki_pages"] = [];
  for (const page of await listWikiPages(root)) {
    const lore =
      page.frontmatter.lore &&
      typeof page.frontmatter.lore === "object" &&
      !Array.isArray(page.frontmatter.lore)
        ? (page.frontmatter.lore as Record<string, unknown>)
        : {};
    const evidence = Array.isArray(lore.evidence)
      ? lore.evidence.filter(
          (item): item is EvidenceReference =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];
    const matching = evidence.filter((item) => item.source_id === sourceId);
    if (matching.length > 0) {
      wikiPages.push({
        path: page.path,
        evidence_ids: matching.map((item) => item.id).sort(),
      });
    }
  }
  return {
    source_id: sourceId,
    wiki_pages: wikiPages.sort((left, right) => left.path.localeCompare(right.path)),
    compilation_runs: history.compilations
      .filter((item) => item.status === CompileRunStatus.Applied)
      .map((item) => item.run_id)
      .sort(),
  };
}
