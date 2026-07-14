import {
  CompileRunStatus,
  ErrorCode,
  ExitCode,
  SourceLifecycleAction,
} from "../domain/enums.js";
import type { SourceWithdrawalResult } from "../domain/models.js";
import { LoreError } from "../errors.js";
import { rollbackCompile } from "./compile-service.js";
import {
  getSourceHistory,
  getSourceImpact,
  updateSourceLifecycle,
} from "./source-service.js";
import { getWikiRevision } from "./wiki-service.js";

/**
 * 按应用时间逆序撤销一个 Source 的连续编译链，再执行 tombstone。
 * 若期间夹杂其他来源或人工 Wiki 修改，版本链预检会在任何写入前拒绝操作。
 */
export async function withdrawSource(
  root: string,
  sourceId: string,
  now: Date = new Date(),
): Promise<SourceWithdrawalResult> {
  const history = await getSourceHistory(root, sourceId);
  const impact = await getSourceImpact(root, sourceId);
  const appliedRecords = history.compilations
    .filter((record) => record.status === CompileRunStatus.Applied)
    .sort((left, right) => right.applied_at.localeCompare(left.applied_at));

  if (appliedRecords.length > 0) {
    const currentRevision = await getWikiRevision(root);
    const newest = appliedRecords[0];
    if (!newest || currentRevision.wiki_sha256 !== newest.wiki_revision_after) {
      throw new LoreError(
        ErrorCode.Conflict,
        "Wiki 在该 Source 最后一次编译后又发生变化，不能自动撤销来源影响",
        ExitCode.Conflict,
      );
    }
    for (let index = 0; index < appliedRecords.length - 1; index += 1) {
      const newer = appliedRecords[index];
      const older = appliedRecords[index + 1];
      if (
        !newer ||
        !older ||
        newer.wiki_revision_before !== older.wiki_revision_after
      ) {
        throw new LoreError(
          ErrorCode.Conflict,
          "该 Source 的编译之间夹杂了其他 Wiki 变更，不能作为连续链自动撤销",
          ExitCode.Conflict,
        );
      }
    }
  }

  const rolledBackRuns: string[] = [];
  for (const record of appliedRecords) {
    await rollbackCompile(root, record.run_id, now);
    rolledBackRuns.push(record.run_id);
  }
  const source = await updateSourceLifecycle(
    root,
    sourceId,
    SourceLifecycleAction.Tombstone,
  );
  return {
    source,
    rolled_back_runs: rolledBackRuns,
    previous_impact: impact,
  };
}
