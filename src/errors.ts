import { ErrorCode, ExitCode } from "./domain/enums.js";

/**
 * Lore 业务错误。
 *
 * code 面向 Agent/脚本保持稳定，message 面向人展示中文说明，exitCode
 * 则让 shell 调用方无需解析文本即可判断错误类别。
 */
export class LoreError extends Error {
  public readonly code: ErrorCode;
  public readonly exitCode: ExitCode;
  public readonly details?: unknown;

  public constructor(
    code: ErrorCode,
    message: string,
    exitCode: ExitCode,
    details?: unknown,
  ) {
    super(message);
    this.name = "LoreError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

/** 将未知异常收敛为 LoreError，避免 CLI 泄漏不稳定的异常结构。 */
export function asLoreError(error: unknown): LoreError {
  if (error instanceof LoreError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new LoreError(ErrorCode.Internal, message, ExitCode.Internal);
}
