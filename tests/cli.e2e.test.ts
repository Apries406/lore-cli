import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface JsonEnvelope<T> {
  ok: boolean;
  data: T;
}

interface RunCliOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/** 端到端工作流会启动多个独立 Node 进程，给较慢的 CI 留出稳定余量。 */
const CLI_WORKFLOW_TIMEOUT_MILLISECONDS = 15_000;

describe("Lore CLI", () => {
  const temporaryRoots: string[] = [];
  const repositoryRoot = process.cwd();
  let isolatedLoreHome = "";

  beforeEach(async () => {
    isolatedLoreHome = await temporaryDirectory("lore-cli-config-");
  });

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

  function runCli(arguments_: string[], options: RunCliOptions = {}): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...arguments_],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          LORE_HOME: isolatedLoreHome,
          ...options.env,
        },
        ...(options.input === undefined ? {} : { input: options.input }),
      },
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

    const migration = runCli([
      "--json",
      "--root",
      vault,
      "migrate",
      "status",
    ]);
    expect(migration.status).toBe(0);
    expect(JSON.parse(migration.stdout)).toMatchObject({
      data: { required: false },
    });

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

    const audit = runCli(["--json", "--root", vault, "audit"]);
    expect(audit.status).toBe(0);
    expect(JSON.parse(audit.stdout)).toMatchObject({
      ok: true,
      data: {
        healthy: true,
        warnings: 1,
        coverage: { latest_snapshots_compiled: 0 },
      },
    });

    expect(
      JSON.parse(
        runCli([
          "--json",
          "--root",
          vault,
          "source",
          "history",
          addedEnvelope.data.source.source_id,
        ]).stdout,
      ),
    ).toMatchObject({ data: { snapshots: [{ snapshot_id: expect.any(String) }] } });
    expect(
      runCli([
        "--json",
        "--root",
        vault,
        "source",
        "tombstone",
        addedEnvelope.data.source.source_id,
      ]).status,
    ).toBe(0);
    expect(
      runCli([
        "--json",
        "--root",
        vault,
        "source",
        "restore",
        addedEnvelope.data.source.source_id,
      ]).status,
    ).toBe(0);

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
  }, CLI_WORKFLOW_TIMEOUT_MILLISECONDS);

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
        query_id: expect.stringMatching(/^qry_/u),
        usage_tracked: true,
        wiki_candidates: [{ path: "wiki/pages/two-layer-model.md" }],
        fallback: { used: false },
      },
    });
    const usage = runCli([
      "--json",
      "--root",
      vault,
      "usage",
      "stats",
      "--window",
      "30",
    ]);
    expect(usage.status).toBe(0);
    expect(JSON.parse(usage.stdout)).toMatchObject({
      data: {
        usage: { tracked_queries: 1 },
        pages: [
          {
            path: "wiki/pages/two-layer-model.md",
            recall_count: 1,
          },
        ],
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
  }, CLI_WORKFLOW_TIMEOUT_MILLISECONDS);

  it("Agent-first init 自动检测、安装、配置默认 Vault 且可安全重入", async () => {
    const home = await temporaryDirectory("lore-cli-agent-home-");
    const loreHome = await temporaryDirectory("lore-cli-agent-config-");
    const vault = path.join(home, "vault");
    const customTarget = path.join(home, "other-agent", "skills");
    await mkdir(path.join(home, ".codex"));
    await mkdir(path.join(home, ".claude"));
    await mkdir(path.join(home, ".trae-cn"));
    const env = { HOME: home, LORE_HOME: loreHome, PATH: "" };

    const initialized = runCli(
      [
        "--json",
        "init",
        vault,
        "--auto-install",
        "--skill-target",
        customTarget,
      ],
      { env },
    );
    expect(initialized.status).toBe(0);
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      data: {
        root: vault,
        resumed: false,
        default_vault: vault,
        validation: { valid: true },
        agent_installations: [
          { kind: "codex", action: "installed" },
          { kind: "claude-code", action: "installed" },
          { kind: "trae-cn", action: "installed" },
          { kind: "custom", target: customTarget, action: "installed" },
        ],
      },
    });
    for (const target of [
      path.join(home, ".agents", "skills"),
      path.join(home, ".claude", "skills"),
      path.join(home, ".trae-cn", "skills"),
      customTarget,
    ]) {
      await expect(
        readFile(path.join(target, "lore-compile", "SKILL.md"), "utf8"),
      ).resolves.toContain("name: lore-compile");
    }

    const status = runCli(["--json", "status"], { env });
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      data: { root: vault, validation: { valid: true } },
    });
    const resumed = runCli(["--json", "init", vault, "--auto-install"], {
      env,
    });
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      data: { resumed: true, agent_installations: [] },
    });
  });

  it("init 允许交互选择内置 Agent 和任意 Skills 目录", async () => {
    const home = await temporaryDirectory("lore-cli-interactive-home-");
    const vault = path.join(home, "vault");
    const customTarget = path.join(home, "other-agent", "skills");
    const env = { HOME: home, PATH: "" };

    const initialized = runCli(["init", vault, "--interactive"], {
      env,
      input: `1,2,custom=${customTarget}\n`,
    });
    expect(initialized.status).toBe(0);
    expect(initialized.stderr).toBe("");
    expect(initialized.stdout).toContain("Codex");
    expect(initialized.stdout).toContain("Claude Code");
    expect(initialized.stdout).toContain("其他 Agent");

    for (const target of [
      path.join(home, ".agents", "skills"),
      path.join(home, ".claude", "skills"),
      customTarget,
    ]) {
      await expect(
        readFile(path.join(target, "lore-query", "SKILL.md"), "utf8"),
      ).resolves.toContain("name: lore-query");
    }
  });
});
