import type {
  DiagnosticCode,
  SourceKind,
  SourceStatus,
  SyncPolicy,
  ValidationSeverity,
} from "./enums.js";

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
