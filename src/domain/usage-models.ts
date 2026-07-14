import type { UsageChannel } from "./enums.js";

/** 一次查询中被确定性召回的 Wiki 页面。 */
export interface WikiRecall {
  path: string;
  title: string;
  rank: number;
  score: number;
}

/** 一次查询中因 Wiki 证据不足而召回的 Raw 来源。 */
export interface RawRecall {
  source_id: string;
  source_title: string;
  snapshot_id: string;
  rank: number;
  score: number;
}

/** Vault 内的本地查询使用记录；默认只保存问题哈希，不保存原始问题。 */
export interface QueryUsageRecord {
  version: number;
  query_id: string;
  channel: UsageChannel;
  occurred_at: string;
  question_sha256: string;
  question?: string;
  wiki_recalls: WikiRecall[];
  raw_recalls: RawRecall[];
  fallback_used: boolean;
}

/** 用户可在 Profile 中调整的使用统计策略。 */
export interface UsagePolicy {
  tracking_enabled: boolean;
  store_question_text: boolean;
  cold_after_days: number;
}

/** Dashboard 中的单个规范知识页面及其召回热度。 */
export interface DashboardWikiPage {
  path: string;
  title: string;
  page_type: string;
  status: string;
  confidence?: string;
  description?: string;
  tags: string[];
  timestamp?: string;
  evidence_count: number;
  recall_count: number;
  recall_count_window: number;
  last_recalled_at?: string;
  never_recalled: boolean;
  cold: boolean;
}

/** Dashboard 中的 Raw 来源及其回退召回热度。 */
export interface DashboardSource {
  source_id: string;
  title: string;
  kind: string;
  status: string;
  created_at: string;
  latest_snapshot_id: string;
  latest_updated_at: string;
  recall_count: number;
  recall_count_window: number;
  last_recalled_at?: string;
  never_recalled: boolean;
  cold: boolean;
}

/** 最近一次 Agent 查询的隐私安全摘要。 */
export interface DashboardRecentQuery {
  query_id: string;
  occurred_at: string;
  question_sha256: string;
  question?: string;
  wiki_recall_count: number;
  raw_recall_count: number;
  fallback_used: boolean;
}

/** 单日召回趋势。 */
export interface DashboardTrendPoint {
  date: string;
  queries: number;
  wiki_recalls: number;
  raw_recalls: number;
}

/** Web Dashboard 的稳定 JSON 数据模型。 */
export interface DashboardSnapshot {
  generated_at: string;
  vault: {
    root: string;
    sources: number;
    snapshots: number;
    wiki_pages: number;
    valid: boolean;
    audit_healthy: boolean;
  };
  usage: {
    tracking_enabled: boolean;
    store_question_text: boolean;
    window_days: number;
    cold_after_days: number;
    tracked_queries: number;
    tracked_queries_window: number;
    raw_fallback_queries: number;
    first_tracked_at?: string;
    last_tracked_at?: string;
  };
  pages: DashboardWikiPage[];
  sources: DashboardSource[];
  recent_queries: DashboardRecentQuery[];
  trend: DashboardTrendPoint[];
  ignored_usage_records: number;
}
