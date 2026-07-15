import path from "node:path";
import { ISO_DATE_LENGTH, SCHEMA_VERSION } from "../domain/constants.js";
import {
  DirectoryName,
  ErrorCode,
  ExitCode,
  VaultFileName,
} from "../domain/enums.js";
import { LoreError } from "../errors.js";
import type { VaultConfig } from "../domain/models.js";
import {
  ensureDirectory,
  pathExists,
  safeJoin,
  writeFileIfAbsent,
} from "../infrastructure/filesystem.js";
import {
  serializeYaml,
  readYamlFile,
  writeJsonFile,
} from "../infrastructure/serialization.js";
import {
  createAgentInstructions,
  createChangeSetSchema,
  createConceptSchema,
  createProfile,
  createMigrationHistory,
  createSourceSchema,
  createVaultConfig,
  createWikiIndex,
  createWikiLog,
  GIT_IGNORE_TEMPLATE,
  LORE_IGNORE_TEMPLATE,
} from "../templates/vault.js";
import { createDefaultCapturePolicy } from "./capture-policy-service.js";

export interface InitializeVaultResult {
  root: string;
  resumed: boolean;
  created_files: string[];
  existing_files: string[];
}

/**
 * 初始化一个新的 Lore Vault。
 *
 * 只创建缺失文件；同版本 Vault 可重复执行，以便 Agent 在中断后继续引导。
 */
export async function initializeVault(
  targetPath: string,
): Promise<InitializeVaultResult> {
  const root = path.resolve(targetPath);
  await ensureDirectory(root);

  const configPath = safeJoin(root, VaultFileName.Config);
  const resumed = await pathExists(configPath);
  if (resumed) {
    const config = await readYamlFile<VaultConfig>(configPath).catch(() => undefined);
    if (!config || typeof config.version !== "number") {
      throw new LoreError(
        ErrorCode.ValidationFailed,
        `已有 Vault 配置无法读取：${configPath}`,
        ExitCode.ValidationFailed,
      );
    }
    if (config.version !== SCHEMA_VERSION) {
      throw new LoreError(
        config.version < SCHEMA_VERSION
          ? ErrorCode.MigrationRequired
          : ErrorCode.UnsupportedVaultVersion,
        `已有 Vault 版本为 ${config.version}，当前 CLI 版本要求 ${SCHEMA_VERSION}`,
        ExitCode.Conflict,
      );
    }
  }

  const directories = [
    [DirectoryName.Raw],
    [DirectoryName.Raw, DirectoryName.Sources],
    [DirectoryName.Wiki],
    [DirectoryName.Wiki, DirectoryName.Pages],
    [DirectoryName.Schema],
    [DirectoryName.Runtime],
    [DirectoryName.Runtime, DirectoryName.Runs],
    [DirectoryName.Runtime, DirectoryName.Staging],
    [DirectoryName.Runtime, DirectoryName.Migrations],
    [DirectoryName.Runtime, DirectoryName.Usage],
    [DirectoryName.Runtime, DirectoryName.Usage, DirectoryName.Queries],
    [DirectoryName.Runtime, DirectoryName.Inbox],
  ];

  for (const segments of directories) {
    await ensureDirectory(safeJoin(root, ...segments));
  }

  const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH);
  const files: Array<[string, string]> = [
    [VaultFileName.Config, serializeYaml(createVaultConfig(path.basename(root)))],
    [VaultFileName.GitIgnore, GIT_IGNORE_TEMPLATE],
    [VaultFileName.LoreIgnore, LORE_IGNORE_TEMPLATE],
    [
      `${DirectoryName.Wiki}/${VaultFileName.Index}`,
      createWikiIndex(),
    ],
    [`${DirectoryName.Wiki}/${VaultFileName.Log}`, createWikiLog(date)],
    [
      `${DirectoryName.Schema}/${VaultFileName.Profile}`,
      serializeYaml(createProfile()),
    ],
    [
      `${DirectoryName.Schema}/${VaultFileName.AgentInstructions}`,
      createAgentInstructions(),
    ],
    [
      `${DirectoryName.Schema}/${VaultFileName.MigrationHistory}`,
      serializeYaml(createMigrationHistory()),
    ],
    [
      `${DirectoryName.Schema}/${VaultFileName.CapturePolicy}`,
      serializeYaml(createDefaultCapturePolicy()),
    ],
  ];

  const createdFiles: string[] = [];
  const existingFiles: string[] = [];

  for (const [relativePath, content] of files) {
    const wasCreated = await writeFileIfAbsent(safeJoin(root, relativePath), content);
    (wasCreated ? createdFiles : existingFiles).push(relativePath);
  }

  const schemaFiles: Array<[string, Record<string, unknown>]> = [
    [VaultFileName.ConceptSchema, createConceptSchema()],
    [VaultFileName.SourceSchema, createSourceSchema()],
    [VaultFileName.ChangeSetSchema, createChangeSetSchema()],
  ];

  for (const [fileName, schema] of schemaFiles) {
    const relativePath = `${DirectoryName.Schema}/${fileName}`;
    const targetFile = safeJoin(root, relativePath);
    if (await pathExists(targetFile)) {
      existingFiles.push(relativePath);
    } else {
      await writeJsonFile(targetFile, schema);
      createdFiles.push(relativePath);
    }
  }

  return {
    root,
    resumed,
    created_files: createdFiles.sort(),
    existing_files: existingFiles.sort(),
  };
}
