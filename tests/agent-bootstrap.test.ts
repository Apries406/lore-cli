import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentInstallAction,
  AgentKind,
  AgentSkillStatus,
  ErrorCode,
} from "../src/domain/enums.js";
import {
  agentsNeedingAutomaticInstall,
  inspectAgents,
  installAgentSkills,
} from "../src/services/agent-service.js";
import { initializeAgentFirst } from "../src/services/bootstrap-service.js";
import {
  getDefaultVault,
  getLoreConfigPath,
  readUserConfig,
  resolveVaultRoot,
} from "../src/services/lore-config-service.js";

describe("Agent-first 初始化", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((targetPath) =>
        rm(targetPath, { recursive: true, force: true }),
      ),
    );
  });

  async function temporaryDirectory(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix));
    temporaryRoots.push(root);
    return root;
  }

  it("检测 Agent、自动补齐缺失 Skills 并配置默认 Vault", async () => {
    const home = await temporaryDirectory("lore-agent-home-");
    const loreHome = await temporaryDirectory("lore-config-home-");
    const bin = path.join(home, "bin");
    await mkdir(bin);
    const codex = path.join(bin, "codex");
    await writeFile(codex, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(codex, 0o755);
    await mkdir(path.join(home, ".claude"));
    await mkdir(path.join(home, ".trae-cn"));
    const environment = {
      home,
      env: { PATH: bin, LORE_HOME: loreHome },
      platform: process.platform,
    } as const;

    const before = await inspectAgents(environment);
    expect(before.map((item) => [item.kind, item.detected])).toEqual([
      [AgentKind.Codex, true],
      [AgentKind.ClaudeCode, true],
      [AgentKind.Trae, false],
      [AgentKind.TraeCn, true],
    ]);
    expect(agentsNeedingAutomaticInstall(before)).toEqual([
      AgentKind.Codex,
      AgentKind.ClaudeCode,
      AgentKind.TraeCn,
    ]);

    const vault = path.join(home, "knowledge");
    const initialized = await initializeAgentFirst(vault, {
      auto_install: true,
      environment,
    });

    expect(initialized.resumed).toBe(false);
    expect(initialized.validation.valid).toBe(true);
    expect(initialized.agent_installations.map((item) => item.kind)).toEqual([
      AgentKind.Codex,
      AgentKind.ClaudeCode,
      AgentKind.TraeCn,
    ]);
    expect(
      initialized.agent_installations.every(
        (item) => item.action === AgentInstallAction.Installed,
      ),
    ).toBe(true);
    for (const target of [
      path.join(home, ".agents", "skills"),
      path.join(home, ".claude", "skills"),
      path.join(home, ".trae-cn", "skills"),
    ]) {
      await expect(
        readFile(path.join(target, "lore-query", "SKILL.md"), "utf8"),
      ).resolves.toContain("name: lore-query");
    }
    await expect(getDefaultVault(environment)).resolves.toBe(vault);
    await expect(
      resolveVaultRoot(undefined, path.join(home, "unrelated"), environment),
    ).resolves.toBe(vault);
    await expect(readFile(getLoreConfigPath(environment), "utf8")).resolves.toContain(
      `default_vault: ${vault}`,
    );

    const resumed = await initializeAgentFirst(vault, {
      auto_install: true,
      environment,
    });
    expect(resumed.resumed).toBe(true);
    expect(resumed.agent_installations).toEqual([]);
  });

  it("只在显式 force 时升级被修改的 Skill", async () => {
    const home = await temporaryDirectory("lore-agent-upgrade-");
    const environment = { home, env: { PATH: "" }, platform: process.platform } as const;
    await installAgentSkills([AgentKind.Codex], [], false, environment);
    const skillPath = path.join(
      home,
      ".agents",
      "skills",
      "lore-query",
      "SKILL.md",
    );
    await writeFile(skillPath, "---\nname: lore-query\ndescription: 旧版\n---\n", "utf8");

    const outdated = await inspectAgents(environment);
    const codex = outdated.find((item) => item.kind === AgentKind.Codex);
    expect(codex?.skills).toContainEqual({
      name: "lore-query",
      status: AgentSkillStatus.Outdated,
    });
    expect(agentsNeedingAutomaticInstall(outdated)).toEqual([]);
    expect(agentsNeedingAutomaticInstall(outdated, true)).toEqual([
      AgentKind.Codex,
    ]);

    const updated = await installAgentSkills(
      [AgentKind.Codex],
      [],
      true,
      environment,
    );
    expect(updated[0]).toMatchObject({
      action: AgentInstallAction.Updated,
      updated: ["lore-query"],
    });
    await expect(readFile(skillPath, "utf8")).resolves.toContain(
      "使用 Lore 的 Wiki-first 检索",
    );
  });

  it("支持其他 Agent 的任意 Skills 目录并去重重复目标", async () => {
    const target = await temporaryDirectory("lore-custom-agent-");
    const results = await installAgentSkills(
      [],
      [target, target],
      false,
      { home: await temporaryDirectory("lore-unused-home-") },
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: AgentKind.Custom,
      target,
      action: AgentInstallAction.Installed,
    });
  });

  it("拒绝读取未知版本的用户配置", async () => {
    const loreHome = await temporaryDirectory("lore-invalid-config-");
    const environment = { env: { LORE_HOME: loreHome } } as const;
    await writeFile(
      getLoreConfigPath(environment),
      "version: 99\ndefault_vault: /tmp/lore\n",
      "utf8",
    );

    await expect(readUserConfig(environment)).rejects.toMatchObject({
      code: ErrorCode.InvalidUserConfig,
    });
  });
});
