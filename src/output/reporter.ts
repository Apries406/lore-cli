import {
  AgentInstallAction,
  OutputFormat,
  ValidationSeverity,
} from "../domain/enums.js";
import type {
  AddSourceResult,
  AuditReport,
  SourceMetadata,
  ValidationReport,
  VaultStatus,
} from "../domain/models.js";
import type { AgentFirstInitResult } from "../domain/agent-models.js";

/** Agent 安装动作的人类可读名称；JSON 输出仍保留稳定枚举值。 */
const AGENT_INSTALL_ACTION_LABELS: Readonly<Record<AgentInstallAction, string>> = {
  [AgentInstallAction.Installed]: "已安装",
  [AgentInstallAction.Updated]: "已升级",
  [AgentInstallAction.Skipped]: "已跳过",
};

export class Reporter {
  public constructor(private readonly format: OutputFormat) {}

  /** 输出通用结构；人类模式使用格式化 JSON，避免出现 `[object Object]`。 */
  public data<T>(value: T): void {
    if (this.format === OutputFormat.Json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: value })}\n`);
      return;
    }

    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  /** 输出可直接审阅的文本；JSON 模式仍使用统一信封。 */
  public text(value: string): void {
    if (this.format === OutputFormat.Json) {
      this.data(value);
      return;
    }
    process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
  }

  /** 输出初始化结果。 */
  public initialized(result: AgentFirstInitResult): void {
    if (this.format === OutputFormat.Json) {
      this.data(result);
      return;
    }

    process.stdout.write(
      `${result.resumed ? "已继续" : "已初始化"} Lore 知识库：${result.root}\n`,
    );
    process.stdout.write(`已创建 ${result.created_files.length} 个文件。\n`);
    if (result.default_vault) {
      process.stdout.write(`默认 Vault：${result.default_vault}\n`);
    }
    for (const installation of result.agent_installations) {
      process.stdout.write(
        `${installation.label}：${AGENT_INSTALL_ACTION_LABELS[installation.action]}（${installation.target}）\n`,
      );
    }
    if (result.agent_installations.length === 0) {
      process.stdout.write(
        "尚未安装 Agent Skills；可执行 lore agent install --auto 或指定 Agent。\n",
      );
    }
    process.stdout.write(
      `自检：${result.validation.valid ? "通过" : "失败"}（${result.validation.errors} 个错误，${result.validation.warnings} 个警告）\n`,
    );
  }

  /** 输出来源采集或同步结果。 */
  public sourceAdded(result: AddSourceResult): void {
    if (this.format === OutputFormat.Json) {
      this.data(result);
      return;
    }

    const sourceState = result.source_created ? "新建" : "已存在";
    const snapshotState = result.snapshot_created ? "新建" : "已存在";
    process.stdout.write(
      `来源 ${result.source.source_id}（${sourceState}）；Snapshot ${result.snapshot.snapshot_id}（${snapshotState}）。\n`,
    );
  }

  /** 输出来源列表。表格字段值属于机器协议，因此保持原始枚举值。 */
  public sources(sources: SourceMetadata[]): void {
    if (this.format === OutputFormat.Json) {
      this.data(sources);
      return;
    }

    if (sources.length === 0) {
      process.stdout.write("尚未采集任何来源。\n");
      return;
    }

    for (const source of sources) {
      process.stdout.write(
        `${source.source_id}\t${source.kind}\t${source.status}\t${source.title}\n`,
      );
    }
  }

  /** 输出校验摘要和逐条诊断。 */
  public validation(report: ValidationReport): void {
    if (this.format === OutputFormat.Json) {
      this.data(report);
      return;
    }

    const state = report.valid ? "有效" : "无效";
    process.stdout.write(
      `知识库${state}：${report.errors} 个错误，${report.warnings} 个警告。\n`,
    );
    for (const item of report.diagnostics) {
      const severity =
        item.severity === ValidationSeverity.Error ? "错误" : "警告";
      process.stdout.write(
        `${severity} ${item.code} ${item.path}：${item.message}\n`,
      );
    }
  }

  /** 输出长期健康审计与覆盖率。 */
  public audit(report: AuditReport): void {
    if (this.format === OutputFormat.Json) {
      this.data(report);
      return;
    }

    process.stdout.write(
      `长期健康：${report.healthy ? "健康" : "需要处理"}，${report.errors} 个错误，${report.warnings} 个警告。\n`,
    );
    process.stdout.write(
      `覆盖率：${report.coverage.sources} 个来源，${report.coverage.snapshots} 个 Snapshot，${report.coverage.latest_snapshots_compiled} 个 latest 已编译；${report.coverage.wiki_pages} 个页面中 ${report.coverage.pages_with_evidence} 个具有 Evidence。\n`,
    );
    for (const item of report.diagnostics) {
      const severity =
        item.severity === ValidationSeverity.Error ? "错误" : "警告";
      process.stdout.write(
        `${severity} ${item.code} ${item.path}：${item.message}\n`,
      );
    }
  }

  /** 输出 Vault 的最小健康状态。 */
  public status(status: VaultStatus): void {
    if (this.format === OutputFormat.Json) {
      this.data(status);
      return;
    }

    process.stdout.write(`Lore 知识库：${status.root}\n`);
    process.stdout.write(`来源数：${status.sources}\n`);
    process.stdout.write(`Snapshot 数：${status.snapshots}\n`);
    process.stdout.write(`Wiki 页面数：${status.wiki_pages}\n`);
    process.stdout.write(
      `校验：${status.validation.valid ? "有效" : "无效"}（${status.validation.errors} 个错误，${status.validation.warnings} 个警告）\n`,
    );
    process.stdout.write(
      `长期健康：${status.audit.healthy ? "健康" : "需要处理"}（${status.audit.errors} 个错误，${status.audit.warnings} 个警告；${status.audit.latest_snapshots_compiled} 个 latest 已编译，${status.audit.incomplete_compile_runs} 个未结束任务）\n`,
    );
  }
}
