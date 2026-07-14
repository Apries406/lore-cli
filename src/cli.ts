#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { Command, Option } from "commander";
import type { ChangeSet } from "./domain/compile-models.js";
import { LORE_VERSION } from "./domain/constants.js";
import {
  ExitCode,
  OutputFormat,
  SourceKind,
} from "./domain/enums.js";
import { asLoreError } from "./errors.js";
import { findVaultRoot } from "./infrastructure/filesystem.js";
import { parseYaml } from "./infrastructure/serialization.js";
import { Reporter } from "./output/reporter.js";
import {
  addSource,
  listSources,
  showSource,
  syncSource,
} from "./services/source-service.js";
import { getVaultStatus } from "./services/status-service.js";
import { validateVault } from "./services/validation-service.js";
import { initializeVault } from "./services/vault-service.js";
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

  const source = program
    .command("source")
    .description("采集和查看原始来源");

  source
    .command("add")
    .description("采集一份不可变来源快照")
    .argument("<input>", "来源路径或 URI")
    .addOption(
      new Option("--kind <kind>", "来源类型")
        .choices(Object.values(SourceKind))
        .default(SourceKind.File),
    )
    .option("--title <title>", "来源展示标题")
    .action(async (input: string, options: SourceAddOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      const root = await resolveVaultRoot(globalOptions);
      reporter.sourceAdded(
        await addSource(root, input, {
          kind: options.kind,
          ...(options.title ? { title: options.title } : {}),
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
    .action(async (sourceId: string) => {
      const globalOptions = program.opts<GlobalOptions>();
      const reporter = new Reporter(outputFormat(globalOptions));
      reporter.sourceAdded(
        await syncSource(await resolveVaultRoot(globalOptions), sourceId),
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
