import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface JsonEnvelope<T> {
  ok: boolean;
  data: T;
}

describe("Lore CLI", () => {
  const temporaryRoots: string[] = [];
  const repositoryRoot = process.cwd();

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((targetPath) =>
        rm(targetPath, { recursive: true, force: true }),
      ),
    );
  });

  async function temporaryDirectory(prefix: string): Promise<string> {
    const targetPath = await mkdtemp(path.join(os.tmpdir(), prefix));
    temporaryRoots.push(targetPath);
    return targetPath;
  }

  function runCli(arguments_: string[]): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...arguments_],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  it("以完整 JSON 工作流执行 init、source add、status 和 validate", async () => {
    const vault = await temporaryDirectory("lore-cli-vault-");
    const inputDirectory = await temporaryDirectory("lore-cli-input-");
    const inputPath = path.join(inputDirectory, "source.md");
    await writeFile(inputPath, "# 来源\n", "utf8");

    const initialized = runCli(["--json", "init", vault]);
    expect(initialized.status).toBe(0);
    expect(JSON.parse(initialized.stdout)).toMatchObject({ ok: true });

    const added = runCli([
      "--json",
      "--root",
      vault,
      "source",
      "add",
      inputPath,
    ]);
    expect(added.status).toBe(0);
    const addedEnvelope = JSON.parse(added.stdout) as JsonEnvelope<{
      source: { source_id: string };
    }>;
    expect(addedEnvelope.data.source.source_id).toMatch(/^src_/u);

    const status = runCli(["--json", "--root", vault, "status"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      ok: true,
      data: {
        sources: 1,
        snapshots: 1,
        wiki_pages: 0,
        validation: { valid: true },
      },
    });

    const validation = runCli(["--json", "--root", vault, "validate"]);
    expect(validation.status).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({
      ok: true,
      data: { valid: true, errors: 0 },
    });
  });
});
