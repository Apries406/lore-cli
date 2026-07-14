import path from "node:path";
import { DirectoryName, VaultFileName } from "../domain/enums.js";
import type { VaultStatus } from "../domain/models.js";
import { safeJoin } from "../infrastructure/filesystem.js";
import { walkFiles } from "../infrastructure/walk.js";
import { listSources } from "./source-service.js";
import { validateVault } from "./validation-service.js";

/** 汇总来源、快照、Wiki 页面数量以及完整校验结果。 */
export async function getVaultStatus(root: string): Promise<VaultStatus> {
  const sources = await listSources(root);
  const rawFiles = await walkFiles(
    safeJoin(root, DirectoryName.Raw, DirectoryName.Sources),
  );
  const wikiFiles = await walkFiles(safeJoin(root, DirectoryName.Wiki));
  const validation = await validateVault(root);

  const snapshots = rawFiles.filter(
    (filePath) => path.basename(filePath) === VaultFileName.SnapshotManifest,
  ).length;
  const wikiPages = wikiFiles.filter((filePath) => {
    if (path.extname(filePath).toLowerCase() !== ".md") {
      return false;
    }
    const fileName = path.basename(filePath);
    return fileName !== VaultFileName.Index && fileName !== VaultFileName.Log;
  }).length;

  return {
    root,
    sources: sources.length,
    snapshots,
    wiki_pages: wikiPages,
    validation: {
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
    },
  };
}
