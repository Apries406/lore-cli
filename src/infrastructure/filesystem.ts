import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { lstatSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_MAX_PARENT_SEARCH_DEPTH,
  TEXT_ENCODING,
} from "../domain/constants.js";
import { ErrorCode, ExitCode, VaultFileName } from "../domain/enums.js";
import { LoreError } from "../errors.js";

/** 判断路径是否存在；无论文件还是目录都返回 true。 */
export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** 递归创建目录，目录已存在时保持幂等。 */
export async function ensureDirectory(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
}

/**
 * 断言目标路径仍位于指定根目录内。
 * 所有由知识内容或 Agent 输入派生出的写入路径都必须通过此检查。
 */
export function assertPathWithinRoot(root: string, targetPath: string): void {
  const relativePath = path.relative(path.resolve(root), path.resolve(targetPath));
  const escapesRoot =
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);

  if (escapesRoot) {
    throw new LoreError(
      ErrorCode.PathEscapesVault,
      `路径越出了知识库根目录：${targetPath}`,
      ExitCode.InvalidArgument,
    );
  }
}

/** 安全拼接根目录内的路径，并拒绝 `..` 等路径逃逸。 */
export function safeJoin(root: string, ...segments: string[]): string {
  const targetPath = path.resolve(root, ...segments);
  assertPathWithinRoot(root, targetPath);
  const resolvedRoot = path.resolve(root);
  const relativePath = path.relative(resolvedRoot, targetPath);
  let currentPath = resolvedRoot;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    try {
      if (lstatSync(currentPath).isSymbolicLink()) {
        throw new LoreError(
          ErrorCode.PathEscapesVault,
          `知识库内部路径不能经过符号链接：${currentPath}`,
          ExitCode.InvalidArgument,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }
  }
  return targetPath;
}

/**
 * 先写临时文件再 rename，避免进程中断后留下半写文件。
 * 同一文件系统内 rename 具有原子替换语义。
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string | Buffer,
): Promise<void> {
  await ensureDirectory(path.dirname(targetPath));
  const temporaryPath = `${targetPath}.tmp-${randomUUID()}`;

  try {
    await writeFile(temporaryPath, content);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 仅在目标不存在时写入，返回本次是否真正创建了文件。 */
export async function writeFileIfAbsent(
  targetPath: string,
  content: string | Buffer,
): Promise<boolean> {
  if (await pathExists(targetPath)) {
    return false;
  }

  await atomicWriteFile(targetPath, content);
  return true;
}

/** 以统一编码读取文本。 */
export async function readTextFile(targetPath: string): Promise<string> {
  return readFile(targetPath, TEXT_ENCODING);
}

/**
 * 获取真实的本地文件路径。
 * realpath 会消除符号链接差异，保证同一文件生成同一个 canonical URI。
 */
export async function canonicalFilePath(targetPath: string): Promise<string> {
  const resolvedPath = path.resolve(targetPath);
  const fileStat = await stat(resolvedPath).catch(() => undefined);

  if (!fileStat?.isFile()) {
    throw new LoreError(
      ErrorCode.SourceNotFound,
      `来源文件不存在或不是普通文件：${resolvedPath}`,
      ExitCode.NotFound,
    );
  }

  return realpath(resolvedPath);
}

/** 从当前目录逐级向上寻找 lore.yaml，以定位 Vault 根目录。 */
export async function findVaultRoot(startPath: string): Promise<string> {
  let currentPath = path.resolve(startPath);

  for (let depth = 0; depth < DEFAULT_MAX_PARENT_SEARCH_DEPTH; depth += 1) {
    const configPath = path.join(currentPath, VaultFileName.Config);
    if (await pathExists(configPath)) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  throw new LoreError(
    ErrorCode.VaultNotFound,
    `从 ${path.resolve(startPath)} 向上未找到 ${VaultFileName.Config}`,
    ExitCode.NotFound,
  );
}
