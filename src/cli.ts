#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import type { ChangeSet } from "./domain/compile-models.js";
import { DEFAULT_QUERY_RESULT_LIMIT, LORE_VERSION } from "./domain/constants.js";
import {
  ExitCode,
  OutputFormat,
  RawFallbackMode,
  SourceKind,
  SourceLifecycleAction,
} from "./domain/enums.js";
import { asLoreError } from "./errors.js";
import { findVaultRoot } from "./infrastructure/filesystem.js";
import { parseYaml } from "./infrastructure/serialization.js";
import { Reporter } from "./output/reporter.js";
import {
  addSource,
  getSourceHistory,
  getSourceImpact,
  listSources,
  showSource,
  syncSource,
  SUPPORTED_SOURCE_KINDS,
  updateSourceLifecycle,
} from "./services/source-service.js";
import { getVaultStatus } from "./services/status-service.js";
import { validateVault } from "./services/validation-service.js";
import { initializeVault } from "./services/vault-service.js";
import { auditVault } from "./services/audit-service.js";
import { withdrawSource } from "./services/source-impact-service.js";
import {
  installBundledSkills,
  listBundledSkills,
} from "./services/skill-service.js";
import {
  getRecoveryStatus,
  recoverVault,
} from "./services/mutation-service.js";
import {
  applyMigration,
  assertVaultCompatible,
  getMigrationPlan,
} from "./services/migration-service.js";
import { prepareQuery, showWikiPage } from "./services/query-service.js";
import { searchWiki } from "./services/wiki-service.js";
import {
  applyCompile,
  getCompilePacket,
  getCompileRun,
  getEvidenceQuote,
  prepareCompile,
  readCompileDiff,
  rollbackCompile,
  submitChangeSet,
} from "./services/compile-service.js";

interface GlobalOptions {
  root?: string;
  json?: boolean;
}

interface SourceAddOptions {
  kind: SourceKind;
  title?: string;
  revision?: string;
  allowSensitive?: boolean;
}

interface CompilePrepareOptions {
  snapshot?: string;
  recompile?: boolean;
}

interface CompileSubmitOptions {
  file: string;
}

interface CompileEvidenceOptions {
  locator: string;
}

interface WikiSearchOptions {
  limit?: string;
  includeInactive?: boolean;
}

interface QueryPrepareOptions {
  fallback: RawFallbackMode;
  wikiLimit?: string;
  rawLimit?: string;
}

interface SkillInstallOptions {
  target?: string;
  force?: boolean;
}

/** 将可选的正整数 CLI 参数转成查询服务参数。 */
function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`必须是正整数：${value}`);
  }
  return parsed;
}

/** Commander 内置帮助区块的中文标题。键值由依赖库定义，不能翻译。 */
const HELP_SECTION_TITLES: Readonly<Record<string, string>> = {
  "Usage:": "用法：",
  "Options:": "选项：",
  "Global Options:": "全局选项：",
  "Commands:": "命令：",
  "Arguments:": "参数：",
};

/** 根据全局参数选择面向人或面向机器的输出格式。 */
function outputFormat(options: GlobalOptions): OutputFormat {
  return options.json === true ? OutputFormat.Json : OutputFormat.Human;
}

/** 解析显式根目录，未指定时从当前目录向上寻找。 */
async function resolveVaultRoot(options: GlobalOptions): Promise<string> {
  const root = await findVaultRoot(options.root ?? process.cwd());
  await assertVaultCompatible(root);
  return root;
}

/** 只定位 Vault，不执行版本门禁；仅供 migrate 命令使用。 */
async function locateVaultRoot(options: GlobalOptions): Promise<string> {
  return findVaultRoot(options.root ?? process.cwd());
}

