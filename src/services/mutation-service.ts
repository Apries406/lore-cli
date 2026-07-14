import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { SCHEMA_VERSION, TEXT_ENCODING } from "../domain/constants.js";
import {
  DirectoryName,
  ErrorCode,
  ExitCode,
  MutationOperation,
  TransactionStatus,
  VaultFileName,
} from "../domain/enums.js";
import type {
  MutationLockMetadata,
  RecoveryReport,
  TransactionJournal,
} from "../domain/mutation-models.js";
import { LoreError } from "../errors.js";
import {
  atomicWriteFile,
  ensureDirectory,
  pathExists,
  safeJoin,
} from "../infrastructure/filesystem.js";
import { readYamlFile, writeYamlFile } from "../infrastructure/serialization.js";
import { walkFiles } from "../infrastructure/walk.js";

export interface MutationLockHandle {
  metadata: MutationLockMetadata;
  release: () => Promise<void>;
}

interface TransactionScanResult {
  pending: Array<{ journal: TransactionJournal; path: string }>;
  corrupt: string[];
}

const MUTATION_OPERATIONS = new Set<string>(Object.values(MutationOperation));
const TRANSACTION_STATUSES = new Set<string>(Object.values(TransactionStatus));

/** 仅接受结构完整的对象，避免把可解析但字段缺失的 YAML 当成有效日志。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 对恢复日志执行运行时契约校验，并验证所有路径仍在 Vault 内。 */
function assertTransactionJournal(
  root: string,
  value: unknown,
): asserts value is TransactionJournal {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    typeof value.transaction_id !== "string" ||
    value.transaction_id.length === 0 ||
    typeof value.operation !== "string" ||
    !MUTATION_OPERATIONS.has(value.operation) ||
    typeof value.subject !== "string" ||
    typeof value.status !== "string" ||
    !TRANSACTION_STATUSES.has(value.status) ||
    typeof value.backup_root !== "string" ||
    !Array.isArray(value.changed_files) ||
    !value.changed_files.every((item) => typeof item === "string") ||
    typeof value.created_at !== "string" ||
    typeof value.updated_at !== "string"
  ) {
    throw new Error("事务日志结构无效");
  }
  safeJoin(root, value.backup_root);
  for (const relativePath of value.changed_files) {
    safeJoin(root, relativePath);
  }
}

/** 判断 PID 是否仍存在；EPERM 表示存在但当前用户无权发信号。 */
function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读取统一写锁；文件损坏时仍作为需要恢复处理。 */
async function readMutationLock(root: string): Promise<MutationLockMetadata | undefined> {
  const lockPath = safeJoin(root, DirectoryName.Runtime, VaultFileName.MutationLock);
  if (!(await pathExists(lockPath))) {
    return undefined;
  }
  try {
    const lock = await readYamlFile<unknown>(lockPath);
    if (
      !isRecord(lock) ||
      typeof lock.version !== "number" ||
      typeof lock.pid !== "number" ||
      !Number.isInteger(lock.pid) ||
      typeof lock.operation !== "string" ||
      !MUTATION_OPERATIONS.has(lock.operation) ||
      typeof lock.subject !== "string" ||
      typeof lock.created_at !== "string"
    ) {
      throw new Error("写锁结构无效");
    }
    return lock as unknown as MutationLockMetadata;
  } catch {
    return {
      version: SCHEMA_VERSION,
      pid: -1,
      operation: MutationOperation.CompileApply,
      subject: "unknown",
      created_at: new Date(0).toISOString(),
    };
  }
}

