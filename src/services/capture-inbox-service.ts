import { createHash } from "node:crypto";
import { open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  CaptureAction,
  CaptureCandidateStatus,
  CaptureMode,
  CompileRunStatus,
  DirectoryName,
  ErrorCode,
  ExitCode,
  MutationOperation,
  SourceKind,
  VaultFileName,
} from "../domain/enums.js";
import type {
  CaptureCandidate,
  CaptureCandidateDraft,
  CapturePolicy,
  CaptureProposalResult,
  CaptureRule,
} from "../domain/capture-models.js";
import type { AddSourceResult } from "../domain/models.js";
import type { CompilePacket, CompileRun } from "../domain/compile-models.js";
import { LoreError } from "../errors.js";
import { ensureDirectory, pathExists, safeJoin } from "../infrastructure/filesystem.js";
import { readYamlFile, writeYamlFile } from "../infrastructure/serialization.js";
import { getCompilePacket, getCompileRun, prepareCompile } from "./compile-service.js";
import { readCapturePolicy } from "./capture-policy-service.js";
import { acquireMutationLock } from "./mutation-service.js";
import { addSource, detectSensitiveContent, showSource } from "./source-service.js";

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

function matchesRule(rule: CaptureRule, draft: CaptureCandidateDraft): boolean {
  const text = `${draft.title}\n${draft.summary}\n${draft.details}`.toLowerCase();
  const repository = draft.origin.repository ?? "";
  const dimensions = [
    !rule.categories || rule.categories.includes(draft.category),
    !rule.path_patterns ||
      draft.origin.changed_paths.some((changedPath) =>
        rule.path_patterns!.some((pattern) => matcher(pattern).test(changedPath)),
      ),
    !rule.keywords || rule.keywords.some((keyword) => text.includes(keyword.toLowerCase())),
    !rule.repository_patterns ||
      rule.repository_patterns.some((pattern) => matcher(pattern).test(repository)),
  ];
  return dimensions.every(Boolean);
}

function evaluatePolicy(
  policy: CapturePolicy,
  draft: CaptureCandidateDraft,
): { decision: CaptureAction; matchedRules: string[] } {
  const matching = policy.rules.filter((rule) => matchesRule(rule, draft));
  const matchedRules = matching.map((rule) => rule.id).sort();
  if (policy.mode === CaptureMode.Off) {
    return { decision: CaptureAction.Exclude, matchedRules };
  }
  if (matching.some((rule) => rule.action === CaptureAction.Exclude)) {
    return { decision: CaptureAction.Exclude, matchedRules };
  }
  if (draft.questions.length > 0 || draft.confidence < policy.confirmation_below) {
    return { decision: CaptureAction.Ask, matchedRules };
  }
  if (matching.some((rule) => rule.action === CaptureAction.Ask)) {
    return { decision: CaptureAction.Ask, matchedRules };
  }
  if (matching.some((rule) => rule.action === CaptureAction.Include)) {
    return { decision: CaptureAction.Include, matchedRules };
  }
  return { decision: policy.default_action, matchedRules };
}

function assertDraft(draft: CaptureCandidateDraft): void {
  const originKinds = new Set(["git_diff", "task_summary", "explicit"]);
  if (
    draft.version !== 1 ||
    !draft.title.trim() ||
    !draft.summary.trim() ||
    !draft.category.trim() ||
    !Number.isFinite(draft.confidence) ||
    draft.confidence < 0 ||
    draft.confidence > 1 ||
    !Array.isArray(draft.tags) ||
    !draft.tags.every((item) => typeof item === "string") ||
    !Array.isArray(draft.questions) ||
    !draft.questions.every((item) => typeof item === "string") ||
    !draft.origin ||
    !originKinds.has(draft.origin.kind) ||
    (draft.origin.repository !== undefined && typeof draft.origin.repository !== "string") ||
    (draft.origin.revision !== undefined && typeof draft.origin.revision !== "string") ||
    !Array.isArray(draft.origin.changed_paths) ||
    !draft.origin.changed_paths.every(
      (item) =>
        typeof item === "string" &&
        !path.isAbsolute(item) &&
        item !== ".." &&
        !item.startsWith(`..${path.sep}`),
    )
  ) {
    throw new LoreError(
      ErrorCode.InvalidArgument,
      "Capture Candidate 结构无效",
      ExitCode.InvalidArgument,
    );
  }
}

