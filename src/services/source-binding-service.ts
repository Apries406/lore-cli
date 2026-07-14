import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  DirectoryName,
  ErrorCode,
  ExitCode,
  MutationOperation,
  SourceKind,
  VaultFileName,
} from "../domain/enums.js";
import type { SourceMetadata } from "../domain/models.js";
import { LoreError } from "../errors.js";
import { pathExists, safeJoin } from "../infrastructure/filesystem.js";
import { readYamlFile, writeYamlFile } from "../infrastructure/serialization.js";
import { acquireMutationLock } from "./mutation-service.js";

export interface SourceBinding {
  source_id: string;
  input: string;
  bound_at: string;
}

interface SourceBindingStore {
  version: number;
  bindings: Record<string, SourceBinding>;
}

const SOURCE_BINDING_STORE_VERSION = 1;

const BINDABLE_SOURCE_KINDS = new Set<SourceKind>([
  SourceKind.File,
  SourceKind.Directory,
  SourceKind.GitRepository,
  SourceKind.GitDiff,
]);

function bindingStorePath(root: string): string {
  return safeJoin(root, DirectoryName.Runtime, VaultFileName.DeviceBindings);
}

async function readBindingStore(root: string): Promise<SourceBindingStore> {
  const targetPath = bindingStorePath(root);
  if (!(await pathExists(targetPath))) {
    return { version: SOURCE_BINDING_STORE_VERSION, bindings: {} };
  }
  const store = await readYamlFile<SourceBindingStore>(targetPath);
  if (
    store.version !== SOURCE_BINDING_STORE_VERSION ||
    !store.bindings ||
    typeof store.bindings !== "object" ||
    Array.isArray(store.bindings) ||
    !Object.entries(store.bindings).every(
      ([sourceId, binding]) =>
        binding &&
        typeof binding === "object" &&
        binding.source_id === sourceId &&
        typeof binding.input === "string" &&
        binding.input.length > 0 &&
        typeof binding.bound_at === "string",
    )
  ) {
    throw new LoreError(
      ErrorCode.ValidationFailed,
      `设备绑定文件损坏：${targetPath}`,
      ExitCode.ValidationFailed,
    );
  }
  return store;
}

async function readSourceMetadata(
  root: string,
  sourceId: string,
): Promise<SourceMetadata> {
  const targetPath = safeJoin(
    root,
    DirectoryName.Raw,
    DirectoryName.Sources,
    sourceId,
    VaultFileName.SourceMetadata,
  );
  if (!(await pathExists(targetPath))) {
    throw new LoreError(
      ErrorCode.SourceNotFound,
      `未找到来源：${sourceId}`,
      ExitCode.NotFound,
    );
  }
  return readYamlFile<SourceMetadata>(targetPath);
}

/** 返回当前设备为 Source 配置的本地采集路径。 */
export async function getSourceBinding(
  root: string,
  sourceId: string,
): Promise<SourceBinding | undefined> {
  return (await readBindingStore(root)).bindings[sourceId];
}

/** 列出仅保存在 `.lore/` 中、不会随 Git 同步的设备路径映射。 */
export async function listSourceBindings(root: string): Promise<SourceBinding[]> {
  return Object.values((await readBindingStore(root)).bindings).sort((left, right) =>
    left.source_id.localeCompare(right.source_id),
  );
}

/** 将可迁移的 Source 身份绑定到当前设备上的真实文件或目录。 */
export async function bindSource(
  root: string,
  sourceId: string,
  input: string,
  now: Date = new Date(),
): Promise<SourceBinding> {
  const source = await readSourceMetadata(root, sourceId);
  if (!BINDABLE_SOURCE_KINDS.has(source.kind)) {
    throw new LoreError(
      ErrorCode.InvalidArgument,
      `${source.kind} 来源不需要设备路径绑定`,
      ExitCode.InvalidArgument,
    );
  }
  const resolved = path.resolve(input);
  const metadata = await stat(resolved).catch(() => undefined);
  const expectsFile = source.kind === SourceKind.File;
  if (!metadata || (expectsFile ? !metadata.isFile() : !metadata.isDirectory())) {
    throw new LoreError(
      ErrorCode.SourceNotFound,
      `绑定路径不存在或类型不匹配：${resolved}`,
      ExitCode.NotFound,
    );
  }
  const binding: SourceBinding = {
    source_id: sourceId,
    input: await realpath(resolved),
    bound_at: now.toISOString(),
  };
  const lock = await acquireMutationLock(
    root,
    MutationOperation.SourceUpdate,
    `bind:${sourceId}`,
    now,
  );
  try {
    const store = await readBindingStore(root);
    store.bindings[sourceId] = binding;
    await writeYamlFile(bindingStorePath(root), store);
    return binding;
  } finally {
    await lock.release();
  }
}
