import type { AgentFirstInitResult } from "../domain/agent-models.js";
import { ErrorCode, ExitCode, type AgentKind } from "../domain/enums.js";
import { LoreError } from "../errors.js";
import {
  agentsNeedingAutomaticInstall,
  inspectAgents,
  installAgentSkills,
} from "./agent-service.js";
import type { LoreEnvironmentOptions } from "./lore-config-service.js";
import { setDefaultVault } from "./lore-config-service.js";
import { validateVault } from "./validation-service.js";
import { initializeVault } from "./vault-service.js";

export interface AgentFirstInitOptions {
  agents?: AgentKind[];
  custom_targets?: string[];
  auto_install?: boolean;
  force_skills?: boolean;
  set_default?: boolean;
  environment?: LoreEnvironmentOptions;
}

/**
 * 初始化 Vault、配置默认路径并为 Agent 安装 Skills。
 * 全部步骤保持幂等，任何阶段中断后可再次执行同一条 init 命令。
 */
export async function initializeAgentFirst(
  targetPath: string,
  options: AgentFirstInitOptions = {},
): Promise<AgentFirstInitResult> {
  const environment = options.environment ?? {};
  const vault = await initializeVault(targetPath);
  const validation = await validateVault(vault.root);
  if (!validation.valid) {
    throw new LoreError(
      ErrorCode.ValidationFailed,
      `Lore Vault 初始化后校验失败：${validation.errors} 个错误`,
      ExitCode.ValidationFailed,
    );
  }
  const before = await inspectAgents(environment);
  const selected = new Set(options.agents ?? []);
  if (options.auto_install === true) {
    for (const kind of agentsNeedingAutomaticInstall(
      before,
      options.force_skills === true,
    )) {
      selected.add(kind);
    }
  }
  const installations = await installAgentSkills(
    [...selected],
    options.custom_targets ?? [],
    options.force_skills === true,
    environment,
  );
  const userConfig =
    options.set_default === false
      ? undefined
      : await setDefaultVault(vault.root, environment);
  return {
    ...vault,
    ...(userConfig ? { default_vault: userConfig.default_vault } : {}),
    detected_agents: await inspectAgents(environment),
    agent_installations: installations,
    validation: {
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
    },
  };
}
