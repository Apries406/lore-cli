import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeSet, CompilePacket } from "../src/domain/compile-models.js";
import {
  CandidateMatchReason,
  ChangeAction,
  CompileRunStatus,
  ConfidenceLevel,
  DirectoryName,
  ErrorCode,
  KnowledgeOperation,
  VaultFileName,
  WikiPageType,
} from "../src/domain/enums.js";
import { LoreError } from "../src/errors.js";
import { pathExists } from "../src/infrastructure/filesystem.js";
import { readYamlFile } from "../src/infrastructure/serialization.js";
import {
  applyCompile,
  evidenceQuoteSha256,
  getCompileRun,
  prepareCompile,
  rollbackCompile,
  submitChangeSet,
} from "../src/services/compile-service.js";
import { addSource } from "../src/services/source-service.js";
import { validateVault } from "../src/services/validation-service.js";
import { initializeVault } from "../src/services/vault-service.js";

const PREPARE_TIME = new Date("2026-07-14T08:00:00.000Z");
const SUBMIT_TIME = new Date("2026-07-14T08:01:00.000Z");
const APPLY_TIME = new Date("2026-07-14T08:02:00.000Z");

describe("Raw 到 Wiki 的知识编译流程", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((targetPath) =>
        rm(targetPath, { recursive: true, force: true }),
      ),
    );
  });

  async function createFixture(): Promise<{
    root: string;
    sourceId: string;
    snapshotId: string;
    content: string;
  }> {
    const root = await mkdtemp(path.join(os.tmpdir(), "lore-compile-vault-"));
    const inputRoot = await mkdtemp(path.join(os.tmpdir(), "lore-compile-input-"));
    temporaryRoots.push(root, inputRoot);
    await initializeVault(root);
    const content = "Lore 的 Raw Snapshot 不可变。\nWiki 是可演进的知识视图。\n";
    const inputPath = path.join(inputRoot, "lore-notes.md");
    await writeFile(inputPath, content, "utf8");
    const added = await addSource(root, inputPath, { now: PREPARE_TIME });
    return {
      root,
      sourceId: added.source.source_id,
      snapshotId: added.snapshot.snapshot_id,
      content,
    };
  }

  function createChangeSet(packet: CompilePacket): ChangeSet {
    const locator = "line:1-2";
    return {
      version: 1,
      run_id: packet.run_id,
      base_revision: packet.vault.base_revision,
      operation: KnowledgeOperation.Compile,
      inputs: [
        {
          source_id: packet.input.source.source_id,
          snapshot_id: packet.input.snapshot.snapshot_id,
        },
      ],
      summary: "沉淀 Lore 的双层知识模型",
      changes: [
        {
          action: ChangeAction.Create,
          target: { path: "wiki/pages/lore-knowledge-model.md" },
          reason: "原始材料包含可复用的架构原则",
          concept: {
            type: WikiPageType.Concept,
            title: "Lore 双层知识模型",
            description: "Raw 保存证据，Wiki 保存可演进知识。",
            tags: ["lore", "knowledge-model"],
            lore: {
              confidence: ConfidenceLevel.High,
              evidence: [
                {
                  id: "ev_raw_wiki_layers",
                  source_id: packet.input.source.source_id,
                  snapshot_id: packet.input.snapshot.snapshot_id,
                  locator,
                  quote_sha256: evidenceQuoteSha256(packet.input.content, locator),
                },
              ],
            },
            body: "# Lore 双层知识模型\n\nRaw 层不可变，Wiki 层可通过受控编译持续演进。",
          },
        },
      ],
    };
  }

  it("完成 prepare、submit、diff、apply、幂等保护和 rollback 闭环", async () => {
    const fixture = await createFixture();
    const prepared = await prepareCompile(fixture.root, fixture.sourceId, {
      now: PREPARE_TIME,
    });

    expect(prepared.run.status).toBe(CompileRunStatus.Prepared);
    expect(prepared.packet.input.content).toBe(fixture.content);
    expect(prepared.packet.vault.base_revision.wiki_sha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );

    const submitted = await submitChangeSet(
      fixture.root,
      prepared.run.run_id,
      createChangeSet(prepared.packet),
      SUBMIT_TIME,
    );
    expect(submitted.run.status).toBe(CompileRunStatus.Validated);
    expect(submitted.validation).toMatchObject({ valid: true, errors: [] });
    expect(submitted.diff).toContain("+++ b/wiki/pages/lore-knowledge-model.md");
    expect(await pathExists(path.join(fixture.root, "wiki/pages/lore-knowledge-model.md"))).toBe(
      false,
    );

    const applied = await applyCompile(fixture.root, prepared.run.run_id, APPLY_TIME);
    expect(applied.run.status).toBe(CompileRunStatus.Applied);
    const pagePath = path.join(fixture.root, "wiki/pages/lore-knowledge-model.md");
    const page = await readFile(pagePath, "utf8");
    expect(page).toContain("quote_sha256:");
    expect(page).toContain("lore://source/");
    expect(await readFile(path.join(fixture.root, "wiki/index.md"), "utf8")).toContain(
      "Lore 双层知识模型",
    );
    expect(await readFile(path.join(fixture.root, "wiki/log.md"), "utf8")).toContain(
      prepared.run.run_id,
    );
    await expect(validateVault(fixture.root)).resolves.toMatchObject({ valid: true });

    const recordPath = path.join(
      fixture.root,
      DirectoryName.Raw,
      DirectoryName.Sources,
      fixture.sourceId,
      DirectoryName.Compilations,
      fixture.snapshotId,
      `${prepared.run.run_id}.yaml`,
    );
    expect(
      (await readYamlFile<{ status: CompileRunStatus }>(recordPath)).status,
    ).toBe(CompileRunStatus.Applied);
    await expect(prepareCompile(fixture.root, fixture.sourceId)).rejects.toMatchObject<
      Partial<LoreError>
    >({ code: ErrorCode.AlreadyCompiled });

    const rolledBack = await rollbackCompile(
      fixture.root,
      prepared.run.run_id,
      new Date("2026-07-14T08:03:00.000Z"),
    );
    expect(rolledBack.run.status).toBe(CompileRunStatus.RolledBack);
    expect(await pathExists(pagePath)).toBe(false);
    expect(await readFile(path.join(fixture.root, "wiki/index.md"), "utf8")).toContain(
      "尚未编译任何知识页面",
    );
    expect(
      (await readYamlFile<{ status: CompileRunStatus }>(recordPath)).status,
    ).toBe(CompileRunStatus.RolledBack);
    await expect(validateVault(fixture.root)).resolves.toMatchObject({ valid: true });
  });

  it("Evidence 摘录哈希错误时拒绝 Change Set", async () => {
    const fixture = await createFixture();
    const prepared = await prepareCompile(fixture.root, fixture.sourceId, {
      now: PREPARE_TIME,
    });
    const changeSet = createChangeSet(prepared.packet);
    const evidence = changeSet.changes[0]?.concept.lore?.evidence?.[0];
    if (!evidence) {
      throw new Error("测试 Change Set 缺少 Evidence");
    }
    evidence.quote_sha256 = "0".repeat(64);

    const submitted = await submitChangeSet(
      fixture.root,
      prepared.run.run_id,
      changeSet,
      SUBMIT_TIME,
    );

    expect(submitted.run.status).toBe(CompileRunStatus.Rejected);
    expect(submitted.validation.valid).toBe(false);
    expect(submitted.validation.errors.join("\n")).toContain("摘录哈希不匹配");
  });

  it("Wiki 在 prepare 后变化时拒绝应用，且不写入页面", async () => {
    const fixture = await createFixture();
    const prepared = await prepareCompile(fixture.root, fixture.sourceId, {
      now: PREPARE_TIME,
    });
    await submitChangeSet(
      fixture.root,
      prepared.run.run_id,
      createChangeSet(prepared.packet),
      SUBMIT_TIME,
    );
    const logPath = path.join(fixture.root, DirectoryName.Wiki, VaultFileName.Log);
    await writeFile(logPath, `${await readFile(logPath, "utf8")}\n外部修改\n`, "utf8");

    await expect(
      applyCompile(fixture.root, prepared.run.run_id, APPLY_TIME),
    ).rejects.toMatchObject<Partial<LoreError>>({ code: ErrorCode.Conflict });
    expect((await getCompileRun(fixture.root, prepared.run.run_id)).status).toBe(
      CompileRunStatus.Conflict,
    );
    expect(
      await pathExists(path.join(fixture.root, "wiki/pages/lore-knowledge-model.md")),
    ).toBe(false);
  });

  it("重新编译时召回已有页面并通过受控 update 合并知识", async () => {
    const fixture = await createFixture();
    const first = await prepareCompile(fixture.root, fixture.sourceId, {
      now: PREPARE_TIME,
    });
    await submitChangeSet(
      fixture.root,
      first.run.run_id,
      createChangeSet(first.packet),
      SUBMIT_TIME,
    );
    await applyCompile(fixture.root, first.run.run_id, APPLY_TIME);

    const second = await prepareCompile(fixture.root, fixture.sourceId, {
      recompile: true,
      now: new Date("2026-07-14T09:00:00.000Z"),
    });
    const candidate = second.packet.candidates.find(
      (item) => item.path === "wiki/pages/lore-knowledge-model.md",
    );
    expect(candidate).toBeDefined();
    expect(candidate?.match_reasons).toContain(CandidateMatchReason.ExistingEvidence);
    const update = createChangeSet(second.packet);
    const change = update.changes[0];
    if (!change || !candidate) {
      throw new Error("测试缺少 update 候选");
    }
    change.action = ChangeAction.Update;
    change.target.expected_sha256 = candidate.content_sha256;
    change.reason = "同一来源重编译，用于验证受控合并路径";
    change.concept.body =
      "# Lore 双层知识模型\n\nRaw 层不可变，Wiki 层可演进；所有更新都必须经过 Change Set。";

    const submitted = await submitChangeSet(
      fixture.root,
      second.run.run_id,
      update,
      new Date("2026-07-14T09:01:00.000Z"),
    );
    expect(submitted.run.status).toBe(CompileRunStatus.Validated);
    await applyCompile(
      fixture.root,
      second.run.run_id,
      new Date("2026-07-14T09:02:00.000Z"),
    );
    expect(
      await readFile(
        path.join(fixture.root, "wiki/pages/lore-knowledge-model.md"),
        "utf8",
      ),
    ).toContain("所有更新都必须经过 Change Set");
    await expect(validateVault(fixture.root)).resolves.toMatchObject({ valid: true });
  });
});
