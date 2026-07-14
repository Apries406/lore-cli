import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageChannel, WikiPageType } from "../src/domain/enums.js";
import { getDashboardSnapshot } from "../src/services/dashboard-service.js";
import { startDashboardServer } from "../src/services/dashboard-server.js";
import { prepareQuery } from "../src/services/query-service.js";
import { addSource } from "../src/services/source-service.js";
import { listQueryUsageRecords } from "../src/services/usage-service.js";
import { initializeVault } from "../src/services/vault-service.js";

describe("Lore Dashboard 与召回统计", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((targetPath) =>
        rm(targetPath, { recursive: true, force: true }),
      ),
    );
  });

  async function createFixture(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "lore-dashboard-vault-"));
    const inputRoot = await mkdtemp(path.join(os.tmpdir(), "lore-dashboard-input-"));
    temporaryRoots.push(root, inputRoot);
    await initializeVault(root);
    await writeFile(
      path.join(root, "wiki/pages/go-concurrency.md"),
      `---\ntype: ${WikiPageType.Concept}\ntitle: Go 并发模型\ndescription: goroutine 与 channel 通过通信协作。\ntags:\n  - go\n  - concurrency\ntimestamp: 2026-07-01T00:00:00.000Z\n---\n\n# Go 并发模型\n\ngoroutine 使用 channel 交换值。\n`,
      "utf8",
    );
    const sourcePath = path.join(inputRoot, "recovery.md");
    await writeFile(sourcePath, "事务日志用于崩溃恢复。\n", "utf8");
    await addSource(root, sourcePath, {
      title: "崩溃恢复说明",
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    return root;
  }

  it("记录 Agent 查询并聚合热门、冷知识和 Raw 回退", async () => {
    const root = await createFixture();
    const wikiQuery = await prepareQuery(root, "Go 并发模型是什么？", {
      now: new Date("2026-07-14T10:00:00.000Z"),
    });
    const rawQuery = await prepareQuery(root, "事务日志如何用于崩溃恢复？", {
      now: new Date("2026-07-14T11:00:00.000Z"),
    });

    expect(wikiQuery.query_id).toMatch(/^qry_[a-f0-9]+$/u);
    expect(wikiQuery.usage_tracked).toBe(true);
    expect(rawQuery.fallback.used).toBe(true);
    const usage = await listQueryUsageRecords(root);
    expect(usage.ignored).toBe(0);
    expect(usage.records).toHaveLength(2);
    expect(usage.records[0]).toMatchObject({
      channel: UsageChannel.AgentQuery,
      wiki_recalls: [{ path: "wiki/pages/go-concurrency.md", rank: 1 }],
    });
    expect(usage.records[0]?.question).toBeUndefined();

    const snapshot = await getDashboardSnapshot(root, {
      now: new Date("2026-07-14T12:00:00.000Z"),
      window_days: 30,
      cold_after_days: 90,
    });
    expect(snapshot.usage).toMatchObject({
      tracked_queries: 2,
      tracked_queries_window: 2,
      raw_fallback_queries: 1,
      store_question_text: false,
    });
    expect(snapshot.pages[0]).toMatchObject({
      path: "wiki/pages/go-concurrency.md",
      recall_count: 1,
      recall_count_window: 1,
      never_recalled: false,
      cold: false,
    });
    expect(snapshot.sources[0]).toMatchObject({
      title: "崩溃恢复说明",
      recall_count: 1,
      never_recalled: false,
    });
    expect(snapshot.trend.at(-1)).toMatchObject({
      date: "2026-07-14",
      queries: 2,
    });
  });

  it("支持单次关闭统计，并用本机 HTTP 服务展示知识详情", async () => {
    const root = await createFixture();
    const untracked = await prepareQuery(root, "Go 并发模型", {
      track_usage: false,
    });
    expect(untracked.usage_tracked).toBe(false);
    expect((await listQueryUsageRecords(root)).records).toEqual([]);

    const dashboard = await startDashboardServer(root, { port: 0 });
    try {
      const health = await fetch(`${dashboard.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const html = await fetch(dashboard.url);
      expect(await html.text()).toContain("Knowledge Observatory");
      expect(html.headers.get("content-security-policy")).toContain("default-src 'self'");

      const data = await fetch(`${dashboard.url}/api/dashboard?window=7&cold=30`);
      expect(await data.json()).toMatchObject({
        usage: { window_days: 7, cold_after_days: 30 },
        vault: { wiki_pages: 1 },
      });

      const detail = await fetch(
        `${dashboard.url}/api/wiki?path=${encodeURIComponent("wiki/pages/go-concurrency.md")}`,
      );
      expect(await detail.json()).toMatchObject({
        title: "Go 并发模型",
        body: expect.stringContaining("goroutine"),
      });
    } finally {
      await dashboard.close();
    }
  });

  it("拒绝把 Dashboard 暴露到非回环地址", async () => {
    const root = await createFixture();
    await expect(
      startDashboardServer(root, { host: "0.0.0.0", port: 0 }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
});
