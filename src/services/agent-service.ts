import { constants as fileSystemConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentInspection,
  AgentInstallResult,
} from "../domain/agent-models.js";
import {
  AgentInstallAction,
  AgentKind,
  AgentSkillStatus,
  ErrorCode,
  ExitCode,
} from "../domain/enums.js";
import { LoreError } from "../errors.js";
import { pathExists } from "../infrastructure/filesystem.js";
import type { LoreEnvironmentOptions } from "./lore-config-service.js";
import {
  inspectBundledSkills,
  reconcileBundledSkills,
} from "./skill-service.js";

interface AgentDescriptor {
  kind: AgentKind;
  label: string;
  executables: string[];
  detectionDirectories: (home: string) => string[];
  skillsDirectory: (home: string) => string;
}

/** 可自动检测 Agent 的稳定顺序也用于交互选择编号。 */
export const SUPPORTED_AGENT_KINDS: readonly AgentKind[] = [
  AgentKind.Codex,
  AgentKind.ClaudeCode,
  AgentKind.Trae,
  AgentKind.TraeCn,
];

const AGENT_DESCRIPTORS: readonly AgentDescriptor[] = [
  {
    kind: AgentKind.Codex,
    label: "Codex",
    executables: ["codex"],
    detectionDirectories: (home) => [
      path.join(home, ".codex"),
      path.join(home, ".agents"),
    ],
    skillsDirectory: (home) => path.join(home, ".agents", "skills"),
  },
  {
    kind: AgentKind.ClaudeCode,
    label: "Claude Code",
    executables: ["claude"],
    detectionDirectories: (home) => [path.join(home, ".claude")],
    skillsDirectory: (home) => path.join(home, ".claude", "skills"),
  },
  {
    kind: AgentKind.Trae,
    label: "TRAE 国际版",
    executables: ["trae"],
    detectionDirectories: (home) => [path.join(home, ".trae")],
    skillsDirectory: (home) => path.join(home, ".trae", "skills"),
  },
  {
    kind: AgentKind.TraeCn,
    label: "TRAE 国内版",
    executables: ["trae-cn"],
    detectionDirectories: (home) => [path.join(home, ".trae-cn")],
    skillsDirectory: (home) => path.join(home, ".trae-cn", "skills"),
  },
];

/** 读取 Agent 展示名称；未知值在进入服务前即被拒绝。 */
export function getAgentLabel(kind: AgentKind): string {
  if (kind === AgentKind.Custom) {
    return "其他 Agent";
  }
  return descriptorFor(kind).label;
}

/** 将 CLI 的稳定字符串解析成受控 Agent 枚举。 */
export function parseAgentKind(value: string): AgentKind {
  const kind = SUPPORTED_AGENT_KINDS.find((candidate) => candidate === value);
  if (!kind) {
    throw new LoreError(
      ErrorCode.UnsupportedAgent,
      `不支持的 Agent '${value}'；可选值：${SUPPORTED_AGENT_KINDS.join("、")}`,
      ExitCode.InvalidArgument,
    );
  }
  return kind;
}

function descriptorFor(kind: AgentKind): AgentDescriptor {
  const descriptor = AGENT_DESCRIPTORS.find((item) => item.kind === kind);
  if (!descriptor) {
    throw new LoreError(
      ErrorCode.UnsupportedAgent,
      `没有 Agent 安装描述：${kind}`,
      ExitCode.InvalidArgument,
    );
  }
  return descriptor;
}

/** 在不启动 Shell 的前提下，从 PATH 查找可执行文件。 */
async function findExecutable(
  names: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const searchPath = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = path.join(directory, `${name}${extension}`);
        try {
          await access(candidate, fileSystemConstants.X_OK);
          return candidate;
        } catch {
          // 当前候选不可执行，继续检查其他 PATH 项。
        }
      }
    }
  }
  return undefined;
}

/** 探测所有受支持 Agent，并检查 Lore Skills 的缺失和版本状态。 */
export async function inspectAgents(
  options: LoreEnvironmentOptions = {},
): Promise<AgentInspection[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const inspections: AgentInspection[] = [];
  for (const descriptor of AGENT_DESCRIPTORS) {
    const executable = await findExecutable(
      descriptor.executables,
      env,
      platform,
    );
    const existingDirectories: string[] = [];
    for (const candidate of descriptor.detectionDirectories(home)) {
      if (await pathExists(candidate)) {
        existingDirectories.push(candidate);
      }
    }
    const skillsDirectory = descriptor.skillsDirectory(home);
    const skills = await inspectBundledSkills(skillsDirectory);
    const missingSkills = skills
      .filter((item) => item.status === AgentSkillStatus.Missing)
      .map((item) => item.name)
      .sort();
    const outdatedSkills = skills
      .filter((item) => item.status === AgentSkillStatus.Outdated)
      .map((item) => item.name)
      .sort();
    inspections.push({
      kind: descriptor.kind,
      label: descriptor.label,
      detected: Boolean(executable) || existingDirectories.length > 0,
      detection_paths: [
        ...(executable ? [executable] : []),
        ...existingDirectories,
      ],
      skills_directory: skillsDirectory,
      skills,
      missing_skills: missingSkills,
      outdated_skills: outdatedSkills,
      ready: missingSkills.length === 0 && outdatedSkills.length === 0,
    });
  }
  return inspections;
}

/** 返回自动安装应处理的 Agent：已检测到且仍缺少 Skill。 */
export function agentsNeedingAutomaticInstall(
  inspections: AgentInspection[],
  includeOutdated = false,
): AgentKind[] {
  return inspections
    .filter(
      (item) =>
        item.detected &&
        (item.missing_skills.length > 0 ||
          (includeOutdated && item.outdated_skills.length > 0)),
    )
    .map((item) => item.kind);
}

/** 向选定 Agent 和任意自定义目录幂等安装 Lore Skills。 */
export async function installAgentSkills(
  kinds: AgentKind[],
  customTargets: string[] = [],
  force = false,
  options: LoreEnvironmentOptions = {},
): Promise<AgentInstallResult[]> {
  const home = options.home ?? os.homedir();
  const targets: Array<{ kind: AgentKind; label: string; path: string }> = kinds.map(
    (kind) => {
      const descriptor = descriptorFor(kind);
      return {
        kind,
        label: descriptor.label,
        path: descriptor.skillsDirectory(home),
      };
    },
  );
  targets.push(
    ...customTargets.map((target) => ({
      kind: AgentKind.Custom,
      label: "其他 Agent",
      path: path.resolve(target),
    })),
  );

  const results: AgentInstallResult[] = [];
  const handledTargets = new Set<string>();
  for (const target of targets) {
    const resolvedTarget = path.resolve(target.path);
    if (handledTargets.has(resolvedTarget)) {
      continue;
    }
    handledTargets.add(resolvedTarget);
    const reconciled = await reconcileBundledSkills(resolvedTarget, force);
    const action =
      reconciled.updated.length > 0
        ? AgentInstallAction.Updated
        : reconciled.installed.length > 0
          ? AgentInstallAction.Installed
          : AgentInstallAction.Skipped;
    results.push({
      kind: target.kind,
      label: target.label,
      target: resolvedTarget,
      action,
      installed: reconciled.installed,
      updated: reconciled.updated,
      skipped: reconciled.skipped,
    });
  }
  return results;
}
