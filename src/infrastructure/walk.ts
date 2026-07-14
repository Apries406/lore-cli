import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * 递归枚举目录内的普通文件，并返回稳定排序结果。
 * 目录不存在时返回空数组，方便空 Vault 保持正常状态。
 */
export async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}
