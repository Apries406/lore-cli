/**
 * Lore 领域枚举。
 *
 * 注意：枚举值会被写入目录、YAML、JSON 或 CLI 输出，属于持久化协议，
 * 必须保持稳定，不能仅为了界面中文化而翻译。
 */

/** 知识库内具有固定语义的目录名。 */
export enum DirectoryName {
  Raw = "raw",
  Sources = "sources",
  Snapshots = "snapshots",
  Assets = "assets",
  Wiki = "wiki",
  Pages = "pages",
  Schema = "schema",
  Runtime = ".lore",
  Runs = "runs",
  Staging = "staging",
  Backup = "backup",
  RollbackBackup = "rollback-backup",
  Compilations = "compilations",
  Migrations = "migrations",
  SourceTransactions = "source-transactions",
}

/** 知识库内具有固定语义的文件名。 */
export enum VaultFileName {
  Config = "lore.yaml",
  GitIgnore = ".gitignore",
  LoreIgnore = ".loreignore",
  Index = "index.md",
  Log = "log.md",
  Profile = "profile.yaml",
  ConceptSchema = "concept.schema.json",
  SourceSchema = "source.schema.json",
  ChangeSetSchema = "change-set.schema.json",
  AgentInstructions = "AGENTS.md",
  SourceMetadata = "source.yaml",
  LatestSnapshot = "latest.yaml",
  SnapshotManifest = "manifest.yaml",
  CompileRun = "run.yaml",
  CompilePacket = "packet.yaml",
  CompileProposal = "proposal.yaml",
  CompileValidation = "validation.yaml",
  CompileDiff = "diff.patch",
  CompileLock = "compile.lock",
  MigrationLock = "migration.lock",
  MutationLock = "mutation.lock",
  TransactionJournal = "transaction.yaml",
  CompilationRecord = "compilation.yaml",
  MigrationHistory = "migrations.yaml",
}

/** 原始来源类型；尚未实现的类型仍保留为可演进协议值。 */
export enum SourceKind {
  File = "file",
  Text = "text",
  Directory = "directory",
  Web = "web",
  LarkDocument = "lark_doc",
  LarkChat = "lark_chat",
  GitRepository = "git",
  GitDiff = "git_diff",
}

/** 来源生命周期状态。删除默认采用逻辑删除，以保留历史可解释性。 */
export enum SourceStatus {
  Active = "active",
  Tombstoned = "tombstoned",
}

/** 来源同步策略。 */
export enum SyncPolicy {
  Manual = "manual",
  Scheduled = "scheduled",
}

/** Source 生命周期变更动作。 */
export enum SourceLifecycleAction {
  Tombstone = "tombstone",
  Restore = "restore",
}

/** 采集前高置信度敏感内容分类。 */
export enum SensitiveContentKind {
  PrivateKey = "private_key",
  AwsAccessKey = "aws_access_key",
  GithubToken = "github_token",
  OpenAiKey = "openai_key",
}

/** Lore Profile 约束的 Wiki 页面类型。OKF 读取端仍应宽容未知类型。 */
export enum WikiPageType {
  Concept = "concept",
  Entity = "entity",
  Decision = "decision",
  Playbook = "playbook",
  Pattern = "pattern",
  Synthesis = "synthesis",
}

/** 编译知识的生命周期状态。 */
export enum KnowledgeStatus {
  Draft = "draft",
  Active = "active",
  Stale = "stale",
  Superseded = "superseded",
}

/** 知识结论的置信度等级。 */
export enum ConfidenceLevel {
  Low = "low",
  Medium = "medium",
  High = "high",
}

/** Change Set 允许执行的页面变更动作。 */
export enum ChangeAction {
  Create = "create",
  Update = "update",
  Supersede = "supersede",
  Retire = "retire",
}

/** 会产生 Change Set 的语义操作。 */
export enum KnowledgeOperation {
  Compile = "compile",
  Promote = "promote",
}

/** 一次知识编译任务的生命周期状态。 */
export enum CompileRunStatus {
  Prepared = "prepared",
  Proposed = "proposed",
  NeedsInput = "needs_input",
  Validated = "validated",
  Applied = "applied",
  Rejected = "rejected",
  Conflict = "conflict",
  Failed = "failed",
  RolledBack = "rolled_back",
}

/** 候选 Wiki 页面被召回的原因。 */
export enum CandidateMatchReason {
  Title = "title",
  Tag = "tag",
  Body = "body",
  ExistingEvidence = "existing_evidence",
}

/** Wiki 搜索结果命中的结构化字段。 */
export enum SearchMatchField {
  Title = "title",
  Tag = "tag",
  Description = "description",
  Body = "body",
}

/** 查询阶段对 Raw Source 的回退控制。 */
export enum RawFallbackMode {
  Auto = "auto",
  Always = "always",
  Never = "never",
}

