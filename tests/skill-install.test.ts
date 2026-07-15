import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../src/domain/enums.js";
import { LoreError } from "../src/errors.js";
import {
  installBundledSkills,
  listBundledSkills,
} from "../src/services/skill-service.js";

describe("Lore Skill 安装", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((targetPath) =>
        rm(targetPath, { recursive: true, force: true }),
      ),
    );
  });

  it("列出并安装全部内置 Skills", async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), "lore-skills-"));
    temporaryRoots.push(target);

    await expect(listBundledSkills()).resolves.toEqual([
      "lore-capture",
      "lore-compile",
      "lore-query",
    ]);
    const result = await installBundledSkills([], { target });

    expect(result.installed).toEqual([
      "lore-capture",
      "lore-compile",
      "lore-query",
    ]);
    expect(
      await readFile(path.join(target, "lore-query", "SKILL.md"), "utf8"),
    ).toContain("name: lore-query");
  });

  it("默认拒绝覆盖，显式 force 时允许升级", async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), "lore-skills-force-"));
    temporaryRoots.push(target);
    await installBundledSkills(["lore-query"], { target });
    await writeFile(path.join(target, "lore-query", "旧文件.txt"), "应被删除", "utf8");

    await expect(
      installBundledSkills(["lore-query"], { target }),
    ).rejects.toMatchObject<Partial<LoreError>>({ code: ErrorCode.Conflict });
    await expect(
      installBundledSkills(["lore-query"], { target, force: true }),
    ).resolves.toMatchObject({ installed: ["lore-query"] });
    await expect(
      readFile(path.join(target, "lore-query", "旧文件.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("覆盖检查在复制前完成，不留下半安装结果", async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), "lore-skills-preflight-"));
    temporaryRoots.push(target);
    await mkdir(path.join(target, "lore-query"));

    await expect(installBundledSkills([], { target })).rejects.toMatchObject<
      Partial<LoreError>
    >({ code: ErrorCode.Conflict });
    await expect(
      readFile(path.join(target, "lore-compile", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });
});
