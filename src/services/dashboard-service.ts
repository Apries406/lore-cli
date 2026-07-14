import {
  DEFAULT_COLD_KNOWLEDGE_DAYS,
  DEFAULT_DASHBOARD_WINDOW_DAYS,
  MILLISECONDS_PER_DAY,
} from "../domain/constants.js";
import { KnowledgeStatus } from "../domain/enums.js";
import type {
  DashboardRecentQuery,
  DashboardSnapshot,
  DashboardSource,
  DashboardTrendPoint,
  DashboardWikiPage,
} from "../domain/usage-models.js";
import { listSources, showSource } from "./source-service.js";
import { getVaultStatus } from "./status-service.js";
import { listQueryUsageRecords, readUsagePolicy } from "./usage-service.js";
import { listWikiPages } from "./wiki-service.js";

export interface DashboardSnapshotOptions {
  window_days?: number;
  cold_after_days?: number;
  now?: Date;
}

interface RecallMetric {
  total: number;
  window: number;
  last?: string;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function updateRecallMetric(
  metrics: Map<string, RecallMetric>,
  key: string,
  occurredAt: string,
  windowStart: number,
): void {
  const current = metrics.get(key) ?? { total: 0, window: 0 };
  current.total += 1;
  if (Date.parse(occurredAt) >= windowStart) {
    current.window += 1;
  }
  if (!current.last || occurredAt > current.last) {
    current.last = occurredAt;
  }
  metrics.set(key, current);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function loreMetadata(frontmatter: Record<string, unknown>): Record<string, unknown> {
  return frontmatter.lore &&
    typeof frontmatter.lore === "object" &&
    !Array.isArray(frontmatter.lore)
    ? (frontmatter.lore as Record<string, unknown>)
    : {};
}

function isCold(last: string | undefined, coldStart: number): boolean {
  return last === undefined || Date.parse(last) < coldStart;
}

/** 聚合 Vault 结构、健康状态和本地召回事件，生成 Dashboard 的只读快照。 */
export async function getDashboardSnapshot(
  root: string,
  options: DashboardSnapshotOptions = {},
): Promise<DashboardSnapshot> {
  const now = options.now ?? new Date();
  const usagePolicy = await readUsagePolicy(root);
  const windowDays = positiveInteger(
    options.window_days,
    DEFAULT_DASHBOARD_WINDOW_DAYS,
  );
  const coldAfterDays = positiveInteger(
    options.cold_after_days,
    usagePolicy.cold_after_days || DEFAULT_COLD_KNOWLEDGE_DAYS,
  );
  const windowStart = now.getTime() - windowDays * MILLISECONDS_PER_DAY;
  const coldStart = now.getTime() - coldAfterDays * MILLISECONDS_PER_DAY;
  const [status, wikiPages, sourceMetadata, usageCollection] = await Promise.all([
    getVaultStatus(root),
    listWikiPages(root),
    listSources(root),
    listQueryUsageRecords(root),
  ]);

  const pageMetrics = new Map<string, RecallMetric>();
  const sourceMetrics = new Map<string, RecallMetric>();
  const trendByDate = new Map<string, DashboardTrendPoint>();
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getTime() - offset * MILLISECONDS_PER_DAY)
      .toISOString()
      .slice(0, 10);
    trendByDate.set(date, { date, queries: 0, wiki_recalls: 0, raw_recalls: 0 });
  }

  for (const record of usageCollection.records) {
    const eventTime = Date.parse(record.occurred_at);
    const inWindow = eventTime >= windowStart;
    if (inWindow) {
      const date = record.occurred_at.slice(0, 10);
      const point = trendByDate.get(date);
      if (point) {
        point.queries += 1;
        point.wiki_recalls += record.wiki_recalls.length;
        point.raw_recalls += record.raw_recalls.length;
      }
    }
    for (const recall of record.wiki_recalls) {
      updateRecallMetric(pageMetrics, recall.path, record.occurred_at, windowStart);
    }
    for (const recall of record.raw_recalls) {
      updateRecallMetric(
        sourceMetrics,
        recall.source_id,
        record.occurred_at,
        windowStart,
      );
    }
  }