/** Query Packet 中记录的 Raw 回退原因。 */
export enum RawFallbackReason {
  Disabled = "disabled",
  Forced = "forced",
  NoWikiCandidate = "no_wiki_candidate",
  WikiEvidenceInsufficient = "wiki_evidence_insufficient",
  WikiEvidenceSufficient = "wiki_evidence_sufficient",
}

/** 页面归并策略。 */
export enum MergeStrategy {
  UpsertFirst = "upsert_first",
}

/** 查询过程中回退 Raw Sources 的策略。 */
export enum QueryFallbackPolicy {
  WhenEvidenceIsInsufficient = "when_evidence_is_insufficient",
}

/** 校验诊断级别；只有 Error 会让校验失败。 */
export enum ValidationSeverity {
  Error = "error",
  Warning = "warning",
}

/** 稳定的机器可读诊断码。 */
export enum DiagnosticCode {
  MissingPath = "missing_path",
  InvalidYaml = "invalid_yaml",
  InvalidJsonSchema = "invalid_json_schema",
  MissingFrontmatter = "missing_frontmatter",
  InvalidFrontmatter = "invalid_frontmatter",
  InvalidConcept = "invalid_concept",
  InvalidSource = "invalid_source",
  InvalidSnapshot = "invalid_snapshot",
  InvalidLatestPointer = "invalid_latest_pointer",
  IdentityMismatch = "identity_mismatch",
  MissingSnapshotContent = "missing_snapshot_content",
  SnapshotChecksumMismatch = "snapshot_checksum_mismatch",
  BrokenLink = "broken_link",
}

/** `lore audit` 使用的长期健康诊断码。 */
export enum AuditDiagnosticCode {
  MissingEvidence = "missing_evidence",
  EvidenceSourceMissing = "evidence_source_missing",
  EvidenceSnapshotMissing = "evidence_snapshot_missing",
  EvidenceLocatorInvalid = "evidence_locator_invalid",
  EvidenceChecksumMismatch = "evidence_checksum_mismatch",
  EvidenceNotLatest = "evidence_not_latest",
  DuplicateConceptId = "duplicate_concept_id",
  DuplicateMergeKey = "duplicate_merge_key",
  DuplicateTitle = "duplicate_title",
  DuplicatePageContent = "duplicate_page_content",
  OrphanPage = "orphan_page",
  UncompiledLatestSnapshot = "uncompiled_latest_snapshot",
  StaleSource = "stale_source",
  IncompleteCompileRun = "incomplete_compile_run",
  EvidenceSourceTombstoned = "evidence_source_tombstoned",
  SupersededTargetMissing = "superseded_target_missing",
  SupersedesTargetMissing = "supersedes_target_missing",
}

/** CLI 输出模式。 */
export enum OutputFormat {
  Human = "human",
  Json = "json",
}

/** 稳定的机器可读业务错误码。 */
export enum ErrorCode {
  InvalidArgument = "invalid_argument",
  VaultNotFound = "vault_not_found",
  VaultAlreadyExists = "vault_already_exists",
  PathEscapesVault = "path_escapes_vault",
  SourceNotFound = "source_not_found",
  UnsupportedSourceKind = "unsupported_source_kind",
  ValidationFailed = "validation_failed",
  Conflict = "conflict",
  AlreadyCompiled = "already_compiled",
  CompileRunNotFound = "compile_run_not_found",
  InvalidRunState = "invalid_run_state",
  InvalidChangeSet = "invalid_change_set",
  CompileLockHeld = "compile_lock_held",
  MigrationRequired = "migration_required",
  UnsupportedVaultVersion = "unsupported_vault_version",
  MigrationFailed = "migration_failed",
  SensitiveContentDetected = "sensitive_content_detected",
  IgnoredSource = "ignored_source",
  MutationLockHeld = "mutation_lock_held",
  RecoveryRequired = "recovery_required",
  Internal = "internal",
}

/** CLI 退出码，供脚本和 Skill 判断失败类型。 */
export enum ExitCode {
  Success = 0,
  InvalidArgument = 2,
  NotFound = 3,
  Conflict = 4,
  ValidationFailed = 5,
  Internal = 1,
}

/** 会修改 Vault 持久状态的互斥操作。 */
export enum MutationOperation {
  CompileApply = "compile_apply",
  Migration = "migration",
  SourceUpdate = "source_update",
}

/** 可恢复事务日志状态。 */
export enum TransactionStatus {
  Prepared = "prepared",
  Committed = "committed",
  Recovered = "recovered",
}

/** Snapshot 内容的标准 MIME 类型。 */
export enum MediaType {
  Markdown = "text/markdown",
  PlainText = "text/plain",
  Json = "application/json",
  Yaml = "application/yaml",
  Html = "text/html",
  Csv = "text/csv",
  Binary = "application/octet-stream",
}
