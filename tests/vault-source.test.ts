import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DirectoryName, VaultFileName } from "../src/domain/enums.js";
import { pathExists } from "../src/infrastructure/filesystem.js";
import {
  addSource,
  listSources,
  showSource,
  syncSource,
} from "../src/services/source-service.js";
import { initializeVault } from "../src/services/vault-service.js";

const FIXED_TIME = new Date("2026-07-14T08:00:00.000Z");

describe("知识库与来源生命周期", () => {
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

  it("初始化精简的 Lore/OKF 目录结构", async () => {
    const root = await temporaryDirectory("lore-vault-");
    const result = await initializeVault(root);

    expect(result.root).toBe(root);
    expect(result.created_files).toContain(VaultFileName.Config);
    expect(
      await pathExists(path.join(root, DirectoryName.Wiki, DirectoryName.Pages)),
    ).toBe(true);
    expect(
      await pathExists(
        path.join(root, DirectoryName.Schema, VaultFileName.ConceptSchema),
      ),
    ).toBe(true);
  });

  it("幂等采集不可变 Snapshot，并识别内容变化", async () => {
    const root = await temporaryDirectory("lore-vault-");
    const sourceDirectory = await temporaryDirectory("lore-input-");
    const inputPath = path.join(sourceDirectory, "notes.md");
    await initializeVault(root);
    await writeFile(inputPath, "# 第一版\n", "utf8");

    const first = await addSource(root, inputPath, { now: FIXED_TIME });
    const duplicate = await addSource(root, inputPath, { now: FIXED_TIME });

    expect(first.source_created).toBe(true);
    expect(first.snapshot_created).toBe(true);
    expect(duplicate.source.source_id).toBe(first.source.source_id);
    expect(duplicate.snapshot.snapshot_id).toBe(first.snapshot.snapshot_id);
    expect(duplicate.source_created).toBe(false);
    expect(duplicate.snapshot_created).toBe(false);

    await writeFile(inputPath, "# 第二版\n", "utf8");
    const changed = await syncSource(root, first.source.source_id, FIXED_TIME);

    expect(changed.source.source_id).toBe(first.source.source_id);
    expect(changed.snapshot.snapshot_id).not.toBe(first.snapshot.snapshot_id);
    expect(changed.snapshot_created).toBe(true);

    const sources = await listSources(root);
    const shown = await showSource(root, first.source.source_id);
    expect(sources).toHaveLength(1);
    expect(shown.latest.snapshot_id).toBe(changed.snapshot.snapshot_id);

    const originalContent = await readFile(
      path.join(
        root,
        DirectoryName.Raw,
        DirectoryName.Sources,
        first.source.source_id,
        DirectoryName.Snapshots,
        first.snapshot.snapshot_id,
        first.snapshot.content_path,
      ),
      "utf8",
    );
    expect(originalContent).toBe("# 第一版\n");
  });
});
