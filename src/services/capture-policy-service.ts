import { createHash } from "node:crypto";
import {
  CaptureAction,
  CaptureMode,
  DirectoryName,
  ErrorCode,
  ExitCode,
  MutationOperation,
  VaultFileName,
} from "../domain/enums.js";
import type { CapturePolicy, CaptureRule } from "../domain/capture-models.js";
import { LoreError } from "../errors.js";
import { pathExists, safeJoin } from "../infrastructure/filesystem.js";
import {
  readYamlFile,
  serializeYaml,
  writeYamlFile,
} from "../infrastructure/serialization.js";
import { acquireMutationLock } from "./mutation-service.js";

const MODES = new Set<string>(Object.values(CaptureMode));
const ACTIONS = new Set<string>(Object.values(CaptureAction));

/** 新 Vault 使用的保守默认策略：稳定知识进入 Inbox，不确定时询问。 */
export function createDefaultCapturePolicy(): CapturePolicy {
  return {
    version: 1,
    mode: CaptureMode.Assisted,
    default_action: CaptureAction.Ask,
    confirmation_below: 0.85,
    automatic_accept_above: 0.95,
    auto_apply: false,
    rules: [
      {
        id: "include-durable-knowledge",
        action: CaptureAction.Include,
        description: "稳定的决策、根因、约束、套路和边界应进入候选箱",
        categories: [
          "architecture_decision",
          "bug_root_cause",
          "reusable_playbook",
          "domain_constraint",
          "non_obvious_behavior",
          "failed_approach",
          "test_boundary",
        ],
      },
      {
        id: "exclude-local-and-generated-files",
        action: CaptureAction.Exclude,
        description: "凭证、依赖、构建产物、日志与生成代码不参与自动采集",
        path_patterns: [
          ".env",
          ".env.*",
          "node_modules/**",
          "dist/**",
          "build/**",
          "coverage/**",
          "generated/**",
          "*.log",
        ],
      },
    ],
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validRule(value: unknown): value is CaptureRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return (
    typeof rule.id === "string" &&
    rule.id.length > 0 &&
    typeof rule.action === "string" &&
    ACTIONS.has(rule.action) &&
    typeof rule.description === "string" &&
    (rule.categories === undefined || isStringArray(rule.categories)) &&
    (rule.path_patterns === undefined || isStringArray(rule.path_patterns)) &&
    (rule.keywords === undefined || isStringArray(rule.keywords)) &&
    (rule.repository_patterns === undefined || isStringArray(rule.repository_patterns))
  );
}

/** 在任何持久化前校验 Capture Policy 的完整运行时契约。 */
export function assertCapturePolicy(value: unknown): asserts value is CapturePolicy {
  const policy = value as Partial<CapturePolicy> | undefined;
  const valid = Boolean(
    policy &&
      policy.version === 1 &&
      typeof policy.mode === "string" &&
      MODES.has(policy.mode) &&
      typeof policy.default_action === "string" &&
      ACTIONS.has(policy.default_action) &&
      typeof policy.confirmation_below === "number" &&
      policy.confirmation_below >= 0 &&
      policy.confirmation_below <= 1 &&
      typeof policy.automatic_accept_above === "number" &&
      policy.automatic_accept_above >= 0 &&
      policy.automatic_accept_above <= 1 &&
      policy.automatic_accept_above >= policy.confirmation_below &&
      typeof policy.auto_apply === "boolean" &&
      Array.isArray(policy.rules) &&
      policy.rules.every(validRule) &&
      new Set(policy.rules.map((rule) => rule.id)).size === policy.rules.length,
  );
  if (!valid) {
    throw new LoreError(
      ErrorCode.InvalidArgument,
      "Capture Policy 结构无效，阈值必须位于 0..1 且规则 ID 不可重复",
      ExitCode.InvalidArgument,
    );
  }
}

function policyPath(root: string): string {
  return safeJoin(root, DirectoryName.Schema, VaultFileName.CapturePolicy);
}

export function capturePolicyRevision(policy: CapturePolicy): string {
  return createHash("sha256").update(serializeYaml(policy)).digest("hex");
}

/** 读取策略；旧版 Vault 尚无该文件时返回兼容默认值。 */
export async function readCapturePolicy(root: string): Promise<CapturePolicy> {
  const targetPath = policyPath(root);
  if (!(await pathExists(targetPath))) return createDefaultCapturePolicy();
  const policy = await readYamlFile<unknown>(targetPath);
  assertCapturePolicy(policy);
  return policy;
}

/** 原子应用已审阅策略；expectedSha256 防止覆盖并发修改。 */
export async function applyCapturePolicy(
  root: string,
  value: unknown,
  options: { expected_sha256?: string } = {},
): Promise<{ policy: CapturePolicy; sha256: string }> {
  assertCapturePolicy(value);
  const policy = value;
  const lock = await acquireMutationLock(root, MutationOperation.CaptureUpdate, "policy");
  try {
    const current = await readCapturePolicy(root);
    const currentRevision = capturePolicyRevision(current);
    if (options.expected_sha256 && options.expected_sha256 !== currentRevision) {
      throw new LoreError(
        ErrorCode.Conflict,
        "Capture Policy 已被其他进程修改，请重新读取后再应用",
        ExitCode.Conflict,
        { expected: options.expected_sha256, actual: currentRevision },
      );
    }
    await writeYamlFile(policyPath(root), policy);
    return { policy, sha256: capturePolicyRevision(policy) };
  } finally {
    await lock.release();
  }
}
