#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import type { ChangeSet } from "./domain/compile-models.js";
import {
  DEFAULT_COLD_KNOWLEDGE_DAYS,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_DASHBOARD_WINDOW_DAYS,
  DEFAULT_QUERY_RESULT_LIMIT,
  LORE_VERSION,
} from "./domain/constants.js";
import {
  AgentKind,
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
import { auditVault } from "./services/audit-service.js";
import { withdrawSource } from "./services/source-impact-service.js";
import {
  installBundledSkills,
  listBundledSkills,
} from "./services/skill-service.js";
import {
  agentsNeedingAutomaticInstall,
  inspectAgents,
  installAgentSkills,
  parseAgentKind,
  SUPPORTED_AGENT_KINDS,
} from "./services/agent-service.js";
import { initializeAgentFirst } from "./services/bootstrap-service.js";
import {
  getDefaultNewVaultPath,
  getDefaultVault,
  resolveVaultRoot as resolveConfiguredVaultRoot,
  setDefaultVault,
} from "./services/lore-config-service.js";
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
import { getDashboardSnapshot } from "./services/dashboard-service.js";
import {
  openDashboardInBrowser,
  startDashboardServer,
} from "./services/dashboard-server.js";

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
  track?: boolean;
}

interface DashboardCommandOptions {
  host: string;
  port: string;
  window: string;
  cold: string;
  open?: boolean;
}

interface SkillInstallOptions {
  target?: string;
  force?: boolean;
}

interface AgentSelectionOptions {
  agent?: string[];
  skillTarget?: string[];
  autoInstall?: boolean;
  forceSkills?: boolean;
  interactive?: boolean;
}

interface InitOptions extends AgentSelectionOptions {
  agentInstall?: boolean;
  setDefault?: boolean;
}

/** Commander 可重复选项的无副作用收集器。 */
function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
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
async function resolveCompatibleVaultRoot(options: GlobalOptions): Promise<string> {
  const root = await resolveConfiguredVaultRoot(options.root, process.cwd());
  await assertVaultCompatible(root);
  return root;
}

/** 只定位 Vault，不执行版本门禁；仅供 migrate 命令使用。 */
async function locateVaultRoot(options: GlobalOptions): Promise<string> {
  return resolveConfiguredVaultRoot(options.root, process.cwd());
}

