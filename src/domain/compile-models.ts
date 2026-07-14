import type {
  CandidateMatchReason,
  ChangeAction,
  CompileRunStatus,
  ConfidenceLevel,
  KnowledgeOperation,
  KnowledgeStatus,
  WikiPageType,
} from "./enums.js";
import type { SnapshotManifest, SourceMetadata } from "./models.js";

/** 编译所基于的 Wiki 版本；git_head 只是辅助信息。 */
export interface WikiBaseRevision {
  wiki_sha256: string;
  git_head?: string;
}

/** 一条可回溯到不可变 Snapshot 的证据。 */
export interface EvidenceReference {
  id: string;
  source_id: string;
  snapshot_id: string;
  locator: string;
  quote_sha256: string;
}

/** Lore 扩展 frontmatter。 */
export interface LoreConceptMetadata {
  id?: string;
  schema_version?: number;
  status?: KnowledgeStatus;
  confidence?: ConfidenceLevel;
  merge_key?: string;
  evidence?: EvidenceReference[];
  supersedes?: string[];
  superseded_by?: string;
}

/** Skill 输出的结构化 Concept，而不是任意 Markdown Patch。 */
export interface ConceptDraft {
  type: WikiPageType;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string;
  lore?: LoreConceptMetadata;
  body: string;
}

/** 与当前 Raw Source 相关的候选 Wiki 页面。 */
export interface CompileCandidate {
  path: string;
  content_sha256: string;
  score: number;
  match_reasons: CandidateMatchReason[];
  frontmatter: Record<string, unknown>;
  body: string;
}

/** CLI 生成、供 Skill 只读消费的编译包。 */
export interface CompilePacket {
  version: number;
  run_id: string;
  operation: KnowledgeOperation.Compile;
  vault: {
    root: string;
    base_revision: WikiBaseRevision;
    schema_version: number;
  };
  input: {
    source: SourceMetadata;
    snapshot: SnapshotManifest;
    content: string;
  };
  candidates: CompileCandidate[];
  policies: {
    allowed_page_types: WikiPageType[];
    max_candidate_pages: number;
    max_changes: number;
    max_new_pages: number;
    require_evidence: boolean;
    require_review: boolean;
    upsert_first: boolean;
  };
}

/** Change Set 中的输入快照引用。 */
export interface CompileInputReference {
  source_id: string;
  snapshot_id: string;
}

/** Create 与 Update 共用的目标描述。 */
export interface ConceptChangeTarget {
  path: string;
  expected_sha256?: string;
}

/** Skill 提议的单页变更。 */
export interface ConceptChange {
  action: ChangeAction;
  target: ConceptChangeTarget;
  concept: ConceptDraft;
  reason: string;
}

/** Skill 提交给 CLI 的唯一可写中间表示。 */
export interface ChangeSet {
  version: number;
  run_id: string;
  base_revision: WikiBaseRevision;
  operation: KnowledgeOperation.Compile;
  inputs: CompileInputReference[];
  summary: string;
  questions?: string[];
  changes: ConceptChange[];
}

/** `.lore/runs/<run_id>/run.yaml` 的状态记录。 */
export interface CompileRun {
  version: number;
  run_id: string;
  operation: KnowledgeOperation.Compile;
  status: CompileRunStatus;
  source_id: string;
  snapshot_id: string;
  base_revision: WikiBaseRevision;
  created_at: string;
  updated_at: string;
  applied_revision?: WikiBaseRevision;
  message?: string;
}

/** submit 阶段生成的结构化校验结果。 */
export interface CompileValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Apply 后写入 Raw Source sidecar 的持久记录。 */
export interface CompilationRecord {
  version: number;
  run_id: string;
  status: CompileRunStatus.Applied | CompileRunStatus.RolledBack;
  source_id: string;
  snapshot_id: string;
  applied_at: string;
  wiki_revision_before: string;
  wiki_revision_after: string;
  changes: Array<{
    action: ChangeAction;
    path: string;
    content_sha256: string;
  }>;
}
