import path from "node:path";
import { ISO_DATE_LENGTH } from "../domain/constants.js";
import {
  DirectoryName,
  ErrorCode,
  ExitCode,
  VaultFileName,
} from "../domain/enums.js";
import { LoreError } from "../errors.js";
import {
  ensureDirectory,
  pathExists,
  safeJoin,
  writeFileIfAbsent,
} from "../infrastructure/filesystem.js";
import {
  serializeYaml,
  writeJsonFile,
} from "../infrastructure/serialization.js";
import {
  createAgentInstructions,
  createChangeSetSchema,
  createConceptSchema,
  createProfile,
  createSourceSchema,
  createVaultConfig,
  createWikiIndex,
  createWikiLog,
  GIT_IGNORE_TEMPLATE,
  LORE_IGNORE_TEMPLATE,
} from "../templates/vault.js";

export interface InitializeVaultResult {
  root: string;
  created_files: string[];
  existing_files: string[];
}

/**
 * 初始化一个新的 Lore Vault。
 *
 * 只创建缺失文件，且检测到已有 lore.yaml 时拒绝继续，避免误覆盖现有知识库。
 */
export async function initializeVault(
  targetPath: string,
): Promise<InitializeVaultResult> {
  const root = path.resolve(targetPath);
  await ensureDirectory(root);

  const configPath = safeJoin(root, VaultFileName.Config);
  if (await pathExists(configPath)) {
    throw new LoreError(
      ErrorCode.VaultAlreadyExists,
      `目标目录已经是 Lore 知识库：${root}`,
      ExitCode.Conflict,
    );
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
    created_files: createdFiles.sort(),
    existing_files: existingFiles.sort(),
  };
}
