import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { TEXT_ENCODING } from "../domain/constants.js";
import { atomicWriteFile } from "./filesystem.js";

/** 以稳定顺序序列化 YAML，使 Git diff 更容易审阅。 */
export function serializeYaml(value: unknown): string {
  return stringify(value, {
    indent: 2,
    lineWidth: 0,
    sortMapEntries: true,
  });
}

/** 将 YAML 文本解析为调用方声明的领域类型。 */
export function parseYaml<T>(content: string): T {
  return parse(content) as T;
}

/** 读取并解析 YAML 文件。 */
export async function readYamlFile<T>(targetPath: string): Promise<T> {
  const content = await readFile(targetPath, TEXT_ENCODING);
  return parseYaml<T>(content);
}

/** 原子写入 YAML 文件。 */
export async function writeYamlFile(
  targetPath: string,
  value: unknown,
): Promise<void> {
  await atomicWriteFile(targetPath, serializeYaml(value));
}

/** 原子写入带末尾换行的格式化 JSON。 */
export async function writeJsonFile(
  targetPath: string,
  value: unknown,
): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await atomicWriteFile(targetPath, content);
}
