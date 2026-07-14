import path from "node:path";
import {
  DEFAULT_RUN_STALE_AFTER_HOURS,
  DEFAULT_SOURCE_STALE_AFTER_DAYS,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_HOUR,
  TEXT_ENCODING,
} from "../domain/constants.js";
import type {
  CompilationRecord,
  CompileRun,
  EvidenceReference,
} from "../domain/compile-models.js";
import {
  AuditDiagnosticCode,
  CompileRunStatus,
  DirectoryName,
  KnowledgeStatus,
  SourceStatus,
  ValidationSeverity,
  VaultFileName,
} from "../domain/enums.js";
import type {
  AuditDiagnostic,
  AuditReport,
  LatestSnapshotPointer,
  SnapshotManifest,
  SourceMetadata,
} from "../domain/models.js";
import { pathExists, safeJoin } from "../infrastructure/filesystem.js";
import { readYamlFile } from "../infrastructure/serialization.js";
import { walkFiles } from "../infrastructure/walk.js";
import { evidenceQuoteSha256 } from "./compile-service.js";
import {
  listSources,
  readSourceSnapshot,
  showSource,
} from "./source-service.js";
import { validateVault } from "./validation-service.js";
import { listWikiPages, type WikiPage } from "./wiki-service.js";

interface AuditPolicy {
  require_evidence_for_active_pages: boolean;
  check_orphan_pages: boolean;
  check_duplicate_pages: boolean;
  check_uncompiled_latest_snapshots: boolean;
  stale_source_after_days: number;
  stale_run_after_hours: number;
}

const TERMINAL_RUN_STATUSES = new Set<CompileRunStatus>([
  CompileRunStatus.Applied,
  CompileRunStatus.Rejected,
  CompileRunStatus.RolledBack,
]);

/** 创建统一的审计诊断。 */
function diagnostic(
  severity: ValidationSeverity,
  code: AuditDiagnosticCode,
  targetPath: string,
  message: string,
): AuditDiagnostic {
  return { severity, code, path: targetPath, message };
}

/** 将 Profile 数值收敛为非零正数。 */
function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/** 读取长期健康策略，缺失项使用稳定默认值。 */
async function readAuditPolicy(root: string): Promise<AuditPolicy> {
  const profile = await readYamlFile<Record<string, unknown>>(
    safeJoin(root, DirectoryName.Schema, VaultFileName.Profile),
  ).catch((): Record<string, unknown> => ({}));
  const audit =
    profile.audit && typeof profile.audit === "object" && !Array.isArray(profile.audit)
      ? (profile.audit as Record<string, unknown>)
      : {};
  return {
    require_evidence_for_active_pages:
      audit.require_evidence_for_active_pages !== false,
    check_orphan_pages: audit.check_orphan_pages !== false,
    check_duplicate_pages: audit.check_duplicate_pages !== false,
    check_uncompiled_latest_snapshots:
      audit.check_uncompiled_latest_snapshots !== false,
    stale_source_after_days: positiveNumber(
      audit.stale_source_after_days,
      DEFAULT_SOURCE_STALE_AFTER_DAYS,
    ),
    stale_run_after_hours: positiveNumber(
      audit.stale_run_after_hours,
      DEFAULT_RUN_STALE_AFTER_HOURS,
    ),
  };
}

/** 安全读取 Lore frontmatter 对象。 */
function loreMetadata(page: WikiPage): Record<string, unknown> {
  const lore = page.frontmatter.lore;
  return lore && typeof lore === "object" && !Array.isArray(lore)
    ? (lore as Record<string, unknown>)
    : {};
}