function dedupeKey(draft: CaptureCandidateDraft): string {
  const stable = {
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    details: draft.details.trim(),
    category: draft.category,
    tags: [...draft.tags].sort(),
    repository: draft.origin.repository,
    revision: draft.origin.revision,
    changed_paths: [...draft.origin.changed_paths].sort(),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function candidateDirectory(root: string, candidateId: string): string {
  if (!/^cap_[a-f0-9]{16}$/u.test(candidateId)) {
    throw new LoreError(ErrorCode.InvalidArgument, "候选 ID 格式无效", ExitCode.InvalidArgument);
  }
  return safeJoin(root, DirectoryName.Runtime, DirectoryName.Inbox, candidateId);
}

function candidatePath(root: string, candidateId: string): string {
  return safeJoin(candidateDirectory(root, candidateId), VaultFileName.CaptureCandidate);
}

export async function showInboxCandidate(
  root: string,
  candidateId: string,
): Promise<CaptureCandidate> {
  const targetPath = candidatePath(root, candidateId);
  if (!(await pathExists(targetPath))) {
    throw new LoreError(
      ErrorCode.CaptureCandidateNotFound,
      `未找到 Inbox 候选：${candidateId}`,
      ExitCode.NotFound,
    );
  }
  return readYamlFile<CaptureCandidate>(targetPath);
}

export async function listInboxCandidates(
  root: string,
  status?: CaptureCandidateStatus,
): Promise<CaptureCandidate[]> {
  const inbox = safeJoin(root, DirectoryName.Runtime, DirectoryName.Inbox);
  const entries = await readdir(inbox, { withFileTypes: true }).catch(() => []);
  const candidates: CaptureCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const targetPath = safeJoin(inbox, entry.name, VaultFileName.CaptureCandidate);
    if (await pathExists(targetPath)) candidates.push(await readYamlFile(targetPath));
  }
  return candidates
    .filter((candidate) => !status || candidate.status === status)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

/** 将 Agent 提炼出的稳定知识送入本机 Inbox；排除项不会落盘。 */
export async function proposeCaptureCandidate(
  root: string,
  draft: CaptureCandidateDraft,
  now: Date = new Date(),
): Promise<CaptureProposalResult> {
  assertDraft(draft);
  const sensitiveKinds = detectSensitiveContent(
    Buffer.from(`${draft.title}\n${draft.summary}\n${draft.details}`),
  );
  if (sensitiveKinds.length > 0) {
    return {
      stored: false,
      decision: CaptureAction.Exclude,
      matched_rules: [],
      sensitive: true,
      sensitive_kinds: sensitiveKinds,
      deduplicated: false,
      auto_accept: false,
    };
  }
  const policy = await readCapturePolicy(root);
  const { decision, matchedRules } = evaluatePolicy(policy, draft);
  if (decision === CaptureAction.Exclude) {
    return {
      stored: false,
      decision,
      matched_rules: matchedRules,
      sensitive: false,
      deduplicated: false,
      auto_accept: false,
    };
  }
  const key = dedupeKey(draft);
  const candidateId = `cap_${key.slice(0, 16)}`;
  const lock = await acquireMutationLock(root, MutationOperation.CaptureUpdate, candidateId);
  try {
    const targetPath = candidatePath(root, candidateId);
    if (await pathExists(targetPath)) {
      const existing = await readYamlFile<CaptureCandidate>(targetPath);
      return {
        stored: true,
        decision: existing.decision,
        matched_rules: existing.matched_rules,
        sensitive: false,
        deduplicated: true,
        auto_accept: false,
        candidate: existing,
      };
    }
    const timestamp = now.toISOString();
    const candidate: CaptureCandidate = {
      ...draft,
      candidate_id: candidateId,
      dedupe_key: key,
      status:
        decision === CaptureAction.Ask
          ? CaptureCandidateStatus.NeedsConfirmation
          : CaptureCandidateStatus.Pending,
      decision,
      matched_rules: matchedRules,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await writeYamlFile(targetPath, candidate);
    return {
      stored: true,
      decision,
      matched_rules: matchedRules,
      sensitive: false,
      deduplicated: false,
      auto_accept:
        policy.mode === CaptureMode.Automatic &&
        decision === CaptureAction.Include &&
        draft.confidence >= policy.automatic_accept_above,
      candidate,
    };
  } finally {
    await lock.release();
  }
}

function renderCandidate(candidate: CaptureCandidate): string {
  const repository = candidate.origin.repository
    ? path.basename(candidate.origin.repository)
    : undefined;
  return [
    `# ${candidate.title}`,
    "",
    candidate.summary,
    "",
    candidate.details,
    "",
    `- 类别：${candidate.category}`,
    `- 标签：${candidate.tags.join("、") || "无"}`,
    ...(repository ? [`- 仓库：${repository}`] : []),
    ...(candidate.origin.revision ? [`- 修订：${candidate.origin.revision}`] : []),
    ...(candidate.origin.changed_paths.length > 0
      ? [`- 相关路径：${candidate.origin.changed_paths.join("、")}`]
      : []),
    "",
  ].join("\n");
}

export interface AcceptInboxResult {
  candidate: CaptureCandidate;
  source: AddSourceResult["source"];
  run: CompileRun;
  packet: CompilePacket;
}

/** 接受候选只创建 Raw Source 和待审 Compile Run，不直接修改 Wiki。 */
export async function acceptInboxCandidate(
  root: string,
  candidateId: string,
  now: Date = new Date(),
): Promise<AcceptInboxResult> {
  const directory = candidateDirectory(root, candidateId);
  await ensureDirectory(directory);
  const lockPath = safeJoin(directory, "accept.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LoreError(ErrorCode.Conflict, "该候选正在被接受", ExitCode.Conflict);
    }
    throw error;
  }
  try {
    let candidate = await showInboxCandidate(root, candidateId);
    if (candidate.status === CaptureCandidateStatus.Rejected) {
      throw new LoreError(ErrorCode.Conflict, "已拒绝的候选不能接受", ExitCode.Conflict);
    }
    let source: AddSourceResult["source"];
    if (candidate.source_id) {
      source = (await showSource(root, candidate.source_id)).source;
    } else {
      const added = await addSource(root, renderCandidate(candidate), {
        kind: SourceKind.Text,
        title: candidate.title,
        now,
      });
      source = added.source;
      candidate = {
        ...candidate,
        status: CaptureCandidateStatus.Accepted,
        source_id: added.source.source_id,
        snapshot_id: added.snapshot.snapshot_id,
        updated_at: now.toISOString(),
      };
      await writeYamlFile(candidatePath(root, candidateId), candidate);
    }
    let run: CompileRun;
    let packet: CompilePacket;
    if (candidate.compile_run_id) {
      run = await getCompileRun(root, candidate.compile_run_id);
      packet = await getCompilePacket(root, candidate.compile_run_id);
    } else {
      ({ run, packet } = await prepareCompile(root, source.source_id));
      candidate = {
        ...candidate,
        status: CaptureCandidateStatus.Accepted,
        compile_run_id: run.run_id,
        updated_at: now.toISOString(),
      };
      await writeYamlFile(candidatePath(root, candidateId), candidate);
    }
    return { candidate, source, run, packet };
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true });
  }
}