  const pages: DashboardWikiPage[] = wikiPages
    .map((page) => {
      const lore = loreMetadata(page.frontmatter);
      const metric = pageMetrics.get(page.path) ?? { total: 0, window: 0 };
      const tags = Array.isArray(page.frontmatter.tags)
        ? page.frontmatter.tags.filter((item): item is string => typeof item === "string")
        : [];
      const evidence = Array.isArray(lore.evidence) ? lore.evidence : [];
      const last = metric.last;
      const confidence = stringValue(lore.confidence);
      const description = stringValue(page.frontmatter.description);
      const timestamp = stringValue(page.frontmatter.timestamp);
      return {
        path: page.path,
        title: stringValue(page.frontmatter.title) ?? page.path,
        page_type: stringValue(page.frontmatter.type) ?? "concept",
        status: stringValue(lore.status) ?? KnowledgeStatus.Active,
        ...(confidence ? { confidence } : {}),
        ...(description ? { description } : {}),
        tags,
        ...(timestamp ? { timestamp } : {}),
        evidence_count: evidence.length,
        recall_count: metric.total,
        recall_count_window: metric.window,
        ...(last ? { last_recalled_at: last } : {}),
        never_recalled: metric.total === 0,
        cold: isCold(last, coldStart),
      };
    })
    .sort(
      (left, right) =>
        right.recall_count_window - left.recall_count_window ||
        right.recall_count - left.recall_count ||
        left.title.localeCompare(right.title),
    );

  const sourceDetails = await Promise.all(
    sourceMetadata.map((source) => showSource(root, source.source_id)),
  );
  const sources: DashboardSource[] = sourceDetails
    .map(({ source, latest }) => {
      const metric = sourceMetrics.get(source.source_id) ?? { total: 0, window: 0 };
      const last = metric.last;
      return {
        source_id: source.source_id,
        title: source.title,
        kind: source.kind,
        status: source.status,
        created_at: source.created_at,
        latest_snapshot_id: latest.snapshot_id,
        latest_updated_at: latest.updated_at,
        recall_count: metric.total,
        recall_count_window: metric.window,
        ...(last ? { last_recalled_at: last } : {}),
        never_recalled: metric.total === 0,
        cold: isCold(last, coldStart),
      };
    })
    .sort(
      (left, right) =>
        right.recall_count_window - left.recall_count_window ||
        left.title.localeCompare(right.title),
    );

  const recentQueries: DashboardRecentQuery[] = usageCollection.records
    .slice()
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))
    .slice(0, 50)
    .map((record) => ({
      query_id: record.query_id,
      occurred_at: record.occurred_at,
      question_sha256: record.question_sha256,
      ...(record.question ? { question: record.question } : {}),
      wiki_recall_count: record.wiki_recalls.length,
      raw_recall_count: record.raw_recalls.length,
      fallback_used: record.fallback_used,
    }));
  const firstRecord = usageCollection.records[0];
  const lastRecord = usageCollection.records.at(-1);

  return {
    generated_at: now.toISOString(),
    vault: {
      root: status.root,
      sources: status.sources,
      snapshots: status.snapshots,
      wiki_pages: status.wiki_pages,
      valid: status.validation.valid,
      audit_healthy: status.audit.healthy,
    },
    usage: {
      tracking_enabled: usagePolicy.tracking_enabled,
      store_question_text: usagePolicy.store_question_text,
      window_days: windowDays,
      cold_after_days: coldAfterDays,
      tracked_queries: usageCollection.records.length,
      tracked_queries_window: usageCollection.records.filter(
        (record) => Date.parse(record.occurred_at) >= windowStart,
      ).length,
      raw_fallback_queries: usageCollection.records.filter(
        (record) => record.fallback_used,
      ).length,
      ...(firstRecord ? { first_tracked_at: firstRecord.occurred_at } : {}),
      ...(lastRecord ? { last_tracked_at: lastRecord.occurred_at } : {}),
    },
    pages,
    sources,
    recent_queries: recentQueries,
    trend: [...trendByDate.values()],
    ignored_usage_records: usageCollection.ignored,
  };
}
