import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_COLD_KNOWLEDGE_DAYS,
  QUERY_ID_PREFIX,
  SCHEMA_VERSION,
  TEXT_ENCODING,
} from "../domain/constants.js";
import { DirectoryName, UsageChannel, VaultFileName } from "../domain/enums.js";
import type { QueryPacket } from "../domain/query-models.js";
import type { QueryUsageRecord, UsagePolicy } from "../domain/usage-models.js";
import { safeJoin } from "../infrastructure/filesystem.js";
import { sha256 } from "../infrastructure/hash.js";
import { readYamlFile, writeJsonFile } from "../infrastructure/serialization.js";
import { walkFiles } from "../infrastructure/walk.js";

export interface RecordQueryUsageOptions {
  track?: boolean;
}

export interface QueryUsageCollection {
  records: QueryUsageRecord[];
  ignored: number;
}

/** 缺少 Profile 新字段时使用安全默认值，旧 Vault 无需迁移即可启用。 */
export async function readUsagePolicy(root: string): Promise<UsagePolicy> {
  const profile = await readYamlFile<Record<string, unknown>>(
    safeJoin(root, DirectoryName.Schema, VaultFileName.Profile),
  );
  const usage =
    profile.usage && typeof profile.usage === "object" && !Array.isArray(profile.usage)
      ? (profile.usage as Record<string, unknown>)
      : {};
  const coldAfterDays = usage.cold_after_days;
  return {
    tracking_enabled: usage.tracking_enabled !== false,
    store_question_text: usage.store_question_text === true,
    cold_after_days:
      typeof coldAfterDays === "number" &&
      Number.isInteger(coldAfterDays) &&
      coldAfterDays > 0
        ? coldAfterDays
        : DEFAULT_COLD_KNOWLEDGE_DAYS,
  };
}

/** 为 Query Packet 生成不可猜测但可读的本地标识。 */
export function createQueryId(): string {
  return `${QUERY_ID_PREFIX}${sha256(randomUUID()).slice(0, 16)}`;
}

/** 将一次 Agent 查询的召回结果写入独立 JSON 文件，不修改 Raw 或 Wiki。 */
export async function recordQueryUsage(
  root: string,
  packet: QueryPacket,
  options: RecordQueryUsageOptions = {},
): Promise<boolean> {
  const policy = await readUsagePolicy(root);
  if (options.track === false || !policy.tracking_enabled) {
    return false;
  }
  const record: QueryUsageRecord = {
    version: SCHEMA_VERSION,
    query_id: packet.query_id,
    channel: UsageChannel.AgentQuery,
    occurred_at: packet.created_at,
    question_sha256: sha256(packet.question),
    ...(policy.store_question_text ? { question: packet.question } : {}),
    wiki_recalls: packet.wiki_candidates.map((candidate, index) => ({
      path: candidate.path,
      title: candidate.title,
      rank: index + 1,
      score: candidate.score,
    })),
    raw_recalls: packet.raw_evidence.map((evidence, index) => ({
      source_id: evidence.source_id,
      source_title: evidence.source_title,
      snapshot_id: evidence.snapshot_id,
      rank: index + 1,
      score: evidence.score,
    })),
    fallback_used: packet.fallback.used,
  };
  const targetPath = safeJoin(
    root,
    DirectoryName.Runtime,
    DirectoryName.Usage,
    DirectoryName.Queries,
    `${packet.query_id}.json`,
  );
  await writeJsonFile(targetPath, record);
  return true;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isWikiRecall(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const recall = value as Record<string, unknown>;
  return (
    isString(recall.path) &&
    isString(recall.title) &&
    isFiniteNumber(recall.rank) &&
    isFiniteNumber(recall.score)
  );
}

function isRawRecall(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const recall = value as Record<string, unknown>;
  return (
    isString(recall.source_id) &&
    isString(recall.source_title) &&
    isString(recall.snapshot_id) &&
    isFiniteNumber(recall.rank) &&
    isFiniteNumber(recall.score)
  );
}

/** 对本地使用记录做宽容读取；损坏记录会计数但不会阻塞知识查询和 Dashboard。 */
function parseUsageRecord(value: unknown): QueryUsageRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.version !== "number" ||
    !isString(record.query_id) ||
    record.channel !== UsageChannel.AgentQuery ||
    !isString(record.occurred_at) ||
    !Number.isFinite(Date.parse(record.occurred_at)) ||
    !isString(record.question_sha256) ||
    (record.question !== undefined && !isString(record.question)) ||
    !Array.isArray(record.wiki_recalls) ||
    !record.wiki_recalls.every(isWikiRecall) ||
    !Array.isArray(record.raw_recalls) ||
    !record.raw_recalls.every(isRawRecall) ||
    typeof record.fallback_used !== "boolean"
  ) {
    return undefined;
  }
  return value as QueryUsageRecord;
}

/** 读取全部查询使用记录，供本地统计和 Dashboard 聚合。 */
export async function listQueryUsageRecords(
  root: string,
): Promise<QueryUsageCollection> {
  const usageRoot = safeJoin(
    root,
    DirectoryName.Runtime,
    DirectoryName.Usage,
    DirectoryName.Queries,
  );
  const records: QueryUsageRecord[] = [];
  let ignored = 0;
  for (const filePath of await walkFiles(usageRoot)) {
    if (path.extname(filePath).toLowerCase() !== ".json") {
      continue;
    }
    try {
      const parsed = parseUsageRecord(
        JSON.parse(await readFile(filePath, TEXT_ENCODING)) as unknown,
      );
      if (parsed) {
        records.push(parsed);
      } else {
        ignored += 1;
      }
    } catch {
      ignored += 1;
    }
  }
  return {
    records: records.sort((left, right) =>
      left.occurred_at.localeCompare(right.occurred_at),
    ),
    ignored,
  };
}
