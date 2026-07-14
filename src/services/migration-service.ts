import { randomUUID } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  MIGRATION_ID_PREFIX,
  SCHEMA_VERSION,
  TEXT_ENCODING,
} from "../domain/constants.js";
import type { EvidenceReference } from "../domain/compile-models.js";
import type {
  MigrationAction,
  MigrationHistory,
  MigrationPlan,
  MigrationRecord,
  MigrationResult,
} from "../domain/migration-models.js";
import {
  DirectoryName,
  ErrorCode,
  ExitCode,
  VaultFileName,
} from "../domain/enums.js";
import type { VaultConfig } from "../domain/models.js";
import { LoreError } from "../errors.js";
import {
  atomicWriteFile,
  ensureDirectory,
  pathExists,
  safeJoin,
} from "../infrastructure/filesystem.js";
import {
  readYamlFile,
  writeJsonFile,
  writeYamlFile,
} from "../infrastructure/serialization.js";
import {
  createChangeSetSchema,
  createConceptSchema,
  createMigrationHistory,
  createProfile,
  createSourceSchema,
} from "../templates/vault.js";
import { evidenceQuoteSha256 } from "./compile-service.js";
import { readSourceSnapshot } from "./source-service.js";
import { validateVault } from "./validation-service.js";
import {
  listWikiPages,
  renderRawWikiPage,
  type WikiPage,
} from "./wiki-service.js";

interface PageUpgrade {
  path: string;
  content: string;
}

/** 读取 Vault 根配置并验证版本字段是正整数。 */
async function readVaultConfig(root: string): Promise<VaultConfig> {
  const config = await readYamlFile<VaultConfig>(safeJoin(root, VaultFileName.Config));
  if (!Number.isInteger(config.version) || config.version < 1) {
    throw new LoreError(
      ErrorCode.UnsupportedVaultVersion,
      `Vault 版本无效：${String(config.version)}`,
      ExitCode.Conflict,
    );
  }
  return config;
}

/** 拒绝让当前 CLI 直接操作旧版或未来版本 Vault。 */
export async function assertVaultCompatible(root: string): Promise<void> {
  const config = await readVaultConfig(root);
  if (config.version < SCHEMA_VERSION) {
    throw new LoreError(
      ErrorCode.MigrationRequired,
      `Vault 版本 ${config.version} 低于 CLI 版本 ${SCHEMA_VERSION}；请先执行 lore migrate plan 和 lore migrate apply`,
      ExitCode.Conflict,
    );
  }
  if (config.version > SCHEMA_VERSION) {
    throw new LoreError(
      ErrorCode.UnsupportedVaultVersion,
      `Vault 版本 ${config.version} 高于当前 CLI 支持的 ${SCHEMA_VERSION}，请升级 Lore CLI`,
      ExitCode.Conflict,
    );
  }
}

/** 判断值是不是可递归合并的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 默认值补缺、用户值优先的深合并。数组作为完整策略值保留。 */
function mergeProfile(
  defaults: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(existing)) {
    merged[key] = isRecord(merged[key]) && isRecord(value)
      ? mergeProfile(merged[key] as Record<string, unknown>, value)
      : value;
  }
  merged.version = SCHEMA_VERSION;
  return merged;
}

/** 为旧页面补齐 v2 强制要求的 quote_sha256 与 schema_version。 */
async function upgradePage(root: string, page: WikiPage): Promise<PageUpgrade | undefined> {
  const loreValue = page.frontmatter.lore;
  if (!isRecord(loreValue)) {
    return undefined;
  }
  const evidenceValue = loreValue.evidence;
  let changed = loreValue.schema_version !== SCHEMA_VERSION;
  const upgradedLore: Record<string, unknown> = {
    ...loreValue,
    schema_version: SCHEMA_VERSION,
  };
  if (Array.isArray(evidenceValue)) {
    const upgradedEvidence: unknown[] = [];
    for (const rawItem of evidenceValue) {
      if (!isRecord(rawItem)) {
        upgradedEvidence.push(rawItem);
        continue;
      }
      const item = rawItem as unknown as EvidenceReference;
      if (typeof item.quote_sha256 === "string" && item.quote_sha256.length > 0) {
        upgradedEvidence.push(rawItem);
        continue;
      }
      if (
        typeof item.source_id !== "string" ||
        typeof item.snapshot_id !== "string" ||
        typeof item.locator !== "string"
      ) {
        throw new LoreError(
          ErrorCode.MigrationFailed,
          `无法升级 ${page.path} 中缺少身份字段的 Evidence`,
          ExitCode.ValidationFailed,
        );
      }
      const captured = await readSourceSnapshot(
        root,
        item.source_id,
        item.snapshot_id,
      );
      upgradedEvidence.push({
        ...rawItem,
        quote_sha256: evidenceQuoteSha256(
          captured.content.toString(TEXT_ENCODING),
          item.locator,
        ),
      });
      changed = true;
    }
    upgradedLore.evidence = upgradedEvidence;
  }
  if (!changed) {
    return undefined;
  }
  return {
    path: page.path,
    content: renderRawWikiPage(
      { ...page.frontmatter, lore: upgradedLore },
      page.body,
    ),
  };
}

