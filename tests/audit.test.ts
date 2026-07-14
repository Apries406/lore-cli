import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeSet } from "../src/domain/compile-models.js";
import {
  AuditDiagnosticCode,
  ChangeAction,
  CompileRunStatus,
  KnowledgeOperation,
  SourceKind,
  SourceLifecycleAction,
  WikiPageType,
} from "../src/domain/enums.js";
import { auditVault } from "../src/services/audit-service.js";
import {
  applyCompile,
  evidenceQuoteSha256,
  prepareCompile,
  submitChangeSet,
} from "../src/services/compile-service.js";
import {
  addSource,
  updateSourceLifecycle,
} from "../src/services/source-service.js";
import { initializeVault } from "../src/services/vault-service.js";

describe("知识库长期健康审计", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((targetPath) =>
        rm(targetPath, { recursive: true, force: true }),
      ),
    );
  });

  async function temporaryDirectory(prefix: string): Promise<string> {
    const targetPath = await mkdtemp(path.join(os.tmpdir(), prefix));
    temporaryRoots.push(targetPath);
    return targetPath;
  }

  it("接受刚初始化且为空的 Vault", async () => {
    const root = await temporaryDirectory("lore-audit-empty-");
    await initializeVault(root);

    await expect(auditVault(root)).resolves.toMatchObject({
      healthy: true,
      errors: 0,
      warnings: 0,
      coverage: { sources: 0, snapshots: 0, wiki_pages: 0 },
    });
  });

  it("报告尚未编译的 latest Snapshot", async () => {
    const root = await temporaryDirectory("lore-audit-source-");
    const inputRoot = await temporaryDirectory("lore-audit-input-");
    await initializeVault(root);
    const inputPath = path.join(inputRoot, "notes.md");
    await writeFile(inputPath, "尚未编译的材料\n", "utf8");
    await addSource(root, inputPath, {
      now: new Date("2026-07-14T11:00:00.000Z"),
    });

    const report = await auditVault(
      root,
      new Date("2026-07-14T11:01:00.000Z"),
    );

    expect(report.healthy).toBe(true);
    expect(report.warnings).toBe(1);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: AuditDiagnosticCode.UncompiledLatestSnapshot,
      }),
    );
  });

  it("将 Active 页面缺少 Evidence 和重复 lore.id 报告为错误", async () => {
    const root = await temporaryDirectory("lore-audit-pages-");
    await initializeVault(root);
    const page = (title: string) =>
      `---\ntype: concept\ntitle: ${title}\nlore:\n  id: con_duplicate\n  status: active\n---\n\n# ${title}\n`;
    await writeFile(path.join(root, "wiki/pages/one.md"), page("页面一"), "utf8");
    await writeFile(path.join(root, "wiki/pages/two.md"), page("页面二"), "utf8");

    const report = await auditVault(root);

    expect(report.healthy).toBe(false);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: AuditDiagnosticCode.MissingEvidence }),
        expect.objectContaining({ code: AuditDiagnosticCode.DuplicateConceptId }),
        expect.objectContaining({ code: AuditDiagnosticCode.OrphanPage }),
      ]),
    );
  });

  it("应用后的编译记录和 Evidence 能证明 latest 已被健康吸收", async () => {
    const root = await temporaryDirectory("lore-audit-compiled-");
    const inputRoot = await temporaryDirectory("lore-audit-compiled-input-");
    await initializeVault(root);
    const content = "Raw 保存不可变证据。\nWiki 保存规范知识。\n";
    const inputPath = path.join(inputRoot, "knowledge.md");
    await writeFile(inputPath, content, "utf8");
    const added = await addSource(root, inputPath, {
      now: new Date("2026-07-14T12:00:00.000Z"),
    });
    const prepared = await prepareCompile(root, added.source.source_id, {
      now: new Date("2026-07-14T12:01:00.000Z"),
    });
    const locator = "line:1-2";
    const changeSet: ChangeSet = {
      version: 1,
      run_id: prepared.run.run_id,
      base_revision: prepared.packet.vault.base_revision,
      operation: KnowledgeOperation.Compile,
      inputs: [
        {
          source_id: added.source.source_id,
          snapshot_id: added.snapshot.snapshot_id,
        },
      ],
      summary: "沉淀双层知识模型",
      changes: [
        {
          action: ChangeAction.Create,
          target: { path: "wiki/pages/knowledge-model.md" },
          reason: "形成可复用知识",
          concept: {
            type: WikiPageType.Concept,
            title: "知识双层模型",
            lore: {
              evidence: [
                {
                  id: "ev_layers",
                  source_id: added.source.source_id,
                  snapshot_id: added.snapshot.snapshot_id,
                  locator,
                  quote_sha256: evidenceQuoteSha256(content, locator),
                },
              ],
            },
            body: "# 知识双层模型\n\nRaw 与 Wiki 分别保存证据和规范知识。",
          },
        },
      ],
    };
    await submitChangeSet(
      root,
      prepared.run.run_id,
      changeSet,
      new Date("2026-07-14T12:02:00.000Z"),
    );
    const applied = await applyCompile(
      root,
      prepared.run.run_id,
      new Date("2026-07-14T12:03:00.000Z"),
    );
    expect(applied.run.status).toBe(CompileRunStatus.Applied);

    const report = await auditVault(
      root,
      new Date("2026-07-14T12:04:00.000Z"),
    );
    expect(report).toMatchObject({
      healthy: true,
      errors: 0,
      warnings: 0,
      coverage: {
        sources: 1,
        snapshots: 1,
        latest_snapshots_compiled: 1,
        wiki_pages: 1,
        pages_with_evidence: 1,
        incomplete_compile_runs: 0,
      },
    });
  });

  it("标记仍被 Wiki Evidence 引用的 tombstoned Source", async () => {
    const root = await temporaryDirectory("lore-audit-tombstone-");
    await initializeVault(root);
    const content = "即将撤销的来源";
    const added = await addSource(root, content, { kind: SourceKind.Text });
    const locator = "line:1-1";
    await writeFile(
      path.join(root, "wiki/pages/tombstoned-source.md"),
      `---\ntype: concept\ntitle: 被撤销来源\nlore:\n  status: active\n  evidence:\n    - id: ev_tombstoned\n      source_id: ${added.source.source_id}\n      snapshot_id: ${added.snapshot.snapshot_id}\n      locator: ${locator}\n      quote_sha256: ${evidenceQuoteSha256(content, locator)}\n---\n\n# 被撤销来源\n`,
      "utf8",
    );
    await updateSourceLifecycle(
      root,
      added.source.source_id,
      SourceLifecycleAction.Tombstone,
    );

    const report = await auditVault(root);

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: AuditDiagnosticCode.EvidenceSourceTombstoned,
      }),
    );
  });
});