/** 构建完整命令树。命令名属于稳定 CLI 协议，帮助文案使用中文。 */
function createProgram(): Command {
  const program = new Command();
  program
    .name("lore")
    .description("本地优先的知识编译器")
    .version(LORE_VERSION, "-V, --version", "显示版本")
    .helpOption("-h, --help", "显示帮助")
    .addHelpCommand("help [command]", "显示命令帮助")
    .configureHelp({
      styleTitle: (title: string) => HELP_SECTION_TITLES[title] ?? title,
    })
    .option("--root <path>", "Lore 知识库根目录或其内部路径")
    .option("--json", "输出稳定的 JSON");

  program
    .command("init")
    .description("初始化 Lore 知识库")
    .argument("[path]", "目标目录", ".")
    .action(async (targetPath: string) => {
      const reporter = new Reporter(outputFormat(program.opts<GlobalOptions>()));
      reporter.initialized(await initializeVault(targetPath));
    });

  const skill = program.command("skill").description("查看和安装 Lore Skills");

  skill
    .command("list")
    .description("列出 npm 包内置 Skills")
    .action(async () => {
      const reporter = new Reporter(outputFormat(program.opts<GlobalOptions>()));
      reporter.data(await listBundledSkills());
    });

  skill
    .command("install")
    .description("安装一个或全部内置 Skill 到 Codex")
    .argument("[names...]", "Skill 名称；省略时安装全部")
    .option("--target <path>", "安装目录；默认 $CODEX_HOME/skills")
    .option("--force", "覆盖已存在的 Skill")
    .action(async (names: string[], options: SkillInstallOptions) => {
      const reporter = new Reporter(outputFormat(program.opts<GlobalOptions>()));
      reporter.data(
        await installBundledSkills(names, {
          ...(options.target ? { target: options.target } : {}),
          force: options.force === true,
        }),
      );
    });

  const migrate = program
    .command("migrate")
    .description("检查并升级旧版 Lore Vault");

  migrate
    .command("plan")
    .description("只读展示迁移动作")
    .action(async () => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await getMigrationPlan(await locateVaultRoot(globalOptions)),
      );
    });

  const recover = program
    .command("recover")
    .description("检查并恢复进程中断留下的 Vault 事务");

  recover
    .command("status")
    .description("只读显示写锁和待恢复事务")
    .action(async () => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await getRecoveryStatus(await locateVaultRoot(globalOptions)),
      );
    });

  recover
    .command("apply")
    .description("从事务备份恢复并清理死亡进程写锁")
    .action(async () => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(await recoverVault(await locateVaultRoot(globalOptions)));
    });

  migrate
    .command("status")
    .description("显示当前 Vault 是否需要迁移")
    .action(async () => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await getMigrationPlan(await locateVaultRoot(globalOptions)),
      );
    });

  migrate
    .command("apply")
    .description("备份并事务升级 Vault")
    .action(async () => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await applyMigration(await locateVaultRoot(globalOptions)),
      );
    });

  const source = program
    .command("source")
    .description("采集和查看原始来源");

  source
    .command("add")
    .description("采集一份不可变来源快照")
    .argument("<input>", "来源路径或 URI")
    .addOption(
      new Option("--kind <kind>", "来源类型")
        .choices([...SUPPORTED_SOURCE_KINDS])
        .default(SourceKind.File),
    )
    .option("--title <title>", "来源展示标题")
    .option("--revision <revision>", "Git diff 的 base revision")
    .option("--allow-sensitive", "确认并允许采集检测到的敏感凭证")
    .action(async (input: string, options: SourceAddOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      const root = await resolveVaultRoot(globalOptions);
      reporter.sourceAdded(
        await addSource(root, input, {
          kind: options.kind,
          ...(options.title ? { title: options.title } : {}),
          ...(options.revision ? { revision: options.revision } : {}),
          allow_sensitive: options.allowSensitive === true,
        }),
      );
    });

  source
    .command("add-text")
    .description("采集一段直接文本")
    .argument("<text>", "需要保存的原始文本")
    .option("--title <title>", "来源展示标题")
    .option("--allow-sensitive", "确认并允许采集检测到的敏感凭证")
    .action(async (
      text: string,
      options: { title?: string; allowSensitive?: boolean },
    ) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.sourceAdded(
        await addSource(await resolveVaultRoot(globalOptions), text, {
          kind: SourceKind.Text,
          ...(options.title ? { title: options.title } : {}),
          allow_sensitive: options.allowSensitive === true,
        }),
      );
    });

  const wiki = program.command("wiki").description("检索和读取规范 Wiki 知识");

  wiki
    .command("search")
    .description("使用字段加权 BM25 检索 Wiki")
    .argument("<query>", "查询文本")
    .option("--limit <number>", "最大结果数")
    .option("--include-inactive", "包含 stale 与 superseded 页面")
    .action(async (query: string, options: WikiSearchOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await searchWiki(
          await resolveVaultRoot(globalOptions),
          query,
          optionalPositiveInteger(options.limit) ?? DEFAULT_QUERY_RESULT_LIMIT,
          { include_inactive: options.includeInactive === true },
        ),
      );
    });

  wiki
    .command("show")
    .description("读取一个 Wiki 知识页面")
    .argument("<path>", "prepare/search 返回的 wiki/pages 路径")
    .action(async (relativePath: string) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await showWikiPage(await resolveVaultRoot(globalOptions), relativePath),
      );
    });

  program
    .command("search")
    .description("检索 Wiki；等价于 wiki search")
    .argument("<query>", "查询文本")
    .option("--limit <number>", "最大结果数")
    .option("--include-inactive", "包含 stale 与 superseded 页面")
    .action(async (query: string, options: WikiSearchOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await searchWiki(
          await resolveVaultRoot(globalOptions),
          query,
          optionalPositiveInteger(options.limit) ?? DEFAULT_QUERY_RESULT_LIMIT,
          { include_inactive: options.includeInactive === true },
        ),
      );
    });

  const query = program
    .command("query")
    .description("生成 Wiki-first、必要时回退 Raw 的查询上下文包");

  query
    .command("prepare")
    .description("为查询 Skill 准备只读上下文")
    .argument("<question>", "需要回答的问题")
    .addOption(
      new Option("--fallback <mode>", "Raw 回退模式")
        .choices(Object.values(RawFallbackMode))
        .default(RawFallbackMode.Auto),
    )
    .option("--wiki-limit <number>", "最大 Wiki 候选数")
    .option("--raw-limit <number>", "最大 Raw 摘录数")
    .action(async (question: string, options: QueryPrepareOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      const maxWikiResults = optionalPositiveInteger(options.wikiLimit);
      const maxRawResults = optionalPositiveInteger(options.rawLimit);
      reporter.data(
        await prepareQuery(await resolveVaultRoot(globalOptions), question, {
          fallback_mode: options.fallback,
          ...(maxWikiResults ? { max_wiki_results: maxWikiResults } : {}),
          ...(maxRawResults ? { max_raw_results: maxRawResults } : {}),
        }),
      );
    });

  const compile = program
    .command("compile")
    .description("将不可变 Raw Snapshot 编译为可审阅的 Wiki 变更");

  compile
    .command("prepare")
    .description("生成供 Skill 消费的只读编译包")
    .argument("<source-id>", "稳定的来源 ID")
    .option("--snapshot <snapshot-id>", "指定 Snapshot；默认使用 latest")
    .option("--recompile", "允许重新编译已有生效记录的 Snapshot")
    .action(async (sourceId: string, options: CompilePrepareOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await prepareCompile(await resolveVaultRoot(globalOptions), sourceId, {
          ...(options.snapshot ? { snapshot_id: options.snapshot } : {}),
          recompile: options.recompile === true,
        }),
      );
    });

  compile
    .command("submit")
    .description("提交并校验 Skill 生成的结构化 Change Set")
    .argument("<run-id>", "知识编译任务 ID")
    .requiredOption("--file <path>", "Change Set YAML 文件")
    .action(async (runId: string, options: CompileSubmitOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      const changeSet = parseYaml<ChangeSet>(await readFile(options.file, "utf8"));
      reporter.data(
        await submitChangeSet(
          await resolveVaultRoot(globalOptions),
          runId,
          changeSet,
        ),
      );
    });

  compile
    .command("show")
    .description("显示编译任务及编译包")
    .argument("<run-id>", "知识编译任务 ID")
    .action(async (runId: string) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      const root = await resolveVaultRoot(globalOptions);
      reporter.data({
        run: await getCompileRun(root, runId),
        packet: await getCompilePacket(root, runId),
      });
    });

  compile
    .command("evidence")
    .description("计算 Snapshot 精确行区间的证据摘录哈希")
    .argument("<run-id>", "知识编译任务 ID")
    .requiredOption("--locator <line-range>", "证据行区间，例如 line:3-8")
    .action(async (runId: string, options: CompileEvidenceOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await getEvidenceQuote(
          await resolveVaultRoot(globalOptions),
          runId,
          options.locator,
        ),
      );
    });

  program
    .command("diff")
    .description("显示待应用知识变更")
    .argument("<run-id>", "知识编译任务 ID")
    .action(async (runId: string) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.text(
        await readCompileDiff(await resolveVaultRoot(globalOptions), runId),
      );
    });

  program
    .command("apply")
    .description("在独占锁中事务应用已校验变更")
    .argument("<run-id>", "知识编译任务 ID")
    .action(async (runId: string) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await applyCompile(await resolveVaultRoot(globalOptions), runId),
      );
    });

  program
    .command("rollback")
    .description("安全回滚一次已应用知识编译")
    .argument("<run-id>", "知识编译任务 ID")
    .action(async (runId: string) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await rollbackCompile(await resolveVaultRoot(globalOptions), runId),
      );
    });

  source
    .command("sync")
    .description("已有来源变化时采集新 Snapshot")
    .argument("<source-id>", "稳定的来源 ID")
    .option("--allow-sensitive", "确认并允许新 Snapshot 包含检测到的敏感凭证")
    .action(async (sourceId: string, options: { allowSensitive?: boolean }) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.sourceAdded(
        await syncSource(
          await resolveVaultRoot(globalOptions),
          sourceId,
          new Date(),
          options.allowSensitive === true,
        ),
      );
    });

  source
    .command("list")
    .description("列出已采集来源")
    .action(async () => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.sources(await listSources(await resolveVaultRoot(globalOptions)));
    });

  source
    .command("show")
    .description("显示来源元数据及其最新 Snapshot")
    .argument("<source-id>", "稳定的来源 ID")
    .action(async (sourceId: string) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await showSource(await resolveVaultRoot(globalOptions), sourceId),
      );
    });

  source
    .command("history")
    .description("显示 Source 的 Snapshot 与编译历史")
    .argument("<source-id>", "稳定的来源 ID")
    .action(async (sourceId: string) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await getSourceHistory(await resolveVaultRoot(globalOptions), sourceId),
      );
    });

  source
    .command("impact")
    .description("显示 Source 影响的 Wiki 页面与编译任务")
    .argument("<source-id>", "稳定的来源 ID")
    .action(async (sourceId: string) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await getSourceImpact(await resolveVaultRoot(globalOptions), sourceId),
      );
    });

  source
    .command("tombstone")
    .description("逻辑删除 Source，同时保留 Snapshot 和知识影响")
    .argument("<source-id>", "稳定的来源 ID")
    .action(async (sourceId: string) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await updateSourceLifecycle(
          await resolveVaultRoot(globalOptions),
          sourceId,
          SourceLifecycleAction.Tombstone,
        ),
      );
    });

  source
    .command("restore")
    .description("恢复被逻辑删除的 Source")
    .argument("<source-id>", "稳定的来源 ID")
    .action(async (sourceId: string) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await updateSourceLifecycle(
          await resolveVaultRoot(globalOptions),
          sourceId,
          SourceLifecycleAction.Restore,
        ),
      );
    });

  source
    .command("withdraw")
    .description("逆序回滚连续编译链并逻辑删除 Source")
    .argument("<source-id>", "稳定的来源 ID")
    .action(async (sourceId: string) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await withdrawSource(
          await resolveVaultRoot(globalOptions),
          sourceId,
        ),
      );
    });

  program
    .command("validate")
    .description("校验 Lore 元数据与 OKF Bundle")
    .action(async () => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      const report = await validateVault(await resolveVaultRoot(globalOptions));
      reporter.validation(report);
      if (!report.valid) {
        process.exitCode = ExitCode.ValidationFailed;
      }
    });

  program
    .command("audit")
    .description("审计 Evidence、重复知识、来源覆盖率和遗留任务")
    .action(async () => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      const report = await auditVault(await resolveVaultRoot(globalOptions));
      reporter.audit(report);
      if (!report.healthy) {
        process.exitCode = ExitCode.ValidationFailed;
      }
    });

  program
    .command("status")
    .description("显示来源、Snapshot、页面和校验状态")
    .action(async () => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.status(
        await getVaultStatus(await resolveVaultRoot(globalOptions)),
      );
    });

  return program;
}

/** 执行 CLI；导出该函数便于未来嵌入其他 Node.js 调用方。 */
export async function run(argv: string[] = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

run().catch((error: unknown) => {
  const loreError = asLoreError(error);
  const wantsJson = process.argv.includes("--json");
  if (wantsJson) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code: loreError.code,
          message: loreError.message,
          details: loreError.details,
        },
      })}\n`,
    );
  } else {
    process.stderr.write(`错误 [${loreError.code}]：${loreError.message}\n`);
  }
  process.exitCode = loreError.exitCode;
});
