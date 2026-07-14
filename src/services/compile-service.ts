import { randomUUID } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import addFormatsModule from "ajv-formats";
import {
  COMPILE_RUN_ID_PREFIX,
  DEFAULT_MAX_CANDIDATE_PAGES,
  DEFAULT_MAX_COMPILE_CHANGES,
  DEFAULT_MAX_NEW_PAGES,
  LINE_RANGE_LOCATOR_PATTERN,
  SCHEMA_VERSION,
  TEXT_ENCODING,
  WIKI_PAGE_PATH_PATTERN,
} from "../domain/constants.js";
import type {
  ChangeSet,
  CompilationRecord,
  CompilePacket,
  CompileRun,
  CompileValidationResult,
  EvidenceReference,
} from "../domain/compile-models.js";
import {
  ChangeAction,
  CompileRunStatus,
  DirectoryName,
  ErrorCode,
  ExitCode,
  KnowledgeOperation,
  MediaType,
  MergeStrategy,
  VaultFileName,
  WikiPageType,
} from "../domain/enums.js";
import { LoreError } from "../errors.js";
import {
  atomicWriteFile,
  ensureDirectory,
  pathExists,
  safeJoin,
} from "../infrastructure/filesystem.js";
import { sha256 } from "../infrastructure/hash.js";
import {
  readYamlFile,
  writeYamlFile,
} from "../infrastructure/serialization.js";
import { readSourceSnapshot } from "./source-service.js";
import { validateVault } from "./validation-service.js";
import {
  findCompileCandidates,
  getWikiRevision,
  readWikiPage,
  renderCompileLogEntry,
  renderConceptPage,
  renderWikiIndex,
  wikiPageExists,
} from "./wiki-service.js";

const applyFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;
const SUPPORTED_TEXT_MEDIA_TYPES = new Set<MediaType>([
  MediaType.Markdown,
  MediaType.PlainText,
  MediaType.Json,
  MediaType.Yaml,
  MediaType.Html,
  MediaType.Csv,
]);

export interface PrepareCompileOptions {
  snapshot_id?: string;
  recompile?: boolean;
  now?: Date;
}

export interface SubmitCompileResult {
  run: CompileRun;
  validation: CompileValidationResult;
  diff: string;
}

export interface ApplyCompileResult {
  run: CompileRun;
  record: CompilationRecord;
}

export interface EvidenceQuoteResult {
  source_id: string;
  snapshot_id: string;
  locator: string;
  quote: string;
  quote_sha256: string;
}

interface CompilePolicy {
  allowed_page_types: WikiPageType[];
  max_candidate_pages: number;
  max_changes: number;
  max_new_pages: number;
  require_evidence: boolean;
  require_review: boolean;
  upsert_first: boolean;
}

/** 只接受合法正整数，损坏或缺失的 Profile 值回退到内置安全默认值。 */
function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * 读取人可编辑的 profile.yaml，并将配置收敛为编译器可执行策略。
 * Profile 决定限额和知识类型；安全校验本身不能被关闭。
 */
async function readCompilePolicy(root: string): Promise<CompilePolicy> {
  const profile = await readYamlFile<Record<string, unknown>>(
    safeJoin(root, DirectoryName.Schema, VaultFileName.Profile),
  );
  const query =
    profile.query && typeof profile.query === "object" && !Array.isArray(profile.query)
      ? (profile.query as Record<string, unknown>)
      : {};
  const compile =
    profile.compile &&
    typeof profile.compile === "object" &&
    !Array.isArray(profile.compile)
      ? (profile.compile as Record<string, unknown>)
      : {};
  const merge =
    profile.merge && typeof profile.merge === "object" && !Array.isArray(profile.merge)
      ? (profile.merge as Record<string, unknown>)
      : {};
  const knownTypes = new Set<string>(Object.values(WikiPageType));
  const configuredTypes = Array.isArray(profile.page_types)
    ? profile.page_types.filter(
        (item): item is WikiPageType => typeof item === "string" && knownTypes.has(item),
      )
    : [];
  return {
    allowed_page_types:
      configuredTypes.length > 0 ? configuredTypes : Object.values(WikiPageType),
    max_candidate_pages: positiveInteger(
      query.max_candidate_pages,
      DEFAULT_MAX_CANDIDATE_PAGES,
    ),
    max_changes: positiveInteger(compile.max_changes, DEFAULT_MAX_COMPILE_CHANGES),
    max_new_pages: positiveInteger(compile.max_new_pages, DEFAULT_MAX_NEW_PAGES),
    require_evidence: compile.require_evidence !== false,
    require_review: compile.require_review !== false,
    upsert_first: merge.strategy === MergeStrategy.UpsertFirst,
  };
}