/** 交互展示 Agent 检测结果，并接受编号、名称或 other 自定义路径。 */
async function promptForAgentSelection(): Promise<{
  agents: AgentKind[];
  customTargets: string[];
}> {
  const inspections = await inspectAgents();
  process.stdout.write("\n检测到以下 Agent 环境：\n");
  inspections.forEach((item, index) => {
    const state = item.detected ? "已检测" : "未检测";
    const skillState = item.ready
      ? "Lore Skills 已就绪"
      : `缺少 ${item.missing_skills.length} 个，旧版 ${item.outdated_skills.length} 个`;
    process.stdout.write(
      `${index + 1}. ${item.label}（${item.kind}）：${state}，${skillState}\n`,
    );
  });
  process.stdout.write("5. 其他 Agent：使用 custom=/path/to/skills\n");
  const recommended = agentsNeedingAutomaticInstall(inspections);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await terminal.question(
        `请选择要安装的编号或名称（逗号分隔；回车使用检测结果 ${recommended.join(",") || "无"}；none 跳过）：`,
      )
    ).trim();
    if (answer.toLocaleLowerCase() === "none") {
      return { agents: [], customTargets: [] };
    }
    const tokens = answer
      ? answer.split(/[\s,，]+/u).filter(Boolean)
      : recommended;
    const selected = new Set<AgentKind>();
    const customTargets: string[] = [];
    let wantsCustomTarget = false;
    for (const tokenValue of tokens) {
      const rawToken = String(tokenValue);
      const token = rawToken.toLocaleLowerCase();
      if (token === "all") {
        SUPPORTED_AGENT_KINDS.forEach((kind) => selected.add(kind));
      } else if (token === "detected") {
        inspections
          .filter((item) => item.detected)
          .forEach((item) => selected.add(item.kind));
      } else if (token === "5" || token === "other" || token === "custom") {
        wantsCustomTarget = true;
      } else if (token.startsWith("custom=") || token.startsWith("other=")) {
        const customTarget = rawToken.slice(rawToken.indexOf("=") + 1).trim();
        if (!customTarget) {
          throw new InvalidArgumentError("其他 Agent 的 Skills 目录不能为空");
        }
        customTargets.push(customTarget);
      } else if (/^[1-4]$/u.test(token)) {
        const inspection = inspections[Number(token) - 1];
        if (inspection) {
          selected.add(inspection.kind);
        }
      } else {
        selected.add(parseAgentKind(token));
      }
    }
    if (wantsCustomTarget) {
      const customTarget = (
        await terminal.question("请输入其他 Agent 的用户级 Skills 目录：")
      ).trim();
      if (!customTarget) {
        throw new InvalidArgumentError("其他 Agent 的 Skills 目录不能为空");
      }
      customTargets.push(customTarget);
    }
    return { agents: [...selected], customTargets };
  } finally {
    terminal.close();
  }
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
    .description("初始化默认 Vault 并为 Agent 安装 Lore Skills")
    .argument("[path]", "目标目录；默认使用用户级 Lore 数据目录")
    .option(
      "--agent <agent>",
      `安装目标，可重复：${SUPPORTED_AGENT_KINDS.join("、")}`,
      collectOption,
      [],
    )
    .option("--skill-target <path>", "其他 Agent 的 Skills 目录，可重复", collectOption, [])
    .option("--auto-install", "自动为检测到且缺少 Lore Skills 的 Agent 安装")
    .option("--force-skills", "升级目标中已存在但版本不同的 Lore Skills")
    .option("--interactive", "强制显示 Agent 选择提示")
    .option("--no-agent-install", "只初始化 Vault，不安装 Agent Skills")
    .option("--no-set-default", "不将本次 Vault 设为用户默认值")
    .action(async (targetPath: string | undefined, options: InitOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      if (options.interactive === true && globalOptions.json === true) {
        throw new InvalidArgumentError("--interactive 不能与 --json 同时使用");
      }
      let agents = (options.agent ?? []).map(parseAgentKind);
      let customTargets = options.skillTarget ?? [];
      const shouldPrompt =
        options.agentInstall !== false &&
        options.autoInstall !== true &&
        agents.length === 0 &&
        customTargets.length === 0 &&
        (options.interactive === true ||
          (process.stdin.isTTY && process.stdout.isTTY && globalOptions.json !== true));
      if (shouldPrompt) {
        const selected = await promptForAgentSelection();
        agents = selected.agents;
        customTargets = selected.customTargets;
      }
      const reporter = new Reporter(outputFormat(program.opts<GlobalOptions>()));
      reporter.initialized(
        await initializeAgentFirst(targetPath ?? getDefaultNewVaultPath(), {
          agents: options.agentInstall === false ? [] : agents,
          custom_targets: options.agentInstall === false ? [] : customTargets,
          auto_install:
            options.agentInstall !== false && options.autoInstall === true,
          force_skills: options.forceSkills === true,
          set_default: options.setDefault !== false,
        }),
      );
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
    .description("安装一个或全部内置 Skill 到指定目录")
    .argument("[names...]", "Skill 名称；省略时安装全部")
    .option("--target <path>", "安装目录；默认 ~/.agents/skills")
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

  const agent = program
    .command("agent")
    .description("检测 Agent 并管理 Lore Skills");

  agent
    .command("status")
    .description("检查 Codex、Claude Code 和 TRAE 的 Lore Skills 状态")
    .action(async () => {
      const reporter = new Reporter(outputFormat(program.opts<GlobalOptions>()));
      reporter.data(await inspectAgents());
    });

  agent
    .command("install")
    .description("向选定或自动检测到的 Agent 安装 Lore Skills")
    .argument("[agents...]", `Agent：${SUPPORTED_AGENT_KINDS.join("、")}`)
    .option("--auto", "只处理检测到且缺少 Lore Skills 的 Agent")
    .option("--target <path>", "其他 Agent 的 Skills 目录，可重复", collectOption, [])
    .option("--force", "升级已存在但版本不同的 Lore Skills")
    .option("--interactive", "强制显示 Agent 选择提示")
    .action(async (
      agentValues: string[],
      options: {
        auto?: boolean;
        target?: string[];
        force?: boolean;
        interactive?: boolean;
      },
    ) => {
      const globalOptions = program.opts<GlobalOptions>();
      if (options.interactive === true && globalOptions.json === true) {
        throw new InvalidArgumentError("--interactive 不能与 --json 同时使用");
      }
      let agents = agentValues.map(parseAgentKind);
      let customTargets = options.target ?? [];
      const shouldPrompt =
        options.auto !== true &&
        agents.length === 0 &&
        customTargets.length === 0 &&
        (options.interactive === true ||
          (process.stdin.isTTY && process.stdout.isTTY && globalOptions.json !== true));
      if (shouldPrompt) {
        const selected = await promptForAgentSelection();
        agents = selected.agents;
        customTargets = selected.customTargets;
      } else if (options.auto === true) {
        agents = agentsNeedingAutomaticInstall(
          await inspectAgents(),
          options.force === true,
        );
      }
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await installAgentSkills(
          agents,
          customTargets,
          options.force === true,
        ),
      );
    });

  const vault = program
    .command("vault")
    .description("管理 Agent 在任意目录使用的默认 Vault");

  vault
    .command("default")
    .description("显示当前默认 Vault")
    .action(async () => {
      const reporter = new Reporter(outputFormat(program.opts<GlobalOptions>()));
      reporter.data({ default_vault: await getDefaultVault() });
    });

  vault
    .command("use")
    .description("设置默认 Vault")
    .argument("<path>", "Vault 根目录或其内部路径")
    .action(async (targetPath: string) => {
      const root = await findVaultRoot(targetPath);
      await assertVaultCompatible(root);
      const reporter = new Reporter(outputFormat(program.opts<GlobalOptions>()));
      reporter.data(await setDefaultVault(root));
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
      const root = await resolveCompatibleVaultRoot(globalOptions);
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
        await addSource(await resolveCompatibleVaultRoot(globalOptions), text, {
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
          await resolveCompatibleVaultRoot(globalOptions),
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
        await showWikiPage(await resolveCompatibleVaultRoot(globalOptions), relativePath),
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
          await resolveCompatibleVaultRoot(globalOptions),
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
    .description("为查询 Skill 准备上下文并记录本地召回统计")
    .argument("<question>", "需要回答的问题")
    .addOption(
      new Option("--fallback <mode>", "Raw 回退模式")
        .choices(Object.values(RawFallbackMode))
        .default(RawFallbackMode.Auto),
    )
    .option("--wiki-limit <number>", "最大 Wiki 候选数")
    .option("--raw-limit <number>", "最大 Raw 摘录数")
    .option("--no-track", "本次查询不写入本地召回统计")
    .action(async (question: string, options: QueryPrepareOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      const maxWikiResults = optionalPositiveInteger(options.wikiLimit);
      const maxRawResults = optionalPositiveInteger(options.rawLimit);
      reporter.data(
        await prepareQuery(await resolveCompatibleVaultRoot(globalOptions), question, {
          fallback_mode: options.fallback,
          ...(maxWikiResults ? { max_wiki_results: maxWikiResults } : {}),
          ...(maxRawResults ? { max_raw_results: maxRawResults } : {}),
          track_usage: options.track !== false,
        }),
      );
    });

  const usage = program
    .command("usage")
    .description("查看 Agent 查询的本地召回统计");

  usage
    .command("stats")
    .description("输出 Dashboard 使用的聚合数据")
    .option(
      "--window <days>",
      "近期统计窗口天数",
      String(DEFAULT_DASHBOARD_WINDOW_DAYS),
    )
    .option(
      "--cold <days>",
      "冷知识判定天数",
      String(DEFAULT_COLD_KNOWLEDGE_DAYS),
    )
    .action(async (options: { window: string; cold: string }) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await getDashboardSnapshot(await resolveCompatibleVaultRoot(globalOptions), {
          window_days:
            optionalPositiveInteger(options.window) ?? DEFAULT_DASHBOARD_WINDOW_DAYS,
          cold_after_days:
            optionalPositiveInteger(options.cold) ?? DEFAULT_COLD_KNOWLEDGE_DAYS,
        }),
      );
    });

  program
    .command("dashboard")
    .description("启动本机 Lore Web Dashboard")
    .option("--host <host>", "监听地址，仅允许回环地址", "127.0.0.1")
    .option("--port <number>", "监听端口", String(DEFAULT_DASHBOARD_PORT))
    .option(
      "--window <days>",
      "默认统计窗口天数",
      String(DEFAULT_DASHBOARD_WINDOW_DAYS),
    )
    .option(
      "--cold <days>",
      "默认冷知识判定天数",
      String(DEFAULT_COLD_KNOWLEDGE_DAYS),
    )
    .option("--no-open", "不自动打开系统浏览器")
    .action(async (options: DashboardCommandOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const root = await resolveCompatibleVaultRoot(globalOptions);
      const handle = await startDashboardServer(root, {
        host: options.host,
        port: optionalPositiveInteger(options.port) ?? DEFAULT_DASHBOARD_PORT,
        window_days:
          optionalPositiveInteger(options.window) ?? DEFAULT_DASHBOARD_WINDOW_DAYS,
        cold_after_days:
          optionalPositiveInteger(options.cold) ?? DEFAULT_COLD_KNOWLEDGE_DAYS,
      });
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data({ url: handle.url, root, tracking: "local" });
      if (options.open !== false) {
        await openDashboardInBrowser(handle.url).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`无法自动打开浏览器，请手动访问 ${handle.url}：${message}\n`);
        });
      }
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
        await prepareCompile(await resolveCompatibleVaultRoot(globalOptions), sourceId, {
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
          await resolveCompatibleVaultRoot(globalOptions),
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
      const root = await resolveCompatibleVaultRoot(globalOptions);
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
          await resolveCompatibleVaultRoot(globalOptions),
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
        await readCompileDiff(await resolveCompatibleVaultRoot(globalOptions), runId),
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
        await applyCompile(await resolveCompatibleVaultRoot(globalOptions), runId),
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
        await rollbackCompile(await resolveCompatibleVaultRoot(globalOptions), runId),
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
          await resolveCompatibleVaultRoot(globalOptions),
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
      reporter.sources(await listSources(await resolveCompatibleVaultRoot(globalOptions)));
    });

  source
    .command("show")
    .description("显示来源元数据及其最新 Snapshot")
    .argument("<source-id>", "稳定的来源 ID")
    .action(async (sourceId: string) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.data(
        await showSource(await resolveCompatibleVaultRoot(globalOptions), sourceId),
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
        await getSourceHistory(await resolveCompatibleVaultRoot(globalOptions), sourceId),
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
        await getSourceImpact(await resolveCompatibleVaultRoot(globalOptions), sourceId),
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
          await resolveCompatibleVaultRoot(globalOptions),
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
          await resolveCompatibleVaultRoot(globalOptions),
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
          await resolveCompatibleVaultRoot(globalOptions),
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
      const report = await validateVault(await resolveCompatibleVaultRoot(globalOptions));
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
      const report = await auditVault(await resolveCompatibleVaultRoot(globalOptions));
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
        await getVaultStatus(await resolveCompatibleVaultRoot(globalOptions)),
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
