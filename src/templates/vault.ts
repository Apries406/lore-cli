import {
  DEFAULT_MAX_COMPILE_CHANGES,
  DEFAULT_MAX_CANDIDATE_PAGES,
  DEFAULT_MAX_NEW_PAGES,
  LINE_RANGE_LOCATOR_PATTERN,
  OKF_VERSION,
  SCHEMA_VERSION,
  SHA256_HEX_LENGTH,
  SNAPSHOT_ID_PREFIX,
  SOURCE_ID_PREFIX,
  WIKI_PAGE_PATH_PATTERN,
} from "../domain/constants.js";
import {
  ChangeAction,
  ConfidenceLevel,
  DirectoryName,
  KnowledgeStatus,
  KnowledgeOperation,
  MergeStrategy,
  QueryFallbackPolicy,
  SourceKind,
  SourceStatus,
  SyncPolicy,
  VaultFileName,
  WikiPageType,
} from "../domain/enums.js";
import type { VaultConfig } from "../domain/models.js";

/** 创建根配置。目录值属于 Vault 协议，不使用展示文案。 */
export function createVaultConfig(name: string): VaultConfig {
  return {
    version: SCHEMA_VERSION,
    name,
    raw_dir: DirectoryName.Raw,
    wiki_dir: DirectoryName.Wiki,
    schema_dir: DirectoryName.Schema,
    runtime_dir: DirectoryName.Runtime,
    profile: `${DirectoryName.Schema}/${VaultFileName.Profile}`,
  };
}

/** 创建用户可调整的 Lore Profile 默认策略。 */
export function createProfile(): Record<string, unknown> {
  return {
    version: SCHEMA_VERSION,
    okf_version: OKF_VERSION,
    page_types: Object.values(WikiPageType),
    merge: {
      strategy: MergeStrategy.UpsertFirst,
      require_candidate_search_before_create: true,
    },
    query: {
      wiki_first: true,
      raw_fallback: QueryFallbackPolicy.WhenEvidenceIsInsufficient,
      max_candidate_pages: DEFAULT_MAX_CANDIDATE_PAGES,
    },
    compile: {
      max_changes: DEFAULT_MAX_COMPILE_CHANGES,
      max_new_pages: DEFAULT_MAX_NEW_PAGES,
      require_evidence: true,
      require_review: true,
    },
    audit: {
      require_evidence_for_active_pages: true,
      check_broken_links: true,
      check_orphan_pages: true,
    },
  };
}

/** 创建 OKF Concept frontmatter 的机器校验契约。 */
export function createConceptSchema(): Record<string, unknown> {
  const sourceIdPattern = `^${SOURCE_ID_PREFIX}[a-f0-9]+$`;
  const snapshotIdPattern = `^${SNAPSHOT_ID_PREFIX}[a-f0-9]+$`;
  const sha256Pattern = `^[a-f0-9]{${SHA256_HEX_LENGTH}}$`;

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://lore.local/schema/concept.schema.json",
    type: "object",
    required: ["type"],
    additionalProperties: true,
    properties: {
      type: { enum: Object.values(WikiPageType) },
      title: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
      resource: { type: "string", format: "uri" },
      tags: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
      timestamp: { type: "string", format: "date-time" },
      lore: {
        type: "object",
        additionalProperties: true,
        properties: {
          id: { type: "string", minLength: 1 },
          schema_version: { type: "integer", minimum: 1 },
          status: { enum: Object.values(KnowledgeStatus) },
          confidence: { enum: Object.values(ConfidenceLevel) },
          merge_key: { type: "string", minLength: 1 },
          evidence: {
            type: "array",
            items: {
              type: "object",
              required: [
                "id",
                "source_id",
                "snapshot_id",
                "locator",
                "quote_sha256",
              ],
              additionalProperties: true,
              properties: {
                id: { type: "string", minLength: 1 },
                source_id: { type: "string", pattern: sourceIdPattern },
                snapshot_id: { type: "string", pattern: snapshotIdPattern },
                locator: { type: "string", pattern: LINE_RANGE_LOCATOR_PATTERN },
                quote_sha256: { type: "string", pattern: sha256Pattern },
              },
            },
          },
        },
      },
    },
  };
}

