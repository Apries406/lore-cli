import { createHash, randomUUID } from "node:crypto";
import { cp, readFile, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HASH_ALGORITHM } from "../domain/constants.js";
import { AgentSkillStatus, ErrorCode, ExitCode } from "../domain/enums.js";
import type { AgentSkillInspection } from "../domain/agent-models.js";
import { LoreError } from "../errors.js";
import { ensureDirectory, pathExists } from "../infrastructure/filesystem.js";
import { walkFiles } from "../infrastructure/walk.js";

export interface InstallSkillsOptions {
  target?: string;
  force?: boolean;
}

export interface InstallSkillsResult {
  target: string;
  installed: string[];
}

export interface ReconcileSkillsResult {
  target: string;
  installed: string[];
  updated: string[];
  skipped: string[];
}

/** npm 包与源码树都将 skills 放在当前模块上两级。 */
function bundledSkillsRoot(): string {
  return fileURLToPath(new URL("../../skills", import.meta.url));
}

/** 对 Skill 目录的全部普通文件计算稳定摘要，用于发现旧版本。 */
async function skillDirectoryDigest(target: string): Promise<string | undefined> {
  if (!(await pathExists(target))) {
    return undefined;
  }
  const hash = createHash(HASH_ALGORITHM);
  for (const filePath of await walkFiles(target)) {
    const relativePath = path.relative(target, filePath).split(path.sep).join("/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** 返回 npm 包内可安装的 Lore Skills。 */
export async function listBundledSkills(): Promise<string[]> {
  const root = bundledSkillsRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skills: string[] = [];
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (await pathExists(path.join(root, entry.name, "SKILL.md")))
    ) {
      skills.push(entry.name);
    }
  }
  return skills.sort();
}

/** 检查目标目录中的 Lore Skills 是否缺失或落后于当前包。 */
export async function inspectBundledSkills(
  target: string,
): Promise<AgentSkillInspection[]> {
  const resolvedTarget = path.resolve(target);
  const inspections: AgentSkillInspection[] = [];
  for (const name of await listBundledSkills()) {
    const bundledDigest = await skillDirectoryDigest(
      path.join(bundledSkillsRoot(), name),
    );
    const installedDigest = await skillDirectoryDigest(
      path.join(resolvedTarget, name),
    );
    inspections.push({
      name,
      status:
        installedDigest === undefined
          ? AgentSkillStatus.Missing
          : installedDigest === bundledDigest
            ? AgentSkillStatus.Current
            : AgentSkillStatus.Outdated,
    });
  }
  return inspections;
}

/** 安装一个或全部内置 Skill；默认使用 Codex 当前用户级开放目录。 */
export async function installBundledSkills(
  names: string[],
  options: InstallSkillsOptions = {},
): Promise<InstallSkillsResult> {
  const available = await listBundledSkills();
  const selected = names.length > 0 ? names : available;
  for (const name of selected) {
    if (!available.includes(name)) {
      throw new LoreError(
        ErrorCode.InvalidArgument,
        `不存在内置 Skill：${name}`,
        ExitCode.InvalidArgument,
      );
    }
  }
  const target = path.resolve(
    options.target ?? path.join(os.homedir(), ".agents", "skills"),
  );
  await ensureDirectory(target);
  const destinations = selected.map((name) => ({
    name,
    path: path.join(target, name),
  }));
  if (options.force !== true) {
    for (const destination of destinations) {
      if (await pathExists(destination.path)) {
        throw new LoreError(
          ErrorCode.Conflict,
          `Skill 已存在：${destination.path}；确认覆盖时使用 --force`,
          ExitCode.Conflict,
        );
      }
    }
  }
  const installed: string[] = [];
  for (const destination of destinations) {
    const temporaryPath = path.join(
      target,
      `.lore-${destination.name}-${randomUUID()}.installing`,
    );
    try {
      // 先完整复制到同一文件系统，再用 rename 瞬时发布，避免留下半份 Skill。
      await cp(path.join(bundledSkillsRoot(), destination.name), temporaryPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      if (options.force === true) {
        // 显式升级时清空旧目录，确保不会残留新版本已删除的文件。
        await rm(destination.path, { recursive: true, force: true });
      }
      await rename(temporaryPath, destination.path);
      installed.push(destination.name);
    } finally {
      await rm(temporaryPath, { recursive: true, force: true });
    }
  }
  return { target, installed };
}

/**
 * 幂等补齐目标中的 Lore Skills；默认只新增缺失项，force 才升级被修改的旧项。
 */
export async function reconcileBundledSkills(
  target: string,
  force = false,
): Promise<ReconcileSkillsResult> {
  const resolvedTarget = path.resolve(target);
  const inspections = await inspectBundledSkills(resolvedTarget);
  const installed = inspections
    .filter((item) => item.status === AgentSkillStatus.Missing)
    .map((item) => item.name);
  const updated = force
    ? inspections
        .filter((item) => item.status === AgentSkillStatus.Outdated)
        .map((item) => item.name)
    : [];
  const selected = [...installed, ...updated];
  if (selected.length > 0) {
    await installBundledSkills(selected, {
      target: resolvedTarget,
      force,
    });
  }
  return {
    target: resolvedTarget,
    installed: installed.sort(),
    updated: updated.sort(),
    skipped: inspections
      .filter((item) => !selected.includes(item.name))
      .map((item) => item.name)
      .sort(),
  };
}
