import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CaptureAction,
  CaptureCandidateStatus,
  CaptureMode,
  ErrorCode,
} from "../src/domain/enums.js";
import type {
  CaptureCandidateDraft,
  CapturePolicy,
} from "../src/domain/capture-models.js";
import { pathExists } from "../src/infrastructure/filesystem.js";
import {
  applyCapturePolicy,
  createDefaultCapturePolicy,
  readCapturePolicy,
} from "../src/services/capture-policy-service.js";
import {
  acceptInboxCandidate,
  listInboxCandidates,
  proposeCaptureCandidate,
  rejectInboxCandidate,
  showInboxCandidate,
} from "../src/services/capture-inbox-service.js";
import { checkCaptureTask } from "../src/services/capture-service.js";
import { initializeVault } from "../src/services/vault-service.js";

describe("Capture Policy、Knowledge Inbox 与任务结束检查", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((targetPath) =>
        rm(targetPath, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        }),
      ),
    );
  });

  async function temporaryDirectory(prefix: string): Promise<string> {
    const targetPath = await mkdtemp(path.join(os.tmpdir(), prefix));
    temporaryRoots.push(targetPath);
    return targetPath;
  }

  async function createVault(): Promise<string> {
    const root = await temporaryDirectory("lore-capture-vault-");
    await initializeVault(root);
    return root;
  }

  function candidate(
    overrides: Partial<CaptureCandidateDraft> = {},
  ): CaptureCandidateDraft {
    return {
      version: 1,
      title: "统一写锁保证知识事务串行化",
      summary: "所有持久知识写入共享统一写锁。",
      details: "调试确认 Source、Compile 和 Migration 不能并发修改 Vault。",
      category: "architecture_decision",
      confidence: 0.95,
      tags: ["lore", "transaction"],
      questions: [],
      origin: {
        kind: "git_diff",
        repository: "/workspace/lore",
        revision: "abc123",
        changed_paths: ["src/services/mutation-service.ts"],
      },
      ...overrides,
    };
  }

  it("初始化 assisted 默认策略并将 Policy 与 Inbox 分别放在持久层和本机层", async () => {
    const root = await createVault();

    await expect(readCapturePolicy(root)).resolves.toMatchObject({
      version: 1,
      mode: CaptureMode.Assisted,
      default_action: CaptureAction.Ask,
      auto_apply: false,
    });
    await expect(
      pathExists(path.join(root, "schema", "capture-policy.yaml")),
    ).resolves.toBe(true);
    await expect(pathExists(path.join(root, ".lore", "inbox"))).resolves.toBe(true);
    await expect(readFile(path.join(root, ".gitignore"), "utf8"))
      .resolves.toContain(".lore/");
  });

  it("排除优先于必须沉淀，低置信度和显式问题必须进入确认", async () => {
    const root = await createVault();
    const policy: CapturePolicy = {
      ...createDefaultCapturePolicy(),
      rules: [
        {
          id: "include-architecture",
          action: CaptureAction.Include,
          description: "架构决策必须沉淀",
          categories: ["architecture_decision"],
        },
        {
          id: "exclude-generated",
          action: CaptureAction.Exclude,
          description: "生成内容必须排除",
          path_patterns: ["generated/**"],
        },
      ],
    };
    await applyCapturePolicy(root, policy);

    const excluded = await proposeCaptureCandidate(
      root,
      candidate({
        origin: {
          kind: "git_diff",
          repository: "/workspace/lore",
          changed_paths: ["generated/client.ts"],
        },
      }),
    );
    expect(excluded).toMatchObject({
      stored: false,
      decision: CaptureAction.Exclude,
      matched_rules: ["exclude-generated", "include-architecture"],
    });

    const uncertain = await proposeCaptureCandidate(
      root,
      candidate({ confidence: 0.5 }),
    );
    expect(uncertain.candidate).toMatchObject({
      status: CaptureCandidateStatus.NeedsConfirmation,
      decision: CaptureAction.Ask,
    });

    const questioned = await proposeCaptureCandidate(
      root,
      candidate({ questions: ["这个约束是否只适用于本地 Vault？"] }),
    );
    expect(questioned.candidate).toMatchObject({
      status: CaptureCandidateStatus.NeedsConfirmation,
    });
  });

  it("候选去重、接受后生成 Raw Source 和 Compile Run，并支持拒绝", async () => {
    const root = await createVault();
    const proposed = await proposeCaptureCandidate(root, candidate());
    expect(proposed.candidate).toMatchObject({
      status: CaptureCandidateStatus.Pending,
      decision: CaptureAction.Include,
    });
    const candidateId = proposed.candidate!.candidate_id;

    const duplicate = await proposeCaptureCandidate(root, candidate());
    expect(duplicate).toMatchObject({
      deduplicated: true,
      candidate: { candidate_id: candidateId },
    });
    await expect(listInboxCandidates(root)).resolves.toHaveLength(1);

    const accepted = await acceptInboxCandidate(root, candidateId);
    expect(accepted).toMatchObject({
      candidate: {
        candidate_id: candidateId,
        status: CaptureCandidateStatus.Accepted,
        source_id: expect.stringMatching(/^src_/u),
        compile_run_id: expect.stringMatching(/^run_/u),
      },
      source: { source_id: expect.stringMatching(/^src_/u) },
      run: { run_id: expect.stringMatching(/^run_/u), status: "prepared" },
    });
    await expect(showInboxCandidate(root, candidateId)).resolves.toMatchObject({
      status: CaptureCandidateStatus.Accepted,
    });

    const second = await proposeCaptureCandidate(
      root,
      candidate({ title: "失败方案", summary: "轮询方案导致锁竞争。" }),
    );
    const rejected = await rejectInboxCandidate(
      root,
      second.candidate!.candidate_id,
      "只属于一次性实验",
    );
    expect(rejected).toMatchObject({
      status: CaptureCandidateStatus.Rejected,
      rejection_reason: "只属于一次性实验",
    });
  });

  it("automatic 模式只对高置信度 include 候选给出自动接受信号，不绕过编译审阅", async () => {
    const root = await createVault();
    await applyCapturePolicy(root, {
      ...createDefaultCapturePolicy(),
      mode: CaptureMode.Automatic,
      automatic_accept_above: 0.9,
      auto_apply: false,
    });

    await expect(proposeCaptureCandidate(root, candidate())).resolves.toMatchObject({
      stored: true,
      auto_accept: true,
      candidate: { status: CaptureCandidateStatus.Pending },
    });
    await expect(
      proposeCaptureCandidate(
        root,
        candidate({ title: "低置信度", confidence: 0.7 }),
      ),
    ).resolves.toMatchObject({
      auto_accept: false,
      candidate: { status: CaptureCandidateStatus.NeedsConfirmation },
    });
  });

  it("任务结束检查读取安全 Git diff，排除 .env 且不读取被排除内容", async () => {
    const root = await createVault();
    const repository = await temporaryDirectory("lore-capture-repository-");
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Lore Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "lore@example.com"], {
      cwd: repository,
    });
    await writeFile(path.join(repository, "app.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });
    await writeFile(path.join(repository, "app.ts"), "export const value = 2;\n");
    await writeFile(path.join(repository, "notes.md"), "复用统一写锁。\n");
    await writeFile(path.join(repository, ".env"), "SECRET=must-not-leak\n");

    const packet = await checkCaptureTask(root, repository, {
      summary: "实现统一写锁并补充说明",
    });

    expect(packet).toMatchObject({
      should_review: true,
      repository,
      changed_paths: [".env", "app.ts", "notes.md"],
      eligible_paths: ["app.ts", "notes.md"],
      excluded_paths: [".env"],
      task_summary: "实现统一写锁并补充说明",
    });
    expect(packet.diff).toContain("value = 2");
    expect(packet.diff).toContain("复用统一写锁");
    expect(packet.diff).not.toContain("must-not-leak");
  });

  it("敏感候选在写入 Inbox 前被硬排除", async () => {
    const root = await createVault();
    const result = await proposeCaptureCandidate(
      root,
      candidate({
        details: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key",
      }),
    );

    expect(result).toMatchObject({
      stored: false,
      decision: CaptureAction.Exclude,
      sensitive: true,
    });
    await expect(listInboxCandidates(root)).resolves.toEqual([]);
  });

  it("非法 Policy 不会覆盖现有策略", async () => {
    const root = await createVault();
    const before = await readFile(
      path.join(root, "schema", "capture-policy.yaml"),
      "utf8",
    );

    await expect(
      applyCapturePolicy(root, {
        ...createDefaultCapturePolicy(),
        confirmation_below: 2,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(
      readFile(path.join(root, "schema", "capture-policy.yaml"), "utf8"),
    ).resolves.toBe(before);
  });
});