/** 返回一次编译任务的持久化目录。 */
function runDirectory(root: string, runId: string): string {
  return safeJoin(root, DirectoryName.Runtime, DirectoryName.Runs, runId);
}

/** 生成短而可辨识、同时具备足够随机性的 Run ID。 */
function createRunId(): string {
  return `${COMPILE_RUN_ID_PREFIX}${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** 读取任务；不存在时统一转换为稳定业务错误。 */
export async function getCompileRun(root: string, runId: string): Promise<CompileRun> {
  const targetPath = safeJoin(runDirectory(root, runId), VaultFileName.CompileRun);
  if (!(await pathExists(targetPath))) {
    throw new LoreError(
      ErrorCode.CompileRunNotFound,
      `未找到知识编译任务：${runId}`,
      ExitCode.NotFound,
    );
  }
  return readYamlFile<CompileRun>(targetPath);
}

/** 读取供 Skill 消费的不可变编译包。 */
export async function getCompilePacket(
  root: string,
  runId: string,
): Promise<CompilePacket> {
  await getCompileRun(root, runId);
  return readYamlFile<CompilePacket>(
    safeJoin(runDirectory(root, runId), VaultFileName.CompilePacket),
  );
}

/** 保存任务状态，并始终刷新 updated_at。 */
async function saveRun(
  root: string,
  run: CompileRun,
  status: CompileRunStatus,
  now: Date,
  message?: string,
): Promise<CompileRun> {
  const updated: CompileRun = {
    ...run,
    status,
    updated_at: now.toISOString(),
    ...(message ? { message } : {}),
  };
  await writeYamlFile(
    safeJoin(runDirectory(root, run.run_id), VaultFileName.CompileRun),
    updated,
  );
  return updated;
}

/** 判断某 Snapshot 是否已有生效编译记录，避免无意重复吸收。 */
async function hasAppliedCompilation(
  root: string,
  sourceId: string,
  snapshotId: string,
): Promise<boolean> {
  const compilationRoot = safeJoin(
    root,
    DirectoryName.Raw,
    DirectoryName.Sources,
    sourceId,
    DirectoryName.Compilations,
    snapshotId,
  );
  if (!(await pathExists(compilationRoot))) {
    return false;
  }
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(compilationRoot).catch(() => []);
  for (const entry of entries.filter((item) => item.endsWith(".yaml"))) {
    const record = await readYamlFile<CompilationRecord>(safeJoin(compilationRoot, entry));
    if (record.status === CompileRunStatus.Applied) {
      return true;
    }
  }
  return false;
}

/**
 * 创建 Raw → Wiki 编译包。
 * 此阶段只读取 Wiki 和 Snapshot，不会产生任何 Wiki 内容变更。
 */
export async function prepareCompile(
  root: string,
  sourceId: string,
  options: PrepareCompileOptions = {},
): Promise<{ run: CompileRun; packet: CompilePacket }> {
  const captured = await readSourceSnapshot(root, sourceId, options.snapshot_id);
  if (!SUPPORTED_TEXT_MEDIA_TYPES.has(captured.snapshot.media_type as MediaType)) {
    throw new LoreError(
      ErrorCode.UnsupportedSourceKind,
      `当前知识编译器不支持媒体类型：${captured.snapshot.media_type}`,
      ExitCode.InvalidArgument,
    );
  }
  if (
    options.recompile !== true &&
    (await hasAppliedCompilation(root, sourceId, captured.snapshot.snapshot_id))
  ) {
    throw new LoreError(
      ErrorCode.AlreadyCompiled,
      `Snapshot ${captured.snapshot.snapshot_id} 已被编译；如需重新编译请显式使用 --recompile`,
      ExitCode.Conflict,
    );
  }

  const now = options.now ?? new Date();
  const runId = createRunId();
  const baseRevision = await getWikiRevision(root);
  const content = captured.content.toString(TEXT_ENCODING);
  const policy = await readCompilePolicy(root);
  const run: CompileRun = {
    version: SCHEMA_VERSION,
    run_id: runId,
    operation: KnowledgeOperation.Compile,
    status: CompileRunStatus.Prepared,
    source_id: sourceId,
    snapshot_id: captured.snapshot.snapshot_id,
    base_revision: baseRevision,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  const packet: CompilePacket = {
    version: SCHEMA_VERSION,
    run_id: runId,
    operation: KnowledgeOperation.Compile,
    vault: {
      root,
      base_revision: baseRevision,
      schema_version: SCHEMA_VERSION,
    },
    input: {
      source: captured.source,
      snapshot: captured.snapshot,
      content,
    },
    candidates: await findCompileCandidates(
      root,
      sourceId,
      captured.source.title,
      content,
      policy.max_candidate_pages,
    ),
    policies: {
      ...policy,
    },
  };
  const directory = runDirectory(root, runId);
  await ensureDirectory(safeJoin(directory, DirectoryName.Staging));
  await ensureDirectory(safeJoin(directory, DirectoryName.Backup));
  await writeYamlFile(safeJoin(directory, VaultFileName.CompileRun), run);
  await writeYamlFile(safeJoin(directory, VaultFileName.CompilePacket), packet);
  return { run, packet };
}

/** 根据 line:start-end 定位并计算证据摘录哈希。 */
function evidenceQuote(content: string, locator: string): string {
  const match = new RegExp(LINE_RANGE_LOCATOR_PATTERN, "u").exec(locator);
  if (!match) {
    throw new Error(`证据定位器格式无效：${locator}`);
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (start > end || end > lines.length) {
    throw new Error(`证据定位器越界：${locator}，Snapshot 共 ${lines.length} 行`);
  }
  return lines.slice(start - 1, end).join("\n");
}

/** 根据 line:start-end 定位并计算证据摘录哈希。 */
export function evidenceQuoteSha256(content: string, locator: string): string {
  return sha256(evidenceQuote(content, locator));
}

/** 为 Skill 返回可核对的证据原文和 CLI 计算的摘要。 */
export async function getEvidenceQuote(
  root: string,
  runId: string,
  locator: string,
): Promise<EvidenceQuoteResult> {
  const packet = await getCompilePacket(root, runId);
  const quote = evidenceQuote(packet.input.content, locator);
  return {
    source_id: packet.input.source.source_id,
    snapshot_id: packet.input.snapshot.snapshot_id,
    locator,
    quote,
    quote_sha256: sha256(quote),
  };
}

/** 将 Ajv 错误转成稳定、紧凑的中文诊断。 */
function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(
    (error) => `${error.instancePath || "/"} 未通过 '${error.keyword}' 规则校验`,
  );
}

/** 使用 Vault 自带 Schema 校验 Change Set 的外部结构。 */
async function validateChangeSetSchema(root: string, value: unknown): Promise<string[]> {
  const schema = JSON.parse(
    await readFile(
      safeJoin(root, DirectoryName.Schema, VaultFileName.ChangeSetSchema),
      TEXT_ENCODING,
    ),
  ) as Record<string, unknown>;
  const ajv = new Ajv({ allErrors: true, strict: true });
  applyFormats(ajv);
  const validator = ajv.compile(schema);
  return validator(value) ? [] : formatSchemaErrors(validator.errors);
}

/** 校验证据确实指向当前不可变 Snapshot，而不是模型生成的伪引用。 */
function validateEvidence(
  evidence: EvidenceReference[] | undefined,
  packet: CompilePacket,
  errors: string[],
  targetPath: string,
): void {
  if (!evidence || evidence.length === 0) {
    errors.push(`${targetPath} 缺少 lore.evidence`);
    return;
  }
  const currentEvidence = evidence.filter(
    (item) =>
      item.source_id === packet.input.source.source_id &&
      item.snapshot_id === packet.input.snapshot.snapshot_id,
  );
  if (currentEvidence.length === 0) {
    errors.push(`${targetPath} 未引用本次输入 Snapshot`);
    return;
  }
  for (const item of currentEvidence) {
    try {
      const expected = evidenceQuoteSha256(packet.input.content, item.locator);
      if (item.quote_sha256 !== expected) {
        errors.push(`${targetPath} 的证据 ${item.id} 摘录哈希不匹配`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
}

/** 生成便于审阅的确定性统一 Diff。 */
function renderDiffFile(
  targetPath: string,
  oldContent: string,
  newContent: string,
): string {
  const oldLines = oldContent.length > 0 ? oldContent.trimEnd().split("\n") : [];
  const newLines = newContent.trimEnd().split("\n");
  return [
    `diff --lore a/${targetPath} b/${targetPath}`,
    `--- ${oldLines.length > 0 ? `a/${targetPath}` : "/dev/null"}`,
    `+++ b/${targetPath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

/**
 * 接收 Skill 生成的 Change Set，完成 Schema、Evidence、候选和并发语义校验，
 * 再将完整目标页面渲染到任务 staging。此阶段仍不会修改 Wiki。
 */
export async function submitChangeSet(
  root: string,
  runId: string,
  changeSet: ChangeSet,
  now: Date = new Date(),
): Promise<SubmitCompileResult> {
  let run = await getCompileRun(root, runId);
  if (![CompileRunStatus.Prepared, CompileRunStatus.NeedsInput].includes(run.status)) {
    throw new LoreError(
      ErrorCode.InvalidRunState,
      `任务 ${runId} 当前状态 ${run.status} 不接受 Change Set`,
      ExitCode.Conflict,
    );
  }
  const packet = await getCompilePacket(root, runId);
  const errors = await validateChangeSetSchema(root, changeSet);
  const warnings: string[] = [];
  const candidateByPath = new Map(packet.candidates.map((item) => [item.path, item]));
  const seenPaths = new Set<string>();
  let createCount = 0;

  if (changeSet.run_id !== runId) {
    errors.push(`run_id 必须为 ${runId}`);
  }
  if (changeSet.base_revision?.wiki_sha256 !== run.base_revision.wiki_sha256) {
    errors.push("base_revision 与 prepare 阶段不一致");
  }
  if (
    !changeSet.inputs?.some(
      (item) =>
        item.source_id === run.source_id && item.snapshot_id === run.snapshot_id,
    )
  ) {
    errors.push("inputs 未包含本次 Source/Snapshot");
  }
  if (changeSet.changes?.length > packet.policies.max_changes) {
    errors.push(`单次变更不能超过 ${packet.policies.max_changes} 页`);
  }

  const stagingRoot = safeJoin(runDirectory(root, runId), DirectoryName.Staging);
  await rm(stagingRoot, { recursive: true, force: true });
  await ensureDirectory(stagingRoot);
  const diffs: string[] = [];

  for (const change of changeSet.changes ?? []) {
    const targetPath = change.target.path;
    if (!new RegExp(WIKI_PAGE_PATH_PATTERN, "u").test(targetPath)) {
      errors.push(`目标路径不符合 Wiki 页面约束：${targetPath}`);
      continue;
    }
    if (seenPaths.has(targetPath)) {
      errors.push(`Change Set 包含重复目标：${targetPath}`);
      continue;
    }
    seenPaths.add(targetPath);
    if (!packet.policies.allowed_page_types.includes(change.concept.type)) {
      errors.push(`页面类型不在 Profile 允许范围内：${change.concept.type}`);
    }
    if (packet.policies.require_evidence) {
      validateEvidence(change.concept.lore?.evidence, packet, errors, targetPath);
    }

    let oldContent = "";
    let existingFrontmatter: Record<string, unknown> | undefined;
    if (change.action === ChangeAction.Create) {
      createCount += 1;
      if (await wikiPageExists(root, targetPath)) {
        errors.push(`create 目标已经存在：${targetPath}`);
      }
      if (change.target.expected_sha256) {
        errors.push(`create 目标不能声明 expected_sha256：${targetPath}`);
      }
    } else if (change.action === ChangeAction.Update) {
      const candidate = candidateByPath.get(targetPath);
      if (!candidate) {
        errors.push(`update 目标不在 prepare 候选集中：${targetPath}`);
        continue;
      }
      if (change.target.expected_sha256 !== candidate.content_sha256) {
        errors.push(`update 目标 expected_sha256 与候选版本不一致：${targetPath}`);
        continue;
      }
      const page = await readWikiPage(root, targetPath);
      if (page.content_sha256 !== change.target.expected_sha256) {
        errors.push(`update 目标已在 prepare 后变化：${targetPath}`);
        continue;
      }
      oldContent = page.content;
      existingFrontmatter = page.frontmatter;
    } else {
      errors.push(`暂不支持变更动作：${String(change.action)}`);
      continue;
    }

    const rendered = renderConceptPage(
      runId,
      targetPath,
      change.concept,
      existingFrontmatter,
      now.toISOString(),
    );
    await atomicWriteFile(safeJoin(stagingRoot, targetPath), rendered);
    diffs.push(renderDiffFile(targetPath, oldContent, rendered));
  }

  if (createCount > packet.policies.max_new_pages) {
    errors.push(`单次编译最多创建 ${packet.policies.max_new_pages} 个新页面`);
  }
  if (changeSet.questions && changeSet.questions.length > 0) {
    warnings.push("Change Set 包含待回答问题，不能进入 apply 阶段");
  }

  await writeYamlFile(
    safeJoin(runDirectory(root, runId), VaultFileName.CompileProposal),
    changeSet,
  );
  const validation: CompileValidationResult = {
    valid: errors.length === 0 && !(changeSet.questions?.length),
    errors,
    warnings,
  };
  await writeYamlFile(
    safeJoin(runDirectory(root, runId), VaultFileName.CompileValidation),
    validation,
  );
  const diff = diffs.join("\n");
  await atomicWriteFile(
    safeJoin(runDirectory(root, runId), VaultFileName.CompileDiff),
    diff,
  );

  if (changeSet.questions?.length) {
    run = await saveRun(
      root,
      run,
      CompileRunStatus.NeedsInput,
      now,
      "Change Set 包含待回答问题",
    );
  } else if (errors.length > 0) {
    run = await saveRun(
      root,
      run,
      CompileRunStatus.Rejected,
      now,
      `Change Set 校验失败：${errors.length} 个错误`,
    );
  } else {
    run = await saveRun(root, run, CompileRunStatus.Validated, now);
  }
  return { run, validation, diff };
}

/** 读取 submit 阶段生成的审阅 Diff。 */
export async function readCompileDiff(root: string, runId: string): Promise<string> {
  await getCompileRun(root, runId);
  const targetPath = safeJoin(runDirectory(root, runId), VaultFileName.CompileDiff);
  if (!(await pathExists(targetPath))) {
    throw new LoreError(
      ErrorCode.InvalidRunState,
      `任务 ${runId} 尚未生成 Diff`,
      ExitCode.Conflict,
    );
  }
  return readFile(targetPath, TEXT_ENCODING);
}

/** 获取独占应用锁，防止两个进程同时修改 Wiki。 */
async function withCompileLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lockPath = safeJoin(root, DirectoryName.Runtime, VaultFileName.CompileLock);
  let handle;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n`, TEXT_ENCODING);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LoreError(
        ErrorCode.CompileLockHeld,
        "另一个知识编译任务正在应用变更",
        ExitCode.Conflict,
      );
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

/** 将目标文件备份到任务目录；不存在的 create 目标无需创建空备份。 */
async function backupFile(
  root: string,
  runId: string,
  relativePath: string,
): Promise<void> {
  const sourcePath = safeJoin(root, relativePath);
  if (await pathExists(sourcePath)) {
    await atomicWriteFile(
      safeJoin(runDirectory(root, runId), DirectoryName.Backup, relativePath),
      await readFile(sourcePath),
    );
  }
}

/** 根据 proposal 和 backup 恢复应用前状态。 */
async function restoreBackup(
  root: string,
  runId: string,
  proposal: ChangeSet,
): Promise<void> {
  for (const change of proposal.changes) {
    const targetPath = safeJoin(root, change.target.path);
    const backupPath = safeJoin(
      runDirectory(root, runId),
      DirectoryName.Backup,
      change.target.path,
    );
    if (await pathExists(backupPath)) {
      await atomicWriteFile(targetPath, await readFile(backupPath));
    } else if (change.action === ChangeAction.Create) {
      await rm(targetPath, { force: true });
    }
  }
  for (const relativePath of [
    `${DirectoryName.Wiki}/${VaultFileName.Index}`,
    `${DirectoryName.Wiki}/${VaultFileName.Log}`,
  ]) {
    const backupPath = safeJoin(
      runDirectory(root, runId),
      DirectoryName.Backup,
      relativePath,
    );
    if (await pathExists(backupPath)) {
      await atomicWriteFile(safeJoin(root, relativePath), await readFile(backupPath));
    }
  }
}

/** 将编译记录写到 Raw Source sidecar，使 Snapshot 的吸收历史可查询。 */
async function writeCompilationRecord(
  root: string,
  record: CompilationRecord,
): Promise<void> {
  const directory = safeJoin(
    root,
    DirectoryName.Raw,
    DirectoryName.Sources,
    record.source_id,
    DirectoryName.Compilations,
    record.snapshot_id,
  );
  await ensureDirectory(directory);
  await writeYamlFile(safeJoin(directory, `${record.run_id}.yaml`), record);
}

/**
 * 在独占锁中事务应用已校验 Change Set。
 * 写入前重新检查 Wiki 基线，写入后执行全库校验；失败会自动恢复备份。
 */
export async function applyCompile(
  root: string,
  runId: string,
  now: Date = new Date(),
): Promise<ApplyCompileResult> {
  return withCompileLock(root, async () => {
    let run = await getCompileRun(root, runId);
    if (run.status !== CompileRunStatus.Validated) {
      throw new LoreError(
        ErrorCode.InvalidRunState,
        `任务 ${runId} 必须处于 validated 状态，当前为 ${run.status}`,
        ExitCode.Conflict,
      );
    }
    const proposal = await readYamlFile<ChangeSet>(
      safeJoin(runDirectory(root, runId), VaultFileName.CompileProposal),
    );
    const currentRevision = await getWikiRevision(root);
    if (currentRevision.wiki_sha256 !== run.base_revision.wiki_sha256) {
      run = await saveRun(
        root,
        run,
        CompileRunStatus.Conflict,
        now,
        "Wiki 已在 prepare 后变化，请重新 prepare",
      );
      throw new LoreError(
        ErrorCode.Conflict,
        run.message ?? "Wiki 基线冲突",
        ExitCode.Conflict,
      );
    }

    const indexPath = `${DirectoryName.Wiki}/${VaultFileName.Index}`;
    const logPath = `${DirectoryName.Wiki}/${VaultFileName.Log}`;
    for (const relativePath of [
      ...proposal.changes.map((item) => item.target.path),
      indexPath,
      logPath,
    ]) {
      await backupFile(root, runId, relativePath);
    }

    let mutated = false;
    try {
      for (const change of proposal.changes) {
        if (change.action === ChangeAction.Update) {
          const current = await readWikiPage(root, change.target.path);
          if (current.content_sha256 !== change.target.expected_sha256) {
            throw new LoreError(
              ErrorCode.Conflict,
              `应用前目标已变化：${change.target.path}`,
              ExitCode.Conflict,
            );
          }
        }
        const stagedPath = safeJoin(
          runDirectory(root, runId),
          DirectoryName.Staging,
          change.target.path,
        );
        await atomicWriteFile(safeJoin(root, change.target.path), await readFile(stagedPath));
        mutated = true;
      }
      await atomicWriteFile(safeJoin(root, indexPath), await renderWikiIndex(root));
      const existingLog = await readFile(safeJoin(root, logPath), TEXT_ENCODING);
      await atomicWriteFile(
        safeJoin(root, logPath),
        `${existingLog.trimEnd()}${renderCompileLogEntry(
          runId,
          now.toISOString(),
          proposal.summary,
          proposal.changes.map((item) => item.target.path),
        )}`,
      );

      const validation = await validateVault(root);
      if (!validation.valid) {
        throw new LoreError(
          ErrorCode.ValidationFailed,
          `应用后的知识库校验失败：${validation.errors} 个错误`,
          ExitCode.ValidationFailed,
          validation,
        );
      }
      const appliedRevision = await getWikiRevision(root);
      const record: CompilationRecord = {
        version: SCHEMA_VERSION,
        run_id: runId,
        status: CompileRunStatus.Applied,
        source_id: run.source_id,
        snapshot_id: run.snapshot_id,
        applied_at: now.toISOString(),
        wiki_revision_before: run.base_revision.wiki_sha256,
        wiki_revision_after: appliedRevision.wiki_sha256,
        changes: await Promise.all(
          proposal.changes.map(async (change) => ({
            action: change.action,
            path: change.target.path,
            content_sha256: sha256(await readFile(safeJoin(root, change.target.path))),
          })),
        ),
      };
      run = {
        ...(await saveRun(root, run, CompileRunStatus.Applied, now)),
        applied_revision: appliedRevision,
      };
      await writeYamlFile(
        safeJoin(runDirectory(root, runId), VaultFileName.CompileRun),
        run,
      );
      await writeCompilationRecord(root, record);
      return { run, record };
    } catch (error) {
      if (mutated) {
        await restoreBackup(root, runId, proposal);
      }
      const status =
        error instanceof LoreError && error.code === ErrorCode.Conflict
          ? CompileRunStatus.Conflict
          : CompileRunStatus.Failed;
      await saveRun(
        root,
        run,
        status,
        now,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  });
}

/**
 * 回滚一次已应用编译。只有页面仍保持该任务写入的哈希时才允许回滚，
 * 避免覆盖任务之后的人为编辑或其他编译结果。
 */
export async function rollbackCompile(
  root: string,
  runId: string,
  now: Date = new Date(),
): Promise<ApplyCompileResult> {
  return withCompileLock(root, async () => {
    let run = await getCompileRun(root, runId);
    if (run.status !== CompileRunStatus.Applied) {
      throw new LoreError(
        ErrorCode.InvalidRunState,
        `只有 applied 状态的任务可以回滚，当前为 ${run.status}`,
        ExitCode.Conflict,
      );
    }
    const proposal = await readYamlFile<ChangeSet>(
      safeJoin(runDirectory(root, runId), VaultFileName.CompileProposal),
    );
    const recordPath = safeJoin(
      root,
      DirectoryName.Raw,
      DirectoryName.Sources,
      run.source_id,
      DirectoryName.Compilations,
      run.snapshot_id,
      `${runId}.yaml`,
    );
    const record = await readYamlFile<CompilationRecord>(recordPath);
    const currentRevision = await getWikiRevision(root);
    if (currentRevision.wiki_sha256 !== record.wiki_revision_after) {
      throw new LoreError(
        ErrorCode.Conflict,
        "Wiki 在该任务应用后又发生了变化，不能自动回滚",
        ExitCode.Conflict,
      );
    }
    for (const change of record.changes) {
      if (!(await pathExists(safeJoin(root, change.path)))) {
        throw new LoreError(
          ErrorCode.Conflict,
          `回滚目标已经不存在：${change.path}`,
          ExitCode.Conflict,
        );
      }
      const currentHash = sha256(await readFile(safeJoin(root, change.path)));
      if (currentHash !== change.content_sha256) {
        throw new LoreError(
          ErrorCode.Conflict,
          `回滚目标在应用后又被修改：${change.path}`,
          ExitCode.Conflict,
        );
      }
    }

    await restoreBackup(root, runId, proposal);
    const validation = await validateVault(root);
    if (!validation.valid) {
      throw new LoreError(
        ErrorCode.ValidationFailed,
        `回滚后的知识库校验失败：${validation.errors} 个错误`,
        ExitCode.ValidationFailed,
        validation,
      );
    }
    const rolledBackRecord: CompilationRecord = {
      ...record,
      status: CompileRunStatus.RolledBack,
    };
    await writeCompilationRecord(root, rolledBackRecord);
    run = await saveRun(root, run, CompileRunStatus.RolledBack, now);
    return { run, record: rolledBackRecord };
  });
}