/** 预演所有页面升级；无法补算 Evidence 时在写入前失败。 */
async function planPageUpgrades(root: string): Promise<PageUpgrade[]> {
  const upgrades: PageUpgrade[] = [];
  for (const page of await listWikiPages(root)) {
    const upgrade = await upgradePage(root, page);
    if (upgrade) {
      upgrades.push(upgrade);
    }
  }
  return upgrades;
}

/** 生成从当前版本到 CLI 版本的确定性迁移计划。 */
export async function getMigrationPlan(root: string): Promise<MigrationPlan> {
  const config = await readVaultConfig(root);
  if (config.version > SCHEMA_VERSION) {
    throw new LoreError(
      ErrorCode.UnsupportedVaultVersion,
      `Vault 版本 ${config.version} 高于当前 CLI 支持的 ${SCHEMA_VERSION}`,
      ExitCode.Conflict,
    );
  }
  if (config.version === SCHEMA_VERSION) {
    return {
      current_version: config.version,
      target_version: SCHEMA_VERSION,
      required: false,
      actions: [],
    };
  }
  if (config.version !== 1 || SCHEMA_VERSION !== 2) {
    throw new LoreError(
      ErrorCode.UnsupportedVaultVersion,
      `没有从 Vault v${config.version} 到 v${SCHEMA_VERSION} 的迁移路径`,
      ExitCode.Conflict,
    );
  }
  const pageUpgrades = await planPageUpgrades(root);
  const actions: MigrationAction[] = [
    { path: VaultFileName.Config, description: "升级 Vault 版本" },
    {
      path: `${DirectoryName.Schema}/${VaultFileName.Profile}`,
      description: "补齐查询、编译和审计策略默认值",
    },
    {
      path: `${DirectoryName.Schema}/${VaultFileName.ConceptSchema}`,
      description: "更新 Concept Schema",
    },
    {
      path: `${DirectoryName.Schema}/${VaultFileName.SourceSchema}`,
      description: "更新 Source Schema",
    },
    {
      path: `${DirectoryName.Schema}/${VaultFileName.ChangeSetSchema}`,
      description: "更新 Change Set Schema",
    },
    {
      path: `${DirectoryName.Schema}/${VaultFileName.MigrationHistory}`,
      description: "追加迁移历史",
    },
    ...pageUpgrades.map((item) => ({
      path: item.path,
      description: "补齐页面 schema_version 与 Evidence 摘录哈希",
    })),
  ];
  return {
    current_version: config.version,
    target_version: SCHEMA_VERSION,
    required: true,
    actions,
  };
}

/** 备份存在的文件，目录结构相对于 Vault 保持不变。 */
async function backupFiles(
  root: string,
  backupRoot: string,
  relativePaths: string[],
): Promise<void> {
  for (const relativePath of relativePaths) {
    const sourcePath = safeJoin(root, relativePath);
    if (await pathExists(sourcePath)) {
      await atomicWriteFile(
        safeJoin(backupRoot, relativePath),
        await readFile(sourcePath),
      );
    }
  }
}

/** 从迁移备份恢复，迁移前不存在的文件会被删除。 */
async function restoreFiles(
  root: string,
  backupRoot: string,
  relativePaths: string[],
): Promise<void> {
  for (const relativePath of relativePaths) {
    const backupPath = safeJoin(backupRoot, relativePath);
    if (await pathExists(backupPath)) {
      await atomicWriteFile(safeJoin(root, relativePath), await readFile(backupPath));
    } else {
      await rm(safeJoin(root, relativePath), { force: true });
    }
  }
}

