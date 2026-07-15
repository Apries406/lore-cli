import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { CaptureAction, CaptureMode } from "../domain/enums.js";
import type { CaptureTaskPacket } from "../domain/capture-models.js";
import { readCapturePolicy } from "./capture-policy-service.js";
import { detectSensitiveContent } from "./source-service.js";

const execFileAsync = promisify(execFile);
const MAX_CAPTURE_PACKET_BYTES = 512 * 1024;
const HARD_EXCLUDED_PATHS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "node_modules/**",
  ".git/**",
];

function matcher(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//u, "");
  const marker = "__DOUBLE_STAR__";
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", marker)
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll(marker, ".*");
  return normalized.includes("/")
    ? new RegExp(`^${escaped}$`, "u")
    : new RegExp(`(?:^|/)${escaped}$`, "u");
}

async function git(repository: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_CAPTURE_PACKET_BYTES * 2,
  });
  return stdout;
}

function nulList(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/** 生成只含安全 Git 变更和任务摘要的任务结束检查包。 */
export async function checkCaptureTask(
  root: string,
  repositoryPath: string,
  options: { summary?: string } = {},
): Promise<CaptureTaskPacket> {
  const requestedRepository = path.resolve(repositoryPath);
  const repository = await realpath(requestedRepository);
  const topLevel = (await git(repository, ["rev-parse", "--show-toplevel"])).trim();
  if ((await realpath(topLevel)) !== repository) {
    return checkCaptureTask(root, topLevel, options);
  }
  const [tracked, untracked, revision] = await Promise.all([
    git(repository, ["diff", "--name-only", "-z", "HEAD"]),
    git(repository, ["ls-files", "--others", "--exclude-standard", "-z"]),
    git(repository, ["rev-parse", "HEAD"]).then((value) => value.trim()).catch(() => undefined),
  ]);
  const untrackedSet = new Set(nulList(untracked));
  const changedPaths = [...new Set([...nulList(tracked), ...untrackedSet])].sort();
  const policy = await readCapturePolicy(root);
  const excludedPatterns = [
    ...HARD_EXCLUDED_PATHS,
    ...policy.rules
      .filter((rule) => rule.action === CaptureAction.Exclude)
      .flatMap((rule) => rule.path_patterns ?? []),
  ];
  const eligiblePaths: string[] = [];
  const excludedPaths: string[] = [];
  const sections: string[] = [];
  let bytes = 0;
  let truncated = false;

  for (const changedPath of changedPaths) {
    if (excludedPatterns.some((pattern) => matcher(pattern).test(changedPath))) {
      excludedPaths.push(changedPath);
      continue;
    }
    let content: string;
    try {
      if (untrackedSet.has(changedPath)) {
        const untrackedPath = path.join(repository, changedPath);
        const metadata = await lstat(untrackedPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          excludedPaths.push(changedPath);
          continue;
        }
        const raw = await readFile(untrackedPath);
        if (raw.includes(0)) {
          excludedPaths.push(changedPath);
          continue;
        }
        content = `diff --git a/${changedPath} b/${changedPath}\nnew file\n+${raw
          .toString("utf8")
          .replaceAll("\n", "\n+")}`;
      } else {
        content = await git(repository, [
          "diff",
          "--no-ext-diff",
          "--unified=3",
          "HEAD",
          "--",
          changedPath,
        ]);
      }
    } catch {
      excludedPaths.push(changedPath);
      continue;
    }
    if (detectSensitiveContent(Buffer.from(content)).length > 0) {
      excludedPaths.push(changedPath);
      continue;
    }
    const contentBytes = Buffer.byteLength(content);
    if (bytes + contentBytes > MAX_CAPTURE_PACKET_BYTES) {
      truncated = true;
      continue;
    }
    bytes += contentBytes;
    eligiblePaths.push(changedPath);
    sections.push(content.trimEnd());
  }

  const taskSummary = options.summary?.trim() ?? "";
  return {
    version: 1,
    should_review:
      policy.mode !== CaptureMode.Off &&
      (eligiblePaths.length > 0 || taskSummary.length > 0),
    repository: requestedRepository,
    ...(revision ? { revision } : {}),
    changed_paths: changedPaths,
    eligible_paths: eligiblePaths.sort(),
    excluded_paths: excludedPaths.sort(),
    task_summary: taskSummary,
    diff: sections.filter(Boolean).join("\n\n"),
    truncated,
  };
}
