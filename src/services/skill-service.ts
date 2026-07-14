import { cp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCode, ExitCode } from "../domain/enums.js";
import { LoreError } from "../errors.js";
import { ensureDirectory, pathExists } from "../infrastructure/filesystem.js";

export interface InstallSkillsOptions {
  target?: string;
  force?: boolean;
}

export interface InstallSkillsResult {
  target: string;
  installed: string[];
}

/** npm 包与源码树都将 skills 放在当前模块上两级。 */
function bundledSkillsRoot(): string {
  return fileURLToPath(new URL("../../skills", import.meta.url));
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

/** 安装一个或全部内置 Skill；默认目标遵循 CODEX_HOME。 */
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
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const target = path.resolve(options.target ?? path.join(codexHome, "skills"));
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
    if (options.force === true) {
      // 先清空旧目录，确保升级后不会残留新版本已删除的文件。
      await rm(destination.path, { recursive: true, force: true });
    }
    await cp(path.join(bundledSkillsRoot(), destination.name), destination.path, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    installed.push(destination.name);
  }
  return { target, installed };
}
