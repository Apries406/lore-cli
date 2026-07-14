import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { TEXT_ENCODING } from "../domain/constants.js";
import {
  DirectoryName,
  ErrorCode,
  ExitCode,
  MutationOperation,
  VaultFileName,
} from "../domain/enums.js";
import type { AuditReport, ValidationReport } from "../domain/models.js";
import { LoreError } from "../errors.js";
import {
  ensureDirectory,
  pathExists,
  safeJoin,
} from "../infrastructure/filesystem.js";
import { walkFiles } from "../infrastructure/walk.js";
import { auditVault } from "./audit-service.js";
import { assertVaultCompatible } from "./migration-service.js";
import { acquireMutationLock } from "./mutation-service.js";
import { assertNoSensitiveContent } from "./source-service.js";
import { validateVault } from "./validation-service.js";
import { initializeVault } from "./vault-service.js";

const execFileAsync = promisify(execFile);
const DEFAULT_REMOTE = "origin";
const DEFAULT_BRANCH = "main";
const DURABLE_PATHS = [
  VaultFileName.Config,
  VaultFileName.GitIgnore,
  VaultFileName.LoreIgnore,
  DirectoryName.Raw,
  DirectoryName.Wiki,
  DirectoryName.Schema,
] as const;

interface GitFailure extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

export interface VaultSyncOptions {
  remote?: string;
  branch?: string;
  allow_sensitive?: boolean;
  now?: Date;
}

export interface CloneVaultOptions {
  remote?: string;
  branch?: string;
}

export interface VaultSyncStatus {
  root: string;
  initialized: boolean;
  branch: string;
  remote: string;
  remote_url?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  dirty_paths: string[];
}

export interface VaultSyncResult extends VaultSyncStatus {
  action: "up_to_date" | "pushed" | "fast_forwarded";
  validation: ValidationReport;
  audit: AuditReport;
}

export interface VaultRemote {
  name: string;
  url: string;
}

function gitFailureMessage(error: unknown): string {
  const failure = error as GitFailure;
  return redactCredentials(
    (failure.stderr || failure.stdout || failure.message || String(error)).trim(),
  );
}

function redactCredentials(value: string): string {
  return value.replace(/(https?:\/\/)[^/@\s]+@/giu, "$1***@");
}

function assertGitName(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) || value.includes("..")) {
    throw new LoreError(
      ErrorCode.InvalidArgument,
      `${label}不是安全的 Git 名称：${value}`,
      ExitCode.InvalidArgument,
    );
  }
}

function assertRemoteUrlSafe(value: string): void {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.username || parsed.password)
    ) {
      throw new LoreError(
        ErrorCode.InvalidArgument,
        "远端 URL 不能内嵌用户名、密码或 Token；请使用系统 Git 凭证管理器或 SSH Agent",
        ExitCode.InvalidArgument,
      );
    }
  } catch (error) {
    if (error instanceof LoreError) {
      throw error;
    }
    // SCP 风格 SSH 地址和本地路径不是 WHATWG URL，交给 Git 解析。
  }
}

async function runGit(root: string, arguments_: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", root, ...arguments_], {
      encoding: TEXT_ENCODING,
      maxBuffer: 20 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new LoreError(
      ErrorCode.Conflict,
      `Git 操作失败：${gitFailureMessage(error)}`,
      ExitCode.Conflict,
      { operation: arguments_[0] },
    );
  }
}

async function gitSucceeds(root: string, arguments_: string[]): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", root, ...arguments_], {
      encoding: TEXT_ENCODING,
      maxBuffer: 20 * 1024 * 1024,
    });
    return true;
  } catch (error) {
    const code = (error as GitFailure).code;
    if (typeof code === "number") {
      return false;
    }
    throw error;
  }
}

async function ensureRepository(root: string, branch: string): Promise<void> {
  if (!(await pathExists(path.join(root, ".git")))) {
    await runGit(root, ["init", `--initial-branch=${branch}`]);
  }
  const topLevel = await realpath(
    path.resolve(await runGit(root, ["rev-parse", "--show-toplevel"])),
  );
  if (topLevel !== await realpath(path.resolve(root))) {
    throw new LoreError(
      ErrorCode.Conflict,
      `Vault 必须拥有独立 Git 仓库，当前仓库根目录为：${topLevel}`,
      ExitCode.Conflict,
    );
  }
  const currentBranch = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (currentBranch !== branch) {
    if (await gitSucceeds(root, ["rev-parse", "--verify", "--quiet", "HEAD"])) {
      throw new LoreError(
        ErrorCode.Conflict,
        `当前分支为 ${currentBranch}，同步分支为 ${branch}；请显式使用 --branch ${currentBranch} 或先切换分支`,
        ExitCode.Conflict,
      );
    }
    await runGit(root, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  }
}

async function remoteUrl(root: string, remote: string): Promise<string | undefined> {
  if (!(await gitSucceeds(root, ["remote", "get-url", remote]))) {
    return undefined;
  }
  return runGit(root, ["remote", "get-url", remote]);
}

/** 初始化 Vault 自己的 Git 仓库并添加远端，不保存任何凭证。 */
export async function addVaultRemote(
  root: string,
  name: string,
  url: string,
  branch = DEFAULT_BRANCH,
): Promise<{ remote: string; url: string; branch: string }> {
  assertGitName(name, "远端名称");
  assertGitName(branch, "分支名称");
  assertRemoteUrlSafe(url);
  await assertVaultCompatible(root);
  await ensureRepository(root, branch);
  const existing = await remoteUrl(root, name);
  if (existing && existing !== url) {
    throw new LoreError(
      ErrorCode.Conflict,
      `远端 ${name} 已指向 ${redactCredentials(existing)}；请先用 git remote set-url 显式修改`,
      ExitCode.Conflict,
    );
  }
  if (!existing) {
    await runGit(root, ["remote", "add", name, url]);
  }
  return { remote: name, url, branch };
}

/** 列出 Vault 已配置的 Git 远端；认证仍完全交给系统 Git。 */
export async function listVaultRemotes(root: string): Promise<VaultRemote[]> {
  await assertVaultCompatible(root);
  if (!(await pathExists(path.join(root, ".git")))) {
    return [];
  }
  const names = (await runGit(root, ["remote"]))
    .split("\n")
    .filter(Boolean)
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      url: redactCredentials((await remoteUrl(root, name)) ?? ""),
    })),
  );
}

