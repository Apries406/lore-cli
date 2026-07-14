import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/domain/constants.js";
import { ErrorCode, VaultFileName } from "../src/domain/enums.js";
import type { MigrationHistory } from "../src/domain/migration-models.js";
import type { VaultConfig } from "../src/domain/models.js";
import { LoreError } from "../src/errors.js";
import { pathExists } from "../src/infrastructure/filesystem.js";
import {
  readYamlFile,
  writeYamlFile,
} from "../src/infrastructure/serialization.js";
import {
  applyMigration,
  assertVaultCompatible,
  getMigrationPlan,
} from "../src/services/migration-service.js";
import { addSource } from "../src/services/source-service.js";
import { validateVault } from "../src/services/validation-service.js";
import { initializeVault } from "../src/services/vault-service.js";

describe("Vault 协议迁移", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((targetPath) =>
        rm(targetPath, { recursive: true, force: true }),
      ),
    );
  });

  async function createVersionOneVault(): Promise<{
    root: string;
    pagePath: string;
  }> {
    const root = await mkdtemp(path.join(os.tmpdir(), "lore-migration-vault-"));
    const inputRoot = await mkdtemp(path.join(os.tmpdir(), "lore-migration-input-"));
    temporaryRoots.push(root, inputRoot);
    await initializeVault(root);
    const inputPath = path.join(inputRoot, "legacy.md");
    const content = "旧版知识证据。\n第二行证据。\n";
    await writeFile(inputPath, content, "utf8");
    const added = await addSource(root, inputPath, {
      now: new Date("2026-07-14T13:00:00.000Z"),
    });
    const pagePath = path.join(root, "wiki/pages/legacy-concept.md");
    await writeFile(
      pagePath,
      `---\ntype: concept\ntitle: 旧版知识\nlore:\n  id: con_legacy\n  schema_version: 1\n  status: active\n  evidence:\n    - id: ev_legacy\n      source_id: ${added.source.source_id}\n      snapshot_id: ${added.snapshot.snapshot_id}\n      locator: line:1-2\n---\n\n# 旧版知识\n\n这是旧版页面。\n`,
      "utf8",
    );
    const configPath = path.join(root, VaultFileName.Config);
    const config = await readYamlFile<VaultConfig>(configPath);
    await writeYamlFile(configPath, { ...config, version: 1 });
    const profilePath = path.join(root, "schema/profile.yaml");
    const profile = await readYamlFile<Record<string, unknown>>(profilePath);
    await writeYamlFile(profilePath, {
      version: 1,
      okf_version: profile.okf_version,
      page_types: profile.page_types,
      merge: profile.merge,
      query: { wiki_first: true },
      audit: { require_evidence_for_active_pages: true },
    });
    await rm(path.join(root, "schema", VaultFileName.MigrationHistory));
    return { root, pagePath };
  }

  it("为旧 Vault 生成只读计划并启用版本门禁", async () => {
    const fixture = await createVersionOneVault();
    const before = await readFile(fixture.pagePath, "utf8");

    const plan = await getMigrationPlan(fixture.root);

    expect(plan).toMatchObject({
      current_version: 1,
      target_version: SCHEMA_VERSION,
      required: true,
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ path: "wiki/pages/legacy-concept.md" }),
    );
    expect(await readFile(fixture.pagePath, "utf8")).toBe(before);
    await expect(assertVaultCompatible(fixture.root)).rejects.toMatchObject<
      Partial<LoreError>
    >({ code: ErrorCode.MigrationRequired });
  });

  it("事务升级 Profile、Schema、迁移历史和旧 Evidence", async () => {
    const fixture = await createVersionOneVault();
    const result = await applyMigration(
      fixture.root,
      new Date("2026-07-14T13:30:00.000Z"),
    );

    expect(result.record).toMatchObject({ from_version: 1, to_version: 2 });
    await expect(assertVaultCompatible(fixture.root)).resolves.toBeUndefined();
    const config = await readYamlFile<VaultConfig>(
      path.join(fixture.root, VaultFileName.Config),
    );
    expect(config.version).toBe(SCHEMA_VERSION);
    const profile = await readYamlFile<Record<string, unknown>>(
      path.join(fixture.root, "schema/profile.yaml"),
    );
    expect(profile).toMatchObject({
      version: SCHEMA_VERSION,
      query: { minimum_wiki_score: expect.any(Number) },
      compile: { require_evidence: true },
      audit: { check_duplicate_pages: true },
    });
    expect(await readFile(fixture.pagePath, "utf8")).toMatch(
      /quote_sha256: [a-f0-9]{64}/u,
    );
    const history = await readYamlFile<MigrationHistory>(
      path.join(fixture.root, "schema", VaultFileName.MigrationHistory),
    );
    expect(history.migrations).toHaveLength(1);
    expect(await pathExists(path.join(fixture.root, history.migrations[0]!.backup_path))).toBe(
      true,
    );
    await expect(validateVault(fixture.root)).resolves.toMatchObject({ valid: true });
  });

  it("当前版本重复 apply 保持幂等", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lore-migration-current-"));
    temporaryRoots.push(root);
    await initializeVault(root);

    const result = await applyMigration(root);

    expect(result).toMatchObject({
      plan: { required: false, current_version: SCHEMA_VERSION },
    });
    expect(result.record).toBeUndefined();
  });
});
