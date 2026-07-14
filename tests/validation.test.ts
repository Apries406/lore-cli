import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DiagnosticCode,
  DirectoryName,
  WikiPageType,
} from "../src/domain/enums.js";
import { addSource } from "../src/services/source-service.js";
import { validateVault } from "../src/services/validation-service.js";
import { initializeVault } from "../src/services/vault-service.js";

describe("知识库校验", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((targetPath) =>
        rm(targetPath, { recursive: true, force: true }),
      ),
    );
  });

  async function createVault(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "lore-validation-"));
    temporaryRoots.push(root);
    await initializeVault(root);
    return root;
  }

  it("接受刚初始化的知识库", async () => {
    const root = await createVault();

    await expect(validateVault(root)).resolves.toMatchObject({
      valid: true,
      errors: 0,
      warnings: 0,
    });
  });

  it("拒绝缺少 frontmatter 的 OKF Concept", async () => {
    const root = await createVault();
    const pagePath = path.join(
      root,
      DirectoryName.Wiki,
      DirectoryName.Pages,
      "invalid.md",
    );
    await writeFile(pagePath, "# 缺少元数据\n", "utf8");

    const report = await validateVault(root);

    expect(report.valid).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: DiagnosticCode.MissingFrontmatter }),
    );
  });

  it("校验 Lore frontmatter，并将断链报告为警告", async () => {
    const root = await createVault();
    const pagePath = path.join(
      root,
      DirectoryName.Wiki,
      DirectoryName.Pages,
      "architecture.md",
    );
    await writeFile(
      pagePath,
      `---\ntype: ${WikiPageType.Decision}\ntitle: Lore 架构\n---\n\n参见[缺失页面](./missing.md)。\n`,
      "utf8",
    );

    const report = await validateVault(root);

    expect(report.valid).toBe(true);
    expect(report.warnings).toBe(1);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: DiagnosticCode.BrokenLink }),
    );
  });

  it("检测不可变 Raw Snapshot 被篡改", async () => {
    const root = await createVault();
    const inputDirectory = await mkdtemp(path.join(os.tmpdir(), "lore-source-"));
    temporaryRoots.push(inputDirectory);
    const inputPath = path.join(inputDirectory, "evidence.md");
    await writeFile(inputPath, "原始证据\n", "utf8");
    const result = await addSource(root, inputPath, {
      now: new Date("2026-07-14T08:00:00.000Z"),
    });
    const snapshotContent = path.join(
      root,
      DirectoryName.Raw,
      DirectoryName.Sources,
      result.source.source_id,
      DirectoryName.Snapshots,
      result.snapshot.snapshot_id,
      result.snapshot.content_path,
    );
    await writeFile(snapshotContent, "篡改后的证据\n", "utf8");

    const report = await validateVault(root);

    expect(report.valid).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: DiagnosticCode.SnapshotChecksumMismatch,
      }),
    );
  });
});
