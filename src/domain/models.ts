import type {
  AuditDiagnosticCode,
  DiagnosticCode,
  SourceKind,
  SourceStatus,
  SyncPolicy,
  ValidationSeverity,
} from "./enums.js";
import type { CompilationRecord } from "./compile-models.js";

/** 根目录 lore.yaml 的结构。字段名属于持久化协议。 */
export interface VaultConfig {
  version: number;
  name: string;
  raw_dir: string;
  wiki_dir: string;
  schema_dir: string;
  runtime_dir: string;
  profile: string;
}

/** 一个稳定来源的元数据；内容版本存放在 Snapshot 中。 */
export interface SourceMetadata {
  version: number;
  source_id: string;
  kind: SourceKind;
  canonical_uri: string;
  title: string;
  status: SourceStatus;
  sync_policy: SyncPolicy;
  created_at: string;
}

/** 一份不可变来源快照的清单。 */
export interface SnapshotManifest {
  version: number;
  snapshot_id: string;
  source_id: string;
  captured_at: string;
  media_type: string;
  content_path: string;
  content_sha256: string;
  collector: string;
}

/** 指向某个 Source 最新 Snapshot 的可变指针。 */
export interface LatestSnapshotPointer {
  version: number;
  source_id: string;
  snapshot_id: string;
  updated_at: string;
}

/** 采集或同步来源后的结构化结果。 */
export interface AddSourceResult {
  source: SourceMetadata;
  snapshot: SnapshotManifest;
  source_created: boolean;
  snapshot_created: boolean;
}

/** Source 的 Snapshot 与编译记录历史。 */
export interface SourceHistory {
  source: SourceMetadata;
  latest: LatestSnapshotPointer;
  snapshots: SnapshotManifest[];
  compilations: CompilationRecord[];
}

/** Source 对 Wiki 页面和编译账本的可追溯影响。 */
export interface SourceImpact {
  source_id: string;
  wiki_pages: Array<{
    path: string;
    evidence_ids: string[];
  }>;
  compilation_runs: string[];
}

/** 单条机器可读校验诊断。 */
export interface ValidationDiagnostic {
  severity: ValidationSeverity;
  code: DiagnosticCode;
  path: string;
  message: string;
}

/** 一次完整 Vault 校验的汇总结果。 */
export interface ValidationReport {
  valid: boolean;
  errors: number;
  warnings: number;
  diagnostics: ValidationDiagnostic[];
}

/** `lore status` 输出的最小健康状态。 */
export interface VaultStatus {
  root: string;
  sources: number;
  snapshots: number;
  wiki_pages: number;
  validation: {
    valid: boolean;
    errors: number;
    warnings: number;
  };
}

/** 一条长期健康审计诊断。 */
export interface AuditDiagnostic {
  severity: ValidationSeverity;
  code: AuditDiagnosticCode;
  path: string;
  message: string;
}

/** Raw、Wiki 和运行状态的覆盖率统计。 */
export interface AuditCoverage {
  sources: number;
  snapshots: number;
  latest_snapshots_compiled: number;
  wiki_pages: number;
  pages_with_evidence: number;
  incomplete_compile_runs: number;
}

/** `lore audit` 的完整结果。 */
export interface AuditReport {
  healthy: boolean;
  errors: number;
  warnings: number;
  validation: ValidationReport;
  coverage: AuditCoverage;
  diagnostics: AuditDiagnostic[];
}
