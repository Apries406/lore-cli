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

  it("通过 CLI 完成知识编译、审阅、应用和回滚", async () => {
    const vault = await temporaryDirectory("lore-cli-compile-vault-");
    const inputDirectory = await temporaryDirectory("lore-cli-compile-input-");
    const inputPath = path.join(inputDirectory, "source.md");
    const content = "Raw 保存不可变证据。\nWiki 保存可演进知识。\n";
    await writeFile(inputPath, content, "utf8");
    expect(runCli(["--json", "init", vault]).status).toBe(0);

    const added = JSON.parse(
      runCli(["--json", "--root", vault, "source", "add", inputPath]).stdout,
    ) as JsonEnvelope<{
      source: { source_id: string };
    }>;
    const preparedResult = runCli([
      "--json",
      "--root",
      vault,
      "compile",
      "prepare",
      added.data.source.source_id,
    ]);
    expect(preparedResult.status).toBe(0);
    const prepared = JSON.parse(preparedResult.stdout) as JsonEnvelope<{
      run: { run_id: string };
      packet: {
        vault: { base_revision: { wiki_sha256: string } };
        input: {
          source: { source_id: string };
          snapshot: { snapshot_id: string };
        };
      };
    }>;
    const changeSetPath = path.join(inputDirectory, "change-set.yaml");
    const evidence = JSON.parse(
      runCli([
        "--json",
        "--root",
        vault,
        "compile",
        "evidence",
        prepared.data.run.run_id,
        "--locator",
        "line:1-2",
      ]).stdout,
    ) as JsonEnvelope<{ quote_sha256: string }>;
    await writeFile(
      changeSetPath,
      JSON.stringify({
        version: 1,
        run_id: prepared.data.run.run_id,
        base_revision: prepared.data.packet.vault.base_revision,
        operation: "compile",
        inputs: [
          {
            source_id: prepared.data.packet.input.source.source_id,
            snapshot_id: prepared.data.packet.input.snapshot.snapshot_id,
          },
        ],
        summary: "沉淀双层知识模型",
        changes: [
          {
            action: "create",
            target: { path: "wiki/pages/two-layer-model.md" },
            reason: "形成可复用知识",
            concept: {
              type: "concept",
              title: "双层知识模型",
              lore: {
                evidence: [
                  {
                    id: "ev_two_layers",
                    source_id: prepared.data.packet.input.source.source_id,
                    snapshot_id: prepared.data.packet.input.snapshot.snapshot_id,
                    locator: "line:1-2",
                    quote_sha256: evidence.data.quote_sha256,
                  },
                ],
              },
              body: "# 双层知识模型\n\nRaw 与 Wiki 各自承担不同职责。",
            },
          },
        ],
      }),
      "utf8",
    );

    const submitted = runCli([
      "--json",
      "--root",
      vault,
      "compile",
      "submit",
      prepared.data.run.run_id,
      "--file",
      changeSetPath,
    ]);
    expect(submitted.status).toBe(0);
    expect(JSON.parse(submitted.stdout)).toMatchObject({
      data: { run: { status: "validated" }, validation: { valid: true } },
    });
    expect(
      JSON.parse(
        runCli([
          "--json",
          "--root",
          vault,
          "diff",
          prepared.data.run.run_id,
        ]).stdout,
      ).data,
    ).toContain("two-layer-model.md");
    expect(
      runCli([
        "--json",
        "--root",
        vault,
        "apply",
        prepared.data.run.run_id,
      ]).status,
    ).toBe(0);
    expect(JSON.parse(runCli(["--json", "--root", vault, "status"]).stdout)).toMatchObject({
      data: { wiki_pages: 1, validation: { valid: true } },
    });
    const query = runCli([
      "--json",
      "--root",
      vault,
      "query",
      "prepare",
      "双层知识模型是什么？",
    ]);
    expect(query.status).toBe(0);
    expect(JSON.parse(query.stdout)).toMatchObject({
      data: {
        wiki_candidates: [{ path: "wiki/pages/two-layer-model.md" }],
        fallback: { used: false },
      },
    });
    expect(
      runCli([
        "--json",
        "--root",
        vault,
        "rollback",
        prepared.data.run.run_id,
      ]).status,
    ).toBe(0);
  });
});
