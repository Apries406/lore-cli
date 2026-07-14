import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ErrorCode,
  RawFallbackMode,
  RawFallbackReason,
  SearchMatchField,
  WikiPageType,
} from "../src/domain/enums.js";
import { LoreError } from "../src/errors.js";
import { addSource } from "../src/services/source-service.js";
import {
  prepareQuery,
  showWikiPage,
} from "../src/services/query-service.js";
import { searchWiki } from "../src/services/wiki-service.js";
import { initializeVault } from "../src/services/vault-service.js";

describe("Wiki-first 知识查询", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((targetPath) =>
        rm(targetPath, { recursive: true, force: true }),
      ),
    );
  });

  async function createFixture(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "lore-query-vault-"));
    const inputRoot = await mkdtemp(path.join(os.tmpdir(), "lore-query-input-"));
    temporaryRoots.push(root, inputRoot);
    await initializeVault(root);
    await writeFile(
      path.join(root, "wiki/pages/lore-knowledge-model.md"),
      `---\ntype: ${WikiPageType.Concept}\ntitle: Lore 双层知识模型\ndescription: Raw 保存证据，Wiki 保存规范知识。\ntags:\n  - lore\n  - knowledge-model\n---\n\n# Lore 双层知识模型\n\nRaw 层不可变，Wiki 层通过受控编译持续演进。\n`,
      "utf8",
    );
    const rawPath = path.join(inputRoot, "recovery.md");
    await writeFile(
      rawPath,
      "Lore 进程崩溃后应读取事务日志。\n恢复程序需要识别过期锁。\n",
      "utf8",
    );
    await addSource(root, rawPath, {
      now: new Date("2026-07-14T10:00:00.000Z"),
    });
    return root;
  }

  it("用字段加权检索返回完整 Wiki 页面", async () => {
    const root = await createFixture();
    const results = await searchWiki(root, "Lore 双层知识模型", 5);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path: "wiki/pages/lore-knowledge-model.md",
      title: "Lore 双层知识模型",
    });
    expect(results[0]?.score).toBeGreaterThan(4);
    expect(results[0]?.match_fields).toContain(SearchMatchField.Title);
    expect(results[0]?.body).toContain("Raw 层不可变");
  });

  it("Wiki 证据充分时不读取 Raw 回退结果", async () => {
    const root = await createFixture();
    const packet = await prepareQuery(root, "Lore 双层知识模型是什么？", {
      now: new Date("2026-07-14T10:01:00.000Z"),
    });

    expect(packet.wiki_candidates).toHaveLength(1);
    expect(packet.raw_evidence).toEqual([]);
    expect(packet.fallback).toEqual({
      used: false,
      reason: RawFallbackReason.WikiEvidenceSufficient,
    });
  });

  it("Wiki 无候选时回退 latest Raw Snapshot 并返回逐行证据", async () => {
    const root = await createFixture();
    const packet = await prepareQuery(root, "事务日志如何帮助崩溃恢复？", {
      now: new Date("2026-07-14T10:01:00.000Z"),
    });

    expect(packet.wiki_candidates).toEqual([]);
    expect(packet.fallback).toEqual({
      used: true,
      reason: RawFallbackReason.NoWikiCandidate,
    });
    expect(packet.raw_evidence[0]).toMatchObject({ locator: "line:1-2" });
    expect(packet.raw_evidence[0]?.quote).toContain("事务日志");
    expect(packet.raw_evidence[0]?.quote_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(packet.raw_evidence[0]?.uri).toMatch(/^lore:\/\/source\//u);
  });

  it("允许显式禁止 Raw 回退，并拒绝越界 Wiki 路径", async () => {
    const root = await createFixture();
    const packet = await prepareQuery(root, "事务日志如何恢复？", {
      fallback_mode: RawFallbackMode.Never,
    });

    expect(packet.raw_evidence).toEqual([]);
    expect(packet.fallback.reason).toBe(RawFallbackReason.Disabled);
    await expect(showWikiPage(root, "raw/sources/secret.md")).rejects.toMatchObject<
      Partial<LoreError>
    >({ code: ErrorCode.InvalidArgument });
  });
});