/** 读取旧历史；v1 没有该文件时返回空历史。 */
async function readMigrationHistory(root: string): Promise<MigrationHistory> {
  const historyPath = safeJoin(
    root,
    DirectoryName.Schema,
    VaultFileName.MigrationHistory,
  );
  return (await pathExists(historyPath))
    ? readYamlFile<MigrationHistory>(historyPath)
    : createMigrationHistory();
}

/** 获取迁移独占锁，并同时拒绝正在 apply 的编译任务。 */
async function withMigrationLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const compileLock = safeJoin(root, DirectoryName.Runtime, VaultFileName.CompileLock);
  if (await pathExists(compileLock)) {
    throw new LoreError(
      ErrorCode.CompileLockHeld,
      "知识编译正在应用，不能同时迁移 Vault",
      ExitCode.Conflict,
    );
  }
  const lockPath = safeJoin(root, DirectoryName.Runtime, VaultFileName.MigrationLock);
  let handle;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n`, TEXT_ENCODING);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LoreError(
        ErrorCode.MigrationFailed,
        "另一个 Vault 迁移正在执行",
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

/** 事务应用 v1 → v2 迁移，失败时恢复所有被写入文件。 */
export async function applyMigration(
  root: string,
  now: Date = new Date(),
): Promise<MigrationResult> {
  return withMigrationLock(root, async () => {
    const plan = await getMigrationPlan(root);
    if (!plan.required) {
      return { plan };
    }
    const pageUpgrades = await planPageUpgrades(root);
    const migrationId = `${MIGRATION_ID_PREFIX}${now
      .toISOString()
      .replaceAll(/[^0-9]/gu, "")}_${randomUUID().slice(0, 8)}`;
    const backupRelativePath = `${DirectoryName.Runtime}/${DirectoryName.Migrations}/${migrationId}`;
    const backupRoot = safeJoin(root, backupRelativePath);
    await ensureDirectory(backupRoot);
    const changedFiles = [...new Set(plan.actions.map((item) => item.path))].sort();
    await backupFiles(root, backupRoot, changedFiles);

    try {
      const config = await readVaultConfig(root);
      await writeYamlFile(safeJoin(root, VaultFileName.Config), {
        ...config,
        version: SCHEMA_VERSION,
      });
      const profilePath = safeJoin(
        root,
        DirectoryName.Schema,
        VaultFileName.Profile,
      );
      const existingProfile = await readYamlFile<Record<string, unknown>>(profilePath);
      await writeYamlFile(profilePath, mergeProfile(createProfile(), existingProfile));
      await writeJsonFile(
        safeJoin(root, DirectoryName.Schema, VaultFileName.ConceptSchema),
        createConceptSchema(),
      );
      await writeJsonFile(
        safeJoin(root, DirectoryName.Schema, VaultFileName.SourceSchema),
        createSourceSchema(),
      );
      await writeJsonFile(
        safeJoin(root, DirectoryName.Schema, VaultFileName.ChangeSetSchema),
        createChangeSetSchema(),
      );
      for (const upgrade of pageUpgrades) {
        await atomicWriteFile(safeJoin(root, upgrade.path), upgrade.content);
      }
      const history = await readMigrationHistory(root);
      const record: MigrationRecord = {
        migration_id: migrationId,
        from_version: plan.current_version,
        to_version: plan.target_version,
        applied_at: now.toISOString(),
        backup_path: backupRelativePath,
        changed_files: changedFiles,
      };
      await writeYamlFile(
        safeJoin(root, DirectoryName.Schema, VaultFileName.MigrationHistory),
        {
          version: SCHEMA_VERSION,
          migrations: [...history.migrations, record],
        } satisfies MigrationHistory,
      );
      const validation = await validateVault(root);
      if (!validation.valid) {
        throw new LoreError(
          ErrorCode.MigrationFailed,
          `迁移后的 Vault 校验失败：${validation.errors} 个错误`,
          ExitCode.ValidationFailed,
          validation,
        );
      }
      return { plan, record };
    } catch (error) {
      await restoreFiles(root, backupRoot, changedFiles);
      if (error instanceof LoreError) {
        throw error;
      }
      throw new LoreError(
        ErrorCode.MigrationFailed,
        error instanceof Error ? error.message : String(error),
        ExitCode.ValidationFailed,
      );
    }
  });
}