export async function rejectInboxCandidate(
  root: string,
  candidateId: string,
  reason: string,
  now: Date = new Date(),
): Promise<CaptureCandidate> {
  if (!reason.trim()) {
    throw new LoreError(ErrorCode.InvalidArgument, "拒绝原因不能为空", ExitCode.InvalidArgument);
  }
  const lock = await acquireMutationLock(root, MutationOperation.CaptureUpdate, candidateId);
  try {
    const current = await showInboxCandidate(root, candidateId);
    if ([CaptureCandidateStatus.Accepted, CaptureCandidateStatus.Completed].includes(current.status)) {
      throw new LoreError(ErrorCode.Conflict, "已接受的候选不能拒绝", ExitCode.Conflict);
    }
    const updated: CaptureCandidate = {
      ...current,
      status: CaptureCandidateStatus.Rejected,
      rejection_reason: reason.trim(),
      updated_at: now.toISOString(),
    };
    await writeYamlFile(candidatePath(root, candidateId), updated);
    return updated;
  } finally {
    await lock.release();
  }
}

export async function completeInboxCandidate(
  root: string,
  candidateId: string,
  runId: string,
  now: Date = new Date(),
): Promise<CaptureCandidate> {
  const run = await getCompileRun(root, runId);
  const current = await showInboxCandidate(root, candidateId);
  if (
    run.status !== CompileRunStatus.Applied ||
    run.run_id !== current.compile_run_id ||
    run.source_id !== current.source_id
  ) {
    throw new LoreError(
      ErrorCode.InvalidRunState,
      "只有该候选对应且已应用的 Compile Run 才能完成 Inbox 项",
      ExitCode.Conflict,
    );
  }
  const updated = {
    ...current,
    status: CaptureCandidateStatus.Completed,
    updated_at: now.toISOString(),
  };
  await writeYamlFile(candidatePath(root, candidateId), updated);
  return updated;
}