/** 创建 Source、Snapshot 与 latest 指针的机器校验契约。 */
export function createSourceSchema(): Record<string, unknown> {
  const sourceIdPattern = `^${SOURCE_ID_PREFIX}[a-f0-9]+$`;
  const snapshotIdPattern = `^${SNAPSHOT_ID_PREFIX}[a-f0-9]+$`;
  const sha256Pattern = `^[a-f0-9]{${SHA256_HEX_LENGTH}}$`;

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://lore.local/schema/source.schema.json",
    definitions: {
      source: {
        type: "object",
        required: [
          "version",
          "source_id",
          "kind",
          "canonical_uri",
          "title",
          "status",
          "sync_policy",
          "created_at",
        ],
        additionalProperties: false,
        properties: {
          version: { type: "integer", minimum: 1 },
          source_id: { type: "string", pattern: sourceIdPattern },
          kind: { enum: Object.values(SourceKind) },
          canonical_uri: { type: "string", format: "uri" },
          title: { type: "string", minLength: 1 },
          status: { enum: Object.values(SourceStatus) },
          sync_policy: { enum: Object.values(SyncPolicy) },
          created_at: { type: "string", format: "date-time" },
        },
      },
      snapshot: {
        type: "object",
        required: [
          "version",
          "snapshot_id",
          "source_id",
          "captured_at",
          "media_type",
          "content_path",
          "content_sha256",
          "collector",
        ],
        additionalProperties: false,
        properties: {
          version: { type: "integer", minimum: 1 },
          snapshot_id: { type: "string", pattern: snapshotIdPattern },
          source_id: { type: "string", pattern: sourceIdPattern },
          captured_at: { type: "string", format: "date-time" },
          media_type: { type: "string", minLength: 1 },
          content_path: { type: "string", minLength: 1 },
          content_sha256: { type: "string", pattern: sha256Pattern },
          collector: { type: "string", minLength: 1 },
        },
      },
      latest: {
        type: "object",
        required: ["version", "source_id", "snapshot_id", "updated_at"],
        additionalProperties: false,
        properties: {
          version: { type: "integer", minimum: 1 },
          source_id: { type: "string", pattern: sourceIdPattern },
          snapshot_id: { type: "string", pattern: snapshotIdPattern },
          updated_at: { type: "string", format: "date-time" },
        },
      },
    },
  };
}

