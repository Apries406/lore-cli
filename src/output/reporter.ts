import { OutputFormat, ValidationSeverity } from "../domain/enums.js";
import type {
  AddSourceResult,
  SourceMetadata,
  ValidationReport,
  VaultStatus,
} from "../domain/models.js";

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

  /** 输出初始化结果。 */
  public initialized(result: {
    root: string;
    created_files: string[];
    existing_files: string[];
  }): void {
    if (this.format === OutputFormat.Json) {
      this.data(result);
      return;
    }

    process.stdout.write(`已在 ${result.root} 初始化 Lore 知识库。\n`);
    process.stdout.write(`已创建 ${result.created_files.length} 个文件。\n`);
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
  }
}
