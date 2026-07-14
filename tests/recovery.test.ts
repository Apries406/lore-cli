import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/domain/constants.js";
import {
  ErrorCode,
  MutationOperation,
  TransactionStatus,
  VaultFileName,
} from "../src/domain/enums.js";
import { LoreError } from "../src/errors.js";
import { pathExists } from "../src/infrastructure/filesystem.js";
import { writeYamlFile } from "../src/infrastructure/serialization.js";
import {
  acquireMutationLock,
  getRecoveryStatus,
  prepareTransaction,
  recoverVault,
} from "../src/services/mutation-service.js";
import { initializeVault } from "../src/services/vault-service.js";

describe("Vault 可恢复事务", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((targetPath) =>
        rm(targetPath, { recursive: true, force: true }),
      ),
    );
  });

  async function createVault(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "lore-recovery-"));
    temporaryRoots.push(root);
    await initializeVault(root);
    return root;
  }

  it("所有持久写操作共用同一个活进程锁", async () => {
    const root = await createVault();
    const lock = await acquireMutationLock(
      root,
      MutationOperation.CompileApply,
      "run_test",
    );
    try {
      await expect(
        acquireMutationLock(root, MutationOperation.Migration, "schema"),
      ).rejects.toMatchObject<Partial<LoreError>>({
        code: ErrorCode.MutationLockHeld,
      });
    } finally {
      await lock.release();
    }
  });

  it("死亡进程锁会阻止新写入，显式 recover 后解除", async () => {
    const root = await createVault();
    const lockPath = path.join(root, ".lore", VaultFileName.MutationLock);
    await writeYamlFile(lockPath, {
      version: SCHEMA_VERSION,
      pid: 999_999_999,
      operation: MutationOperation.CompileApply,
      subject: "crashed-run",
      created_at: "2026-07-14T14:00:00.000Z",
    });

    await expect(
      acquireMutationLock(root, MutationOperation.Migration, "schema"),
    ).rejects.toMatchObject<Partial<LoreError>>({
      code: ErrorCode.RecoveryRequired,
    });
    const recovered = await recoverVault(root);

    expect(recovered.recovered_transactions).toEqual([]);
    expect(await pathExists(lockPath)).toBe(false);
  });

  it("从 Prepared 事务备份恢复半写文件并保留恢复记录", async () => {
    const root = await createVault();
    const targetRelativePath = "wiki/log.md";
    const targetPath = path.join(root, targetRelativePath);
    const original = await readFile(targetPath, "utf8");
    const backupRoot = path.join(root, ".lore", "recovery-test-backup");
    const backupPath = path.join(backupRoot, targetRelativePath);
    await mkdir(path.dirname(backupPath), { recursive: true });
    await writeFile(backupPath, original, "utf8");
    const journalPath = path.join(
      root,
      ".lore",
      "recovery-test",
      VaultFileName.TransactionJournal,
    );
    await prepareTransaction(
      journalPath,
      {
        transaction_id: "txn_recovery_test",
        operation: MutationOperation.CompileApply,
        subject: "test",
        backup_root: ".lore/recovery-test-backup",
        changed_files: [targetRelativePath],
      },
      new Date("2026-07-14T14:01:00.000Z"),
    );
    await writeFile(targetPath, "半写状态\n", "utf8");
    await writeYamlFile(path.join(root, ".lore", VaultFileName.MutationLock), {
      version: SCHEMA_VERSION,
      pid: 999_999_999,
      operation: MutationOperation.CompileApply,
      subject: "test",
      created_at: "2026-07-14T14:01:00.000Z",
    });

    const before = await getRecoveryStatus(root);
    expect(before.pending_transactions).toHaveLength(1);
    const recovered = await recoverVault(
      root,
      new Date("2026-07-14T14:02:00.000Z"),
    );

    expect(await readFile(targetPath, "utf8")).toBe(original);
    expect(recovered.recovered_transactions).toEqual(["txn_recovery_test"]);
    expect(recovered.pending_transactions).toEqual([]);
    expect(
      (await getRecoveryStatus(root)).pending_transactions,
    ).toEqual([]);
    expect(await readFile(journalPath, "utf8")).toContain(
      `status: ${TransactionStatus.Recovered}`,
    );
  });

  it("即使没有遗留锁，Prepared 日志也会阻止新的写操作", async () => {
    const root = await createVault();
    await prepareTransaction(
      path.join(root, ".lore", "pending-without-lock", VaultFileName.TransactionJournal),
      {
        transaction_id: "txn_pending_without_lock",
        operation: MutationOperation.SourceUpdate,
        subject: "source-test",
        backup_root: ".lore/pending-without-lock/backup",
        changed_files: [],
      },
    );

    await expect(
      acquireMutationLock(root, MutationOperation.Migration, "schema"),
    ).rejects.toMatchObject<Partial<LoreError>>({
      code: ErrorCode.RecoveryRequired,
    });
  });

  it("损坏事务日志不会被静默忽略或自动清除", async () => {
    const root = await createVault();
    const journalPath = path.join(
      root,
      ".lore",
      "corrupt-transaction",
      VaultFileName.TransactionJournal,
    );
    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, "status: [损坏", "utf8");

    const status = await getRecoveryStatus(root);
    expect(status.corrupt_journals).toEqual([
      `.lore/corrupt-transaction/${VaultFileName.TransactionJournal}`,
    ]);
    await expect(recoverVault(root)).rejects.toMatchObject<Partial<LoreError>>({
      code: ErrorCode.RecoveryRequired,
    });
  });
});