/** 创建 Skill 向 CLI 提交 Change Set 时必须遵守的契约。 */
export function createChangeSetSchema(): Record<string, unknown> {
  const sourceIdPattern = `^${SOURCE_ID_PREFIX}[a-f0-9]+$`;
  const snapshotIdPattern = `^${SNAPSHOT_ID_PREFIX}[a-f0-9]+$`;
  const sha256Pattern = `^[a-f0-9]{${SHA256_HEX_LENGTH}}$`;

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://lore.local/schema/change-set.schema.json",
    type: "object",
    required: [
      "version",
      "run_id",
      "base_revision",
      "operation",
      "inputs",
      "summary",
      "changes",
    ],
    additionalProperties: false,
    properties: {
      version: { type: "integer", minimum: 1 },
      run_id: { type: "string", minLength: 1 },
      base_revision: {
        type: "object",
        required: ["wiki_sha256"],
        additionalProperties: false,
        properties: {
          wiki_sha256: { type: "string", pattern: sha256Pattern },
          git_head: { type: "string", minLength: 1 },
        },
      },
      operation: { const: KnowledgeOperation.Compile },
      inputs: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: {
          type: "object",
          required: ["source_id", "snapshot_id"],
          additionalProperties: false,
          properties: {
            source_id: { type: "string", pattern: sourceIdPattern },
            snapshot_id: { type: "string", pattern: snapshotIdPattern },
          },
        },
      },
      summary: { type: "string", minLength: 1 },
      questions: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
      changes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["action", "target", "concept", "reason"],
          additionalProperties: false,
          properties: {
            action: { enum: [ChangeAction.Create, ChangeAction.Update] },
            target: {
              type: "object",
              required: ["path"],
              additionalProperties: false,
              properties: {
                path: { type: "string", pattern: WIKI_PAGE_PATH_PATTERN },
                expected_sha256: { type: "string", pattern: sha256Pattern },
              },
            },
            concept: {
              type: "object",
              required: ["type", "body"],
              additionalProperties: false,
              properties: {
                type: { enum: Object.values(WikiPageType) },
                title: { type: "string", minLength: 1 },
                description: { type: "string", minLength: 1 },
                resource: { type: "string", format: "uri" },
                tags: {
                  type: "array",
                  uniqueItems: true,
                  items: { type: "string", minLength: 1 },
                },
                timestamp: { type: "string", format: "date-time" },
                lore: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string", minLength: 1 },
                    schema_version: { type: "integer", minimum: 1 },
                    status: { enum: Object.values(KnowledgeStatus) },
                    confidence: { enum: Object.values(ConfidenceLevel) },
                    merge_key: { type: "string", minLength: 1 },
                    supersedes: {
                      type: "array",
                      uniqueItems: true,
                      items: { type: "string", minLength: 1 },
                    },
                    evidence: {
                      type: "array",
                      minItems: 1,
                      items: {
                        type: "object",
                        required: [
                          "id",
                          "source_id",
                          "snapshot_id",
                          "locator",
                          "quote_sha256",
                        ],
                        additionalProperties: false,
                        properties: {
                          id: { type: "string", minLength: 1 },
                          source_id: { type: "string", pattern: sourceIdPattern },
                          snapshot_id: {
                            type: "string",
                            pattern: snapshotIdPattern,
                          },
                          locator: {
                            type: "string",
                            pattern: LINE_RANGE_LOCATOR_PATTERN,
                          },
                          quote_sha256: { type: "string", pattern: sha256Pattern },
                        },
                      },
                    },
                  },
                },
                body: { type: "string", minLength: 1 },
              },
            },
            reason: { type: "string", minLength: 1 },
          },
        },
      },
    },
  };
}

/** 创建空 Wiki 的渐进式导航入口。 */
export function createWikiIndex(): string {
  return `# Lore 知识库\n\n这是由 Lore 维护的 OKF 编译知识包。\n\n## 知识页面\n\n尚未编译任何知识页面。\n`;
}

/** 创建符合 OKF 约定的时间日志。 */
export function createWikiLog(date: string): string {
  return `# 目录更新日志\n\n## ${date}\n\n* **初始化**：创建 Lore OKF Bundle。\n`;
}

/** 创建供宿主 Agent 阅读的中文维护契约。 */
export function createAgentInstructions(): string {
  return `# Lore Agent 维护契约\n\n维护此知识库时必须遵守：\n\n1. 创建新页面前先检索已有页面。\n2. 优先更新规范页面，不要为每个来源创建摘要页。\n3. 将 Raw Snapshot 视为不可修改的原始证据。\n4. 为生效中的知识结论保留机器可读 Evidence。\n5. 查询时先读 Wiki，仅在证据不足时回退 Raw。\n6. 生成通过校验的 Change Set，不得写入任意路径。\n7. 应用高影响变更前必须展示 diff。\n8. 往返读写时保留无法识别的 OKF frontmatter 字段。\n`;
}

export const GIT_IGNORE_TEMPLATE = `.lore/\n.DS_Store\n`;

export const LORE_IGNORE_TEMPLATE = `# 不参与采集的路径和来源\n.env\n.env.*\n**/node_modules/**\n**/.git/**\n`;
