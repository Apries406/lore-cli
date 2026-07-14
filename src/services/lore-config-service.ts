import os from "node:os";
import path from "node:path";
import {
  APP_DATA_ENVIRONMENT_VARIABLE,
  DEFAULT_VAULT_DIRECTORY_NAME,
  LORE_CONFIG_DIRECTORY_NAME,
  LORE_CONFIG_FILE_NAME,
  LORE_HOME_ENVIRONMENT_VARIABLE,
  LORE_ROOT_ENVIRONMENT_VARIABLE,
  LOCAL_APP_DATA_ENVIRONMENT_VARIABLE,
  LORE_USER_CONFIG_VERSION,
  XDG_CONFIG_HOME_ENVIRONMENT_VARIABLE,
  XDG_DATA_HOME_ENVIRONMENT_VARIABLE,
} from "../domain/constants.js";
import { ErrorCode, ExitCode, VaultFileName } from "../domain/enums.js";
import type { LoreUserConfig } from "../domain/agent-models.js";
import { LoreError } from "../errors.js";
import { findVaultRoot, pathExists } from "../infrastructure/filesystem.js";
import { readYamlFile, writeYamlFile } from "../infrastructure/serialization.js";

export interface LoreEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

/** 按覆盖变量、平台约定和 XDG 约定定位 Lore 用户配置目录。 */
export function getLoreHome(options: LoreEnvironmentOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const explicit = env[LORE_HOME_ENVIRONMENT_VARIABLE];
  if (explicit) {
    return path.resolve(explicit);
  }
  const xdgHome = env[XDG_CONFIG_HOME_ENVIRONMENT_VARIABLE];
  if (xdgHome) {
    return path.resolve(xdgHome, LORE_CONFIG_DIRECTORY_NAME);
  }
  const appData = env[APP_DATA_ENVIRONMENT_VARIABLE];
  if (platform === "win32" && appData) {
    return path.resolve(appData, "Lore");
  }
  return path.resolve(home, ".config", LORE_CONFIG_DIRECTORY_NAME);
}

/** 返回用户配置文件的稳定路径，便于 Agent 诊断。 */
export function getLoreConfigPath(options: LoreEnvironmentOptions = {}): string {
  return path.join(getLoreHome(options), LORE_CONFIG_FILE_NAME);
}

/** 返回无参数 `lore init` 使用的个人 Vault 默认位置。 */
export function getDefaultNewVaultPath(
  options: LoreEnvironmentOptions = {},
): string {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const explicitHome = env[LORE_HOME_ENVIRONMENT_VARIABLE];
  if (explicitHome) {
    return path.resolve(explicitHome, DEFAULT_VAULT_DIRECTORY_NAME);
  }
  const xdgDataHome = env[XDG_DATA_HOME_ENVIRONMENT_VARIABLE];
  if (xdgDataHome) {
    return path.resolve(
      xdgDataHome,
      LORE_CONFIG_DIRECTORY_NAME,
      DEFAULT_VAULT_DIRECTORY_NAME,
    );
  }
  const localAppData = env[LOCAL_APP_DATA_ENVIRONMENT_VARIABLE];
  if (platform === "win32" && localAppData) {
    return path.resolve(localAppData, "Lore", DEFAULT_VAULT_DIRECTORY_NAME);
  }
  return path.resolve(
    home,
    ".local",
    "share",
    LORE_CONFIG_DIRECTORY_NAME,
    DEFAULT_VAULT_DIRECTORY_NAME,
  );
}

/** 对磁盘配置执行运行时校验，避免类型声明掩盖损坏文件。 */
function assertUserConfig(value: unknown): asserts value is LoreUserConfig {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !== LORE_USER_CONFIG_VERSION ||
    typeof (value as Record<string, unknown>).default_vault !== "string" ||
    (value as Record<string, unknown>).default_vault === ""
  ) {
    throw new LoreError(
      ErrorCode.InvalidUserConfig,
      "Lore 用户配置损坏；请重新执行 lore vault use <path>",
      ExitCode.Conflict,
    );
  }
}

/** 读取用户配置；首次使用且文件不存在时返回 undefined。 */
export async function readUserConfig(
  options: LoreEnvironmentOptions = {},
): Promise<LoreUserConfig | undefined> {
  const configPath = getLoreConfigPath(options);
  if (!(await pathExists(configPath))) {
    return undefined;
  }
  const config = await readYamlFile<unknown>(configPath).catch((error: unknown) => {
    throw new LoreError(
      ErrorCode.InvalidUserConfig,
      `无法读取 Lore 用户配置：${configPath}`,
      ExitCode.Conflict,
      error,
    );
  });
  assertUserConfig(config);
  return config;
}

/** 设置默认 Vault，使 Agent 离开 Vault 目录后仍能直接调用 Lore。 */
export async function setDefaultVault(
  vaultPath: string,
  options: LoreEnvironmentOptions = {},
): Promise<LoreUserConfig> {
  const root = await findVaultRoot(vaultPath);
  const config: LoreUserConfig = {
    version: LORE_USER_CONFIG_VERSION,
    default_vault: root,
  };
  await writeYamlFile(getLoreConfigPath(options), config);
  return config;
}

/** 读取并验证默认 Vault；配置缺失或路径失效时给出可执行修复建议。 */
export async function getDefaultVault(
  options: LoreEnvironmentOptions = {},
): Promise<string> {
  const config = await readUserConfig(options);
  if (!config) {
    throw new LoreError(
      ErrorCode.VaultNotFound,
      "尚未配置默认 Lore Vault；请执行 lore init 或 lore vault use <path>",
      ExitCode.NotFound,
    );
  }
  const configPath = path.join(config.default_vault, VaultFileName.Config);
  if (!(await pathExists(configPath))) {
    throw new LoreError(
      ErrorCode.VaultNotFound,
      `默认 Lore Vault 已失效：${config.default_vault}；请执行 lore vault use <path>`,
      ExitCode.NotFound,
    );
  }
  return config.default_vault;
}

/**
 * 按显式参数、环境变量、当前目录、默认配置的优先级定位 Vault。
 * 这让 Agent 在任意代码仓库中都能使用同一个个人知识库。
 */
export async function resolveVaultRoot(
  explicitRoot: string | undefined,
  startPath: string = process.cwd(),
  options: LoreEnvironmentOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  if (explicitRoot) {
    return findVaultRoot(explicitRoot);
  }
  const environmentRoot = env[LORE_ROOT_ENVIRONMENT_VARIABLE];
  if (environmentRoot) {
    return findVaultRoot(environmentRoot);
  }
  try {
    return await findVaultRoot(startPath);
  } catch (error) {
    if (!(error instanceof LoreError) || error.code !== ErrorCode.VaultNotFound) {
      throw error;
    }
  }
  return getDefaultVault(options);
}