/** 从 GitHub、GitLab、Gitea 或自建 Git 地址克隆一个 Vault。 */
export async function cloneVault(
  url: string,
  targetPath: string,
  options: CloneVaultOptions = {},
): Promise<{ root: string; remote: string; branch: string }> {
  const root = path.resolve(targetPath);
  const remote = options.remote ?? DEFAULT_REMOTE;
  const branch = options.branch ?? DEFAULT_BRANCH;
  assertGitName(remote, "远端名称");
  assertGitName(branch, "分支名称");
  assertRemoteUrlSafe(url);
  const parent = path.dirname(root);
  await ensureDirectory(parent);
  try {
    await execFileAsync(
      "git",
      [
        "clone",
        "--origin",
        remote,
        "--branch",
        branch,
        "--single-branch",
        "--",
        url,
        root,
      ],
      {
        cwd: parent,
        encoding: TEXT_ENCODING,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
  } catch (error) {
    throw new LoreError(
      ErrorCode.Conflict,
      `克隆 Vault 失败：${gitFailureMessage(error)}`,
      ExitCode.Conflict,
    );
  }
  await assertVaultCompatible(root);
  await assertRuntimeUntracked(root);
  await initializeVault(root);
  return { root, remote, branch };
}

async function dirtyPaths(root: string): Promise<string[]> {
  const commands = [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ];
  const paths = new Set<string>();
  for (const command of commands) {
    const output = await runGit(root, command);
    for (const item of output.split("\n").filter(Boolean)) {
      paths.add(item);
    }
  }
  return [...paths].sort();
}

/** 返回本地工作区、跟踪分支和最近一次 fetch 后的 ahead/behind。 */
export async function getVaultSyncStatus(
  root: string,
  options: Pick<VaultSyncOptions, "remote" | "branch"> = {},
): Promise<VaultSyncStatus> {
  const remote = options.remote ?? DEFAULT_REMOTE;
  const configuredBranch = options.branch ?? DEFAULT_BRANCH;
  assertGitName(remote, "远端名称");
  assertGitName(configuredBranch, "分支名称");
  if (!(await pathExists(path.join(root, ".git")))) {
    return {
      root: path.resolve(root),
      initialized: false,
      branch: configuredBranch,
      remote,
      ahead: 0,
      behind: 0,
      dirty_paths: [],
    };
  }
  const branch = (await gitSucceeds(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]))
    ? await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    : configuredBranch;
  const url = await remoteUrl(root, remote);
  const upstream = (await gitSucceeds(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]))
    ? await runGit(root, ["rev-parse", "--abbrev-ref", "@{upstream}"])
    : undefined;
  let ahead = 0;
  let behind = 0;
  const remoteReference = `refs/remotes/${remote}/${branch}`;
  if (
    await gitSucceeds(root, ["rev-parse", "--verify", "--quiet", "HEAD"]) &&
    await gitSucceeds(root, ["rev-parse", "--verify", "--quiet", remoteReference])
  ) {
    const counts = await runGit(root, [
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${remoteReference}`,
    ]);
    const [aheadText = "0", behindText = "0"] = counts.split(/\s+/u);
    ahead = Number(aheadText);
    behind = Number(behindText);
  }
  return {
    root: path.resolve(root),
    initialized: true,
    branch,
    remote,
    ...(url ? { remote_url: redactCredentials(url) } : {}),
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    dirty_paths: await dirtyPaths(root),
  };
}

async function durableFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const fileName of [
    VaultFileName.Config,
    VaultFileName.GitIgnore,
    VaultFileName.LoreIgnore,
  ]) {
    const filePath = safeJoin(root, fileName);
    if (await pathExists(filePath)) {
      files.push(filePath);
    }
  }
  for (const directory of [DirectoryName.Raw, DirectoryName.Wiki, DirectoryName.Schema]) {
    files.push(...(await walkFiles(safeJoin(root, directory))));
  }
  return files.sort();
}

async function runPreflight(
  root: string,
  allowSensitive: boolean,
  now: Date,
): Promise<{ validation: ValidationReport; audit: AuditReport }> {
  await assertRuntimeUntracked(root);
  const validation = await validateVault(root);
  if (!validation.valid) {
    throw new LoreError(
      ErrorCode.ValidationFailed,
      `Vault 校验失败，已阻止同步（${validation.errors} 个错误）`,
      ExitCode.ValidationFailed,
      validation,
    );
  }
  const audit = await auditVault(root, now);
  if (!audit.healthy) {
    throw new LoreError(
      ErrorCode.ValidationFailed,
      `Vault 健康审计失败，已阻止同步（${audit.errors} 个错误）`,
      ExitCode.ValidationFailed,
      audit,
    );
  }
  for (const filePath of await durableFiles(root)) {
    const content = await readFile(filePath);
    if (!content.includes(0)) {
      assertNoSensitiveContent(
        content,
        path.relative(root, filePath),
        allowSensitive,
      );
    }
  }
  return { validation, audit };
}

async function assertRuntimeUntracked(root: string): Promise<void> {
  const trackedRuntime = await runGit(root, [
    "ls-files",
    "--",
    DirectoryName.Runtime,
  ]);
  if (trackedRuntime) {
    throw new LoreError(
      ErrorCode.ValidationFailed,
      "检测到 .lore/ 本机运行数据已进入 Git；请先从 Git 索引移除，避免泄露召回记录、锁和设备绑定",
      ExitCode.ValidationFailed,
      { tracked_paths: trackedRuntime.split("\n") },
    );
  }
}

/** 提交持久知识，并且只允许远端与本地之间的 fast-forward 更新。 */
export async function syncVault(
  root: string,
  options: VaultSyncOptions = {},
): Promise<VaultSyncResult> {
  const remote = options.remote ?? DEFAULT_REMOTE;
  const branch = options.branch ?? DEFAULT_BRANCH;
  assertGitName(remote, "远端名称");
  assertGitName(branch, "分支名称");
  const now = options.now ?? new Date();
  await assertVaultCompatible(root);
  await ensureRepository(root, branch);
  if (!(await remoteUrl(root, remote))) {
    throw new LoreError(
      ErrorCode.VaultNotFound,
      `未配置 Git 远端 ${remote}；请先执行 lore vault remote add ${remote} <url>`,
      ExitCode.NotFound,
    );
  }
  const lock = await acquireMutationLock(
    root,
    MutationOperation.VaultSync,
    `${remote}/${branch}`,
    now,
  );
  try {
    let preflight = await runPreflight(
      root,
      options.allow_sensitive === true,
      now,
    );
    await runGit(root, ["add", "-A", "--", ...DURABLE_PATHS]);
    if (!(await gitSucceeds(root, ["diff", "--cached", "--quiet"]))) {
      await runGit(root, [
        "commit",
        "-m",
        `chore(lore): sync ${now.toISOString()}`,
      ]);
    }

    const remoteHead = await runGit(root, [
      "ls-remote",
      "--heads",
      remote,
      `refs/heads/${branch}`,
    ]);
    let action: VaultSyncResult["action"] = "up_to_date";
    if (!remoteHead) {
      await runGit(root, ["push", "--set-upstream", remote, `HEAD:${branch}`]);
      action = "pushed";
    } else {
      await runGit(root, ["fetch", "--prune", remote, branch]);
      const remoteReference = `refs/remotes/${remote}/${branch}`;
      const localIsAncestor = await gitSucceeds(root, [
        "merge-base",
        "--is-ancestor",
        "HEAD",
        remoteReference,
      ]);
      const remoteIsAncestor = await gitSucceeds(root, [
        "merge-base",
        "--is-ancestor",
        remoteReference,
        "HEAD",
      ]);
      if (localIsAncestor && !remoteIsAncestor) {
        await runGit(root, ["merge", "--ff-only", remoteReference]);
        preflight = await runPreflight(
          root,
          options.allow_sensitive === true,
          now,
        );
        action = "fast_forwarded";
      } else if (remoteIsAncestor && !localIsAncestor) {
        await runGit(root, ["push", "--set-upstream", remote, `HEAD:${branch}`]);
        action = "pushed";
      } else if (!localIsAncestor && !remoteIsAncestor) {
        throw new LoreError(
          ErrorCode.Conflict,
          `本地 ${branch} 与 ${remote}/${branch} 已分叉；Lore 不会自动合并知识历史，请先人工处理 Git 分支`,
          ExitCode.Conflict,
        );
      } else if (
        !(await gitSucceeds(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]))
      ) {
        await runGit(root, [
          "branch",
          `--set-upstream-to=${remote}/${branch}`,
          branch,
        ]);
      }
    }
    const status = await getVaultSyncStatus(root, { remote, branch });
    return { ...status, action, ...preflight };
  } finally {
    await lock.release();
  }
}
