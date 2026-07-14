import type {
  AgentInstallAction,
  AgentKind,
  AgentSkillStatus,
} from "./enums.js";

/** 用户级 Lore 配置；Agent 在任意工作目录都能找到默认 Vault。 */
export interface LoreUserConfig {
  version: number;
  default_vault: string;
}

/** 单个 Lore Skill 在目标 Agent 中的安装状态。 */
export interface AgentSkillInspection {
  name: string;
  status: AgentSkillStatus;
}

/** 一个 Agent 的发现结果及其标准用户级 Skills 目录。 */
export interface AgentInspection {
  kind: AgentKind;
  label: string;
  detected: boolean;
  detection_paths: string[];
  skills_directory: string;
  skills: AgentSkillInspection[];
  missing_skills: string[];
  outdated_skills: string[];
  ready: boolean;
}

/** 向一个 Agent 或自定义目录安装 Lore Skills 的结果。 */
export interface AgentInstallResult {
  kind: AgentKind;
  label: string;
  target: string;
  action: AgentInstallAction;
  installed: string[];
  updated: string[];
  skipped: string[];
}

/** Agent-first init 的完整机器输出。 */
export interface AgentFirstInitResult {
  root: string;
  resumed: boolean;
  created_files: string[];
  existing_files: string[];
  default_vault?: string;
  detected_agents: AgentInspection[];
  agent_installations: AgentInstallResult[];
  validation: {
    valid: boolean;
    errors: number;
    warnings: number;
  };
}