/** 获取所有写操作共用的原子锁。遇到死亡持有者时要求显式恢复。 */
export async function acquireMutationLock(
  root: string,
  operation: MutationOperation,
  subject: string,
  now: Date = new Date(),
): Promise<MutationLockHandle> {
  const lockPath = safeJoin(root, DirectoryName.Runtime, VaultFileName.MutationLock);
  await ensureDirectory(path.dirname(lockPath));
  let fileHandle;
  try {
    fileHandle = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existing = await readMutationLock(root);
    if (existing && processIsAlive(existing.pid)) {
      throw new LoreError(
        ErrorCode.MutationLockHeld,
        `Vault 写锁由进程 ${existing.pid} 持有（${existing.operation}/${existing.subject}）`,
        ExitCode.Conflict,
        existing,
      );
    }
    throw new LoreError(
      ErrorCode.RecoveryRequired,
      "检测到上次进程留下的写锁；请先执行 lore recover status 和 lore recover apply",
      ExitCode.Conflict,
      existing,
    );
  }
  const metadata: MutationLockMetadata = {
    version: SCHEMA_VERSION,
    pid: process.pid,
    operation,
    subject,
    created_at: now.toISOString(),
  };
  try {
    await fileHandle.writeFile(
      `${JSON.stringify(metadata, null, 2)}\n`,
      TEXT_ENCODING,
    );
    await fileHandle.close();
    const transactions = await scanTransactionJournals(root);
    if (transactions.pending.length > 0 || transactions.corrupt.length > 0) {
      await rm(lockPath, { force: true });
      throw new LoreError(
        ErrorCode.RecoveryRequired,
        "检测到未恢复或损坏的事务日志；请先执行 lore recover status 和 lore recover apply",
        ExitCode.Conflict,
        {
          pending_transactions: transactions.pending.map(({ journal }) =>
            journal.transaction_id
          ),
          corrupt_journals: transactions.corrupt,
        },
      );
    }
  } catch (error) {
    await fileHandle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
  let released = false;
  return {
    metadata,
    release: async () => {
      if (!released) {
        released = true;
        await rm(lockPath, { force: true });
      }
    },
  };
}

/** 在备份完成后、第一项持久写入前创建事务日志。 */
export async function prepareTransaction(
  journalPath: string,
  journal: Omit<TransactionJournal, "version" | "status" | "created_at" | "updated_at">,
  now: Date = new Date(),
): Promise<TransactionJournal> {
  const prepared: TransactionJournal = {
    version: SCHEMA_VERSION,
    ...journal,
    status: TransactionStatus.Prepared,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  await writeYamlFile(journalPath, prepared);
  return prepared;
}

/** 标记事务已完整提交或已恢复。 */
export async function updateTransactionStatus(
  journalPath: string,
  status: TransactionStatus.Committed | TransactionStatus.Recovered,
  now: Date = new Date(),
): Promise<TransactionJournal> {
  const journal = await readYamlFile<TransactionJournal>(journalPath);
  const updated = { ...journal, status, updated_at: now.toISOString() };
  await writeYamlFile(journalPath, updated);
  return updated;
}

/** 扫描所有未提交或已损坏的事务日志，并保留日志路径。 */
async function scanTransactionJournals(root: string): Promise<TransactionScanResult> {
  const runtimeRoot = safeJoin(root, DirectoryName.Runtime);
  const pending: TransactionScanResult["pending"] = [];
  const corrupt: string[] = [];
  for (const filePath of await walkFiles(runtimeRoot)) {
    if (path.basename(filePath) !== VaultFileName.TransactionJournal) {
      continue;
    }
    try {
      const journal = await readYamlFile<unknown>(filePath);
      assertTransactionJournal(root, journal);
      if (journal.status === TransactionStatus.Prepared) {
        pending.push({ journal, path: filePath });
      }
    } catch {
      corrupt.push(path.relative(root, filePath));
    }
  }
  return {
    pending: pending.sort((left, right) =>
      left.journal.created_at.localeCompare(right.journal.created_at),
    ),
    corrupt: corrupt.sort(),
  };
}

/** 返回锁持有者和待恢复事务，但不修改任何文件。 */
export async function getRecoveryStatus(root: string): Promise<RecoveryReport> {
  const lock = await readMutationLock(root);
  const transactions = await scanTransactionJournals(root);
  return {
    ...(lock ? { lock } : {}),
    lock_owner_alive: lock ? processIsAlive(lock.pid) : false,
    pending_transactions: transactions.pending.map(({ journal }) => journal),
    corrupt_journals: transactions.corrupt,
    recovered_transactions: [],
  };
}

/** 按日志从备份恢复文件；备份不存在代表事务前目标不存在，应删除。 */
export async function restorePreparedTransaction(
  root: string,
  journal: TransactionJournal,
): Promise<void> {
  const backupRoot = safeJoin(root, journal.backup_root);
  for (const relativePath of journal.changed_files) {
    const backupPath = safeJoin(backupRoot, relativePath);
    const targetPath = safeJoin(root, relativePath);
    if (await pathExists(backupPath)) {
      await atomicWriteFile(targetPath, await readFile(backupPath));
    } else {
      await rm(targetPath, { force: true });
    }
  }
}

/** 恢复所有 Prepared 事务，并清理由死亡进程留下的统一写锁。 */
export async function recoverVault(
  root: string,
  now: Date = new Date(),
): Promise<RecoveryReport> {
  const status = await getRecoveryStatus(root);
  if (status.lock && status.lock_owner_alive) {
    throw new LoreError(
      ErrorCode.MutationLockHeld,
      `进程 ${status.lock.pid} 仍持有 Vault 写锁，不能恢复`,
      ExitCode.Conflict,
      status.lock,
    );
  }
  if (status.corrupt_journals.length > 0) {
    throw new LoreError(
      ErrorCode.RecoveryRequired,
      `存在无法安全恢复的损坏事务日志：${status.corrupt_journals.join("、")}`,
      ExitCode.Conflict,
      { corrupt_journals: status.corrupt_journals },
    );
  }
  const transactions = await scanTransactionJournals(root);
  const recovered: string[] = [];
  for (const { journal, path: journalPath } of transactions.pending) {
    await restorePreparedTransaction(root, journal);
    await updateTransactionStatus(journalPath, TransactionStatus.Recovered, now);
    recovered.push(journal.transaction_id);
  }
  await rm(safeJoin(root, DirectoryName.Runtime, VaultFileName.MutationLock), {
    force: true,
  });
  return {
    ...status,
    lock_owner_alive: false,
    pending_transactions: [],
    recovered_transactions: recovered,
  };
}
