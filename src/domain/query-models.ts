import type {
  RawFallbackMode,
  RawFallbackReason,
  SearchMatchField,
} from "./enums.js";
import type { WikiBaseRevision } from "./compile-models.js";

/** 一个带完整正文的 Wiki 检索候选，供查询 Skill 进行语义回答。 */
export interface WikiSearchResult {
  path: string;
  title: string;
  page_type: string;
  description?: string;
  tags: string[];
  score: number;
  match_fields: SearchMatchField[];
  excerpt: string;
  content_sha256: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** 从不可变 Raw Snapshot 中召回的一段逐行证据。 */
export interface RawQueryEvidence {
  source_id: string;
  source_title: string;
  snapshot_id: string;
  locator: string;
  quote: string;
  quote_sha256: string;
  score: number;
  uri: string;
}

/** 查询阶段实际采用的 Wiki-first 与 Raw 回退策略。 */
export interface QueryPolicySnapshot {
  wiki_first: boolean;
  fallback_mode: RawFallbackMode;
  minimum_wiki_score: number;
  max_wiki_results: number;
  max_raw_results: number;
}

/** CLI 生成、供查询 Skill 只读消费的上下文包。 */
export interface QueryPacket {
  version: number;
  question: string;
  created_at: string;
  wiki_revision: WikiBaseRevision;
  policy: QueryPolicySnapshot;
  wiki_candidates: WikiSearchResult[];
  raw_evidence: RawQueryEvidence[];
  fallback: {
    used: boolean;
    reason: RawFallbackReason;
  };
}