/** 从通过 Schema 校验的页面提取 Evidence；损坏项留给基础校验报告。 */
function pageEvidence(page: WikiPage): EvidenceReference[] {
  const evidence = loreMetadata(page).evidence;
  return Array.isArray(evidence)
    ? evidence.filter(
        (item): item is EvidenceReference =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

/** 报告某个字段在多个页面中使用相同值。 */
function auditDuplicateField(
  pages: WikiPage[],
  diagnostics: AuditDiagnostic[],
  field: "id" | "merge_key",
  code: AuditDiagnosticCode,
): void {
  const pathsByValue = new Map<string, string[]>();
  for (const page of pages) {
    const value = loreMetadata(page)[field];
    if (typeof value === "string" && value.length > 0) {
      pathsByValue.set(value, [...(pathsByValue.get(value) ?? []), page.path]);
    }
  }
  for (const [value, paths] of pathsByValue) {
    if (paths.length < 2) {
      continue;
    }
    for (const pagePath of paths) {
      diagnostics.push(
        diagnostic(
          ValidationSeverity.Error,
          code,
          pagePath,
          `字段 lore.${field} '${value}' 同时出现在：${paths.join("、")}`,
        ),
      );
    }
  }
}

/** 报告重复标题与完全相同正文，防止知识库悄然分叉。 */
function auditDuplicatePages(
  pages: WikiPage[],
  diagnostics: AuditDiagnostic[],
): void {
  const pathsByTitle = new Map<string, string[]>();
  const pathsByContent = new Map<string, string[]>();
  for (const page of pages) {
    const title = page.frontmatter.title;
    if (typeof title === "string" && title.trim().length > 0) {
      const normalized = title.trim().toLocaleLowerCase().normalize("NFKC");
      pathsByTitle.set(normalized, [...(pathsByTitle.get(normalized) ?? []), page.path]);
    }
    const normalizedBody = page.body.trim().replaceAll(/\s+/gu, " ");
    if (normalizedBody.length > 0) {
      pathsByContent.set(normalizedBody, [
        ...(pathsByContent.get(normalizedBody) ?? []),
        page.path,
      ]);
    }
  }
  const report = (
    entries: Map<string, string[]>,
    code: AuditDiagnosticCode,
    label: string,
  ): void => {
    for (const paths of entries.values()) {
      if (paths.length < 2) {
        continue;
      }
      for (const pagePath of paths) {
        diagnostics.push(
          diagnostic(
            ValidationSeverity.Warning,
            code,
            pagePath,
            `${label}与其他页面重复：${paths.join("、")}`,
          ),
        );
      }
    }
  };
  report(pathsByTitle, AuditDiagnosticCode.DuplicateTitle, "标题");
  report(pathsByContent, AuditDiagnosticCode.DuplicatePageContent, "正文");
}

/** 检查页面之间是否存在任何入链或出链。 */
function auditOrphanPages(
  pages: WikiPage[],
  diagnostics: AuditDiagnostic[],
): void {
  if (pages.length < 2) {
    return;
  }
  const pagePaths = new Set(pages.map((page) => page.path));
  const connectedPaths = new Set<string>();
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/gu;
  for (const page of pages) {
    for (const match of page.body.matchAll(linkPattern)) {
      const rawTarget = match[1]?.trim().split(/\s+/u)[0]?.split("#", 1)[0];
      if (!rawTarget || /^[a-z][a-z0-9+.-]*:/iu.test(rawTarget)) {
        continue;
      }
      const targetPath = path.posix.normalize(
        path.posix.join(path.posix.dirname(page.path), decodeURIComponent(rawTarget)),
      );
      if (pagePaths.has(targetPath)) {
        connectedPaths.add(page.path);
        connectedPaths.add(targetPath);
      }
    }
  }
  for (const page of pages.filter((item) => !connectedPaths.has(item.path))) {
    diagnostics.push(
      diagnostic(
        ValidationSeverity.Warning,
        AuditDiagnosticCode.OrphanPage,
        page.path,
        "页面没有与其他知识页面建立入链或出链",
      ),
    );
  }
}

/** 逐条重新读取 Snapshot，验证页面 Evidence 的身份、范围与摘要。 */
async function auditEvidence(
  root: string,
  pages: WikiPage[],
  latestBySource: Map<string, LatestSnapshotPointer>,
  policy: AuditPolicy,
  diagnostics: AuditDiagnostic[],
): Promise<number> {
  let pagesWithEvidence = 0;
  for (const page of pages) {
    const lore = loreMetadata(page);
    const status =
      typeof lore.status === "string" ? lore.status : KnowledgeStatus.Active;
    const evidence = pageEvidence(page);
    if (evidence.length > 0) {
      pagesWithEvidence += 1;
    }
    if (
      policy.require_evidence_for_active_pages &&
      status === KnowledgeStatus.Active &&
      evidence.length === 0
    ) {
      diagnostics.push(
        diagnostic(
          ValidationSeverity.Error,
          AuditDiagnosticCode.MissingEvidence,
          page.path,
          "Active 页面必须至少包含一条可验证 Evidence",
        ),
      );
    }

    for (const item of evidence) {
      const sourcePath = safeJoin(
        root,
        DirectoryName.Raw,
        DirectoryName.Sources,
        item.source_id,
        VaultFileName.SourceMetadata,
      );
      if (!(await pathExists(sourcePath))) {
        diagnostics.push(
          diagnostic(
            ValidationSeverity.Error,
            AuditDiagnosticCode.EvidenceSourceMissing,
            page.path,
            `Evidence ${item.id} 引用了不存在的 Source：${item.source_id}`,
          ),
        );
        continue;
      }
      const evidenceSource = await readYamlFile<SourceMetadata>(sourcePath);
      if (evidenceSource.status === SourceStatus.Tombstoned) {
        diagnostics.push(
          diagnostic(
            ValidationSeverity.Warning,
            AuditDiagnosticCode.EvidenceSourceTombstoned,
            page.path,
            `Evidence ${item.id} 引用的 Source 已被 tombstone`,
          ),
        );
      }
      const manifestPath = safeJoin(
        root,
        DirectoryName.Raw,
        DirectoryName.Sources,
        item.source_id,
        DirectoryName.Snapshots,
        item.snapshot_id,
        VaultFileName.SnapshotManifest,
      );
      if (!(await pathExists(manifestPath))) {
        diagnostics.push(
          diagnostic(
            ValidationSeverity.Error,
            AuditDiagnosticCode.EvidenceSnapshotMissing,
            page.path,
            `Evidence ${item.id} 引用了不存在的 Snapshot：${item.snapshot_id}`,
          ),
        );
        continue;
      }
      try {
        const captured = await readSourceSnapshot(
          root,
          item.source_id,
          item.snapshot_id,
        );
        const actualHash = evidenceQuoteSha256(
          captured.content.toString(TEXT_ENCODING),
          item.locator,
        );
        if (actualHash !== item.quote_sha256) {
          diagnostics.push(
            diagnostic(
              ValidationSeverity.Error,
              AuditDiagnosticCode.EvidenceChecksumMismatch,
              page.path,
              `Evidence ${item.id} 的摘录哈希不再匹配 Snapshot`,
            ),
          );
        }
      } catch (error) {
        diagnostics.push(
          diagnostic(
            ValidationSeverity.Error,
            AuditDiagnosticCode.EvidenceLocatorInvalid,
            page.path,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
      const latest = latestBySource.get(item.source_id);
      if (latest && latest.snapshot_id !== item.snapshot_id) {
        diagnostics.push(
          diagnostic(
            ValidationSeverity.Warning,
            AuditDiagnosticCode.EvidenceNotLatest,
            page.path,
            `Evidence ${item.id} 仍引用旧 Snapshot；latest 为 ${latest.snapshot_id}`,
          ),
        );
      }
    }
  }
  return pagesWithEvidence;
}

/** 验证 superseded 页面确实指向仍存在的替代知识。 */
function auditSupersededTargets(
  pages: WikiPage[],
  diagnostics: AuditDiagnostic[],
): void {
  const pagePaths = new Set(pages.map((page) => page.path));
  const conceptIds = new Set(
    pages
      .map((page) => loreMetadata(page).id)
      .filter((value): value is string => typeof value === "string"),
  );
  for (const page of pages) {
    const lore = loreMetadata(page);
    if (lore.status !== KnowledgeStatus.Superseded) {
      const supersedes = Array.isArray(lore.supersedes)
        ? lore.supersedes.filter((value): value is string => typeof value === "string")
        : [];
      for (const target of supersedes) {
        if (!pagePaths.has(target) && !conceptIds.has(target)) {
          diagnostics.push(
            diagnostic(
              ValidationSeverity.Error,
              AuditDiagnosticCode.SupersedesTargetMissing,
              page.path,
              `页面声明 supersedes 了不存在的知识：${target}`,
            ),
          );
        }
      }
      continue;
    }
    const target = lore.superseded_by;
    if (
      typeof target !== "string" ||
      (!pagePaths.has(target) && !conceptIds.has(target))
    ) {
      diagnostics.push(
        diagnostic(
          ValidationSeverity.Error,
          AuditDiagnosticCode.SupersededTargetMissing,
          page.path,
          `superseded 页面指向了不存在的替代知识：${String(target)}`,
        ),
      );
    }
  }
}

/** 判断 latest Snapshot 是否至少存在一条仍处于 Applied 的编译记录。 */
async function latestSnapshotIsCompiled(
  root: string,
  sourceId: string,
  snapshotId: string,
): Promise<boolean> {
  const compilationRoot = safeJoin(
    root,
    DirectoryName.Raw,
    DirectoryName.Sources,
    sourceId,
    DirectoryName.Compilations,
    snapshotId,
  );
  for (const filePath of await walkFiles(compilationRoot)) {
    if (path.extname(filePath).toLowerCase() !== ".yaml") {
      continue;
    }
    try {
      const record = await readYamlFile<CompilationRecord>(filePath);
      if (record.status === CompileRunStatus.Applied) {
        return true;
      }
    } catch {
      // 损坏的记录无法证明 Snapshot 已成功编译。
    }
  }
  return false;
}

/** 检查 latest 编译覆盖率与来源更新时间。 */
async function auditSources(
  root: string,
  now: Date,
  policy: AuditPolicy,
  diagnostics: AuditDiagnostic[],
): Promise<{
  snapshots: number;
  latestCompiled: number;
  latestBySource: Map<string, LatestSnapshotPointer>;
}> {
  const sources = await listSources(root);
  const latestBySource = new Map<string, LatestSnapshotPointer>();
  let latestCompiled = 0;
  for (const source of sources) {
    const { latest } = await showSource(root, source.source_id);
    latestBySource.set(source.source_id, latest);
    const compiled = await latestSnapshotIsCompiled(
      root,
      source.source_id,
      latest.snapshot_id,
    );
    if (compiled) {
      latestCompiled += 1;
    } else if (
      policy.check_uncompiled_latest_snapshots &&
      source.status === SourceStatus.Active
    ) {
      diagnostics.push(
        diagnostic(
          ValidationSeverity.Warning,
          AuditDiagnosticCode.UncompiledLatestSnapshot,
          `${DirectoryName.Raw}/${DirectoryName.Sources}/${source.source_id}/${VaultFileName.LatestSnapshot}`,
          `latest Snapshot ${latest.snapshot_id} 尚未编译为 Wiki 知识`,
        ),
      );
    }
    const manifest = await readYamlFile<SnapshotManifest>(
      safeJoin(
        root,
        DirectoryName.Raw,
        DirectoryName.Sources,
        source.source_id,
        DirectoryName.Snapshots,
        latest.snapshot_id,
        VaultFileName.SnapshotManifest,
      ),
    );
    const capturedAt = Date.parse(manifest.captured_at);
    if (
      source.status === SourceStatus.Active &&
      Number.isFinite(capturedAt) &&
      now.getTime() - capturedAt >
        policy.stale_source_after_days * MILLISECONDS_PER_DAY
    ) {
      diagnostics.push(
        diagnostic(
          ValidationSeverity.Warning,
          AuditDiagnosticCode.StaleSource,
          `${DirectoryName.Raw}/${DirectoryName.Sources}/${source.source_id}`,
          `来源超过 ${policy.stale_source_after_days} 天没有新 Snapshot`,
        ),
      );
    }
  }
  const rawFiles = await walkFiles(
    safeJoin(root, DirectoryName.Raw, DirectoryName.Sources),
  );
  return {
    snapshots: rawFiles.filter(
      (filePath) => path.basename(filePath) === VaultFileName.SnapshotManifest,
    ).length,
    latestCompiled,
    latestBySource,
  };
}

/** 检查长期停留在非终态的编译任务。 */
async function auditCompileRuns(
  root: string,
  now: Date,
  policy: AuditPolicy,
  diagnostics: AuditDiagnostic[],
): Promise<number> {
  const runsRoot = safeJoin(root, DirectoryName.Runtime, DirectoryName.Runs);
  let incompleteRuns = 0;
  for (const filePath of await walkFiles(runsRoot)) {
    if (path.basename(filePath) !== VaultFileName.CompileRun) {
      continue;
    }
    try {
      const run = await readYamlFile<CompileRun>(filePath);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        continue;
      }
      incompleteRuns += 1;
      const updatedAt = Date.parse(run.updated_at);
      if (
        !Number.isFinite(updatedAt) ||
        now.getTime() - updatedAt >
          policy.stale_run_after_hours * MILLISECONDS_PER_HOUR
      ) {
        diagnostics.push(
          diagnostic(
            ValidationSeverity.Warning,
            AuditDiagnosticCode.IncompleteCompileRun,
            path.relative(root, filePath),
            `任务 ${run.run_id} 长期停留在 ${run.status} 状态`,
          ),
        );
      }
    } catch {
      incompleteRuns += 1;
    }
  }
  return incompleteRuns;
}

/** 执行基础完整性校验之上的长期健康审计。 */
export async function auditVault(
  root: string,
  now: Date = new Date(),
): Promise<AuditReport> {
  const validation = await validateVault(root);
  const policy = await readAuditPolicy(root);
  const diagnostics: AuditDiagnostic[] = [];
  const sources = await listSources(root).catch(() => []);
  const sourceAudit = await auditSources(root, now, policy, diagnostics).catch(() => ({
    snapshots: 0,
    latestCompiled: 0,
    latestBySource: new Map<string, LatestSnapshotPointer>(),
  }));
  let pages: WikiPage[] = [];
  if (validation.valid) {
    pages = await listWikiPages(root);
  }
  const pagesWithEvidence = await auditEvidence(
    root,
    pages,
    sourceAudit.latestBySource,
    policy,
    diagnostics,
  );
  auditDuplicateField(
    pages,
    diagnostics,
    "id",
    AuditDiagnosticCode.DuplicateConceptId,
  );
  auditDuplicateField(
    pages,
    diagnostics,
    "merge_key",
    AuditDiagnosticCode.DuplicateMergeKey,
  );
  if (policy.check_duplicate_pages) {
    auditDuplicatePages(pages, diagnostics);
  }
  if (policy.check_orphan_pages) {
    auditOrphanPages(pages, diagnostics);
  }
  auditSupersededTargets(pages, diagnostics);
  const incompleteRuns = await auditCompileRuns(root, now, policy, diagnostics);
  diagnostics.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.code.localeCompare(right.code),
  );
  const errors = diagnostics.filter(
    (item) => item.severity === ValidationSeverity.Error,
  ).length;
  const warnings = diagnostics.filter(
    (item) => item.severity === ValidationSeverity.Warning,
  ).length;
  return {
    healthy: validation.valid && errors === 0,
    errors: errors + validation.errors,
    warnings: warnings + validation.warnings,
    validation,
    coverage: {
      sources: sources.length,
      snapshots: sourceAudit.snapshots,
      latest_snapshots_compiled: sourceAudit.latestCompiled,
      wiki_pages: pages.length,
      pages_with_evidence: pagesWithEvidence,
      incomplete_compile_runs: incompleteRuns,
    },
    diagnostics,
  };
}
