import type { VaultStatus } from "../domain/models.js";
import { auditVault } from "./audit-service.js";

/** 汇总基础完整性、长期健康和编译覆盖率。 */
export async function getVaultStatus(root: string): Promise<VaultStatus> {
  const audit = await auditVault(root);
  return {
    root,
    sources: audit.coverage.sources,
    snapshots: audit.coverage.snapshots,
    wiki_pages: audit.coverage.wiki_pages,
    validation: {
      valid: audit.validation.valid,
      errors: audit.validation.errors,
      warnings: audit.validation.warnings,
    },
    audit: {
      healthy: audit.healthy,
      errors: audit.errors,
      warnings: audit.warnings,
      latest_snapshots_compiled: audit.coverage.latest_snapshots_compiled,
      incomplete_compile_runs: audit.coverage.incomplete_compile_runs,
    },
  };
}
