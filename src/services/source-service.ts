import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LORE_VERSION,
  SCHEMA_VERSION,
} from "../domain/constants.js";
import {
  DirectoryName,
  ErrorCode,
  ExitCode,
  MediaType,
  SourceKind,
  SourceStatus,
  SyncPolicy,
  VaultFileName,
} from "../domain/enums.js";
import type {
  AddSourceResult,
  LatestSnapshotPointer,
  SnapshotManifest,
  SourceMetadata,
} from "../domain/models.js";
import { LoreError } from "../errors.js";
import {
  atomicWriteFile,
  canonicalFilePath,
  ensureDirectory,
  pathExists,
  safeJoin,
} from "../infrastructure/filesystem.js";
import {
  createSnapshotId,
  createSourceId,
  sha256,
} from "../infrastructure/hash.js";
import {
  readYamlFile,
  writeYamlFile,
} from "../infrastructure/serialization.js";

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

/** `source add` 的可选参数；now 仅用于测试和可复现任务。 */
export interface AddSourceOptions {
  kind?: SourceKind;
  title?: string;
  now?: Date;
}

/** 编译阶段读取的不可变 Snapshot 及其文本内容。 */
export interface SourceSnapshot {
  source: SourceMetadata;
  snapshot: SnapshotManifest;
  content: Buffer;
}

/** 保留原始扩展名，避免 Snapshot 内容与声明的媒体类型不一致。 */
function contentFileName(sourcePath: string): string {
  const extension = path.extname(sourcePath).toLowerCase();
  return extension.length > 0 ? `content${extension}` : "content.bin";
}

/** 根据扩展名推断媒体类型，无法识别时按二进制处理。 */
function mediaTypeForPath(sourcePath: string): MediaType {
  const extension = path.extname(sourcePath).toLowerCase();
  return MEDIA_TYPE_BY_EXTENSION[extension] ?? MediaType.Binary;
}

/**
 * 采集来源并生成不可变 Snapshot。
 *
 * Source ID 只依赖来源身份；Snapshot ID 只依赖内容。重复采集同一内容不会
 * 创建新快照，内容变化则会在同一 Source 下追加 Snapshot。
 */
export async function addSource(
  root: string,
  input: string,
  options: AddSourceOptions = {},
): Promise<AddSourceResult> {
  const kind = options.kind ?? SourceKind.File;
  if (kind !== SourceKind.File) {
    throw new LoreError(
      ErrorCode.UnsupportedSourceKind,
      `暂未实现 '${kind}' 类型的来源采集器`,
      ExitCode.InvalidArgument,
    );
  }

  const sourcePath = await canonicalFilePath(input);
  const canonicalUri = pathToFileURL(sourcePath).toString();
  const content = await readFile(sourcePath);
  const sourceId = createSourceId(kind, canonicalUri);
  const snapshotId = createSnapshotId(content);
  const capturedAt = (options.now ?? new Date()).toISOString();
  const sourceDirectory = safeJoin(
    root,
    DirectoryName.Raw,
    DirectoryName.Sources,
    sourceId,
  );
  const snapshotsDirectory = safeJoin(sourceDirectory, DirectoryName.Snapshots);
  const snapshotDirectory = safeJoin(snapshotsDirectory, snapshotId);
  const sourceMetadataPath = safeJoin(sourceDirectory, VaultFileName.SourceMetadata);
  const snapshotManifestPath = safeJoin(
    snapshotDirectory,
    VaultFileName.SnapshotManifest,
  );
  const contentPath = contentFileName(sourcePath);

  await ensureDirectory(snapshotDirectory);

  const source: SourceMetadata = {
    version: SCHEMA_VERSION,
    source_id: sourceId,
    kind,
    canonical_uri: canonicalUri,
    title: options.title ?? path.basename(sourcePath),
    status: SourceStatus.Active,
    sync_policy: SyncPolicy.Manual,
    created_at: capturedAt,
  };

  let sourceCreated = false;
  if (await pathExists(sourceMetadataPath)) {
    const existingSource = await readYamlFile<SourceMetadata>(sourceMetadataPath);
    if (
      existingSource.source_id !== sourceId ||
      existingSource.canonical_uri !== canonicalUri
    ) {
      throw new LoreError(
        ErrorCode.Conflict,
        `来源身份与已有元数据冲突：${sourceMetadataPath}`,
        ExitCode.Conflict,
      );
    }
    Object.assign(source, existingSource);
  } else {
    await writeYamlFile(sourceMetadataPath, source);
    sourceCreated = true;
  }

  const snapshot: SnapshotManifest = {
    version: SCHEMA_VERSION,
    snapshot_id: snapshotId,
    source_id: sourceId,
    captured_at: capturedAt,
    media_type: mediaTypeForPath(sourcePath),
    content_path: contentPath,
    content_sha256: sha256(content),
    collector: `lore-file@${LORE_VERSION}`,
  };

  let snapshotCreated = false;
  if (!(await pathExists(snapshotManifestPath))) {
    await atomicWriteFile(safeJoin(snapshotDirectory, contentPath), content);
    await writeYamlFile(snapshotManifestPath, snapshot);
    snapshotCreated = true;
  } else {
    Object.assign(
      snapshot,
      await readYamlFile<SnapshotManifest>(snapshotManifestPath),
    );
  }

  const latest: LatestSnapshotPointer = {
    version: SCHEMA_VERSION,
    source_id: sourceId,
    snapshot_id: snapshotId,
    updated_at: capturedAt,
  };
  await writeYamlFile(safeJoin(sourceDirectory, VaultFileName.LatestSnapshot), latest);

  return {
    source,
    snapshot,
    source_created: sourceCreated,
    snapshot_created: snapshotCreated,
  };
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

/**
 * 按稳定 Source ID 重新采集来源。
 * 当前仅支持 file:// 来源；未来的 Adapter 也必须保持相同的身份语义。
 */
export async function syncSource(
  root: string,
  sourceId: string,
  now: Date = new Date(),
): Promise<AddSourceResult> {
  const { source } = await showSource(root, sourceId);
  if (source.kind !== SourceKind.File) {
    throw new LoreError(
      ErrorCode.UnsupportedSourceKind,
      `暂未实现 '${source.kind}' 类型的来源同步`,
      ExitCode.InvalidArgument,
    );
  }
  if (source.status !== SourceStatus.Active) {
    throw new LoreError(
      ErrorCode.Conflict,
      `不能同步非 active 状态的来源：${sourceId}`,
      ExitCode.Conflict,
    );
  }

  return addSource(root, fileURLToPath(source.canonical_uri), {
    kind: source.kind,
    title: source.title,
    now,
  });
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

/**
 * 读取指定 Snapshot；未传 snapshotId 时读取 latest 指针。
 * 调用方仍需根据 media_type 判断是否支持对应内容格式。
 */
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
  const manifestPath = safeJoin(
    snapshotDirectory,
    VaultFileName.SnapshotManifest,
  );

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
