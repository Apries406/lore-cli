import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../src/domain/enums.js";
import {
  addVaultRemote,
  cloneVault,
  getVaultSyncStatus,
  syncVault,
} from "../src/services/git-sync-service.js";
import { initializeVault } from "../src/services/vault-service.js";

describe("Git Vault 同步", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((targetPath) =>
        rm(targetPath, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        }),
      ),
    );
  });

  async function temporaryDirectory(prefix: string): Promise<string> {
    const targetPath = await mkdtemp(path.join(os.tmpdir(), prefix));
    temporaryRoots.push(targetPath);
    return targetPath;
  }

  function git(root: string, ...arguments_: string[]): string {
    return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
  }

  async function createRemote(): Promise<string> {
    const remote = await temporaryDirectory("lore-remote-");
    git(remote, "init", "--bare", "--initial-branch=main");
    return remote;
  }

  function configureIdentity(root: string): void {
    git(root, "config", "user.name", "Lore Test");
    git(root, "config", "user.email", "lore@example.com");
  }

  it("初始化远端并只提交可迁移的 Vault 数据", async () => {
    const root = await temporaryDirectory("lore-sync-vault-");
    const remote = await createRemote();
    await initializeVault(root);
    await writeFile(path.join(root, ".lore", "local-only.txt"), "private\n", "utf8");
    await addVaultRemote(root, "origin", remote);
    configureIdentity(root);

    const result = await syncVault(root, {
      remote: "origin",
      branch: "main",
      now: new Date("2026-07-14T00:00:00.000Z"),
    });

    expect(result).toMatchObject({ action: "pushed", ahead: 0, behind: 0 });
    expect(git(root, "ls-files").split("\n")).not.toContain(".lore/local-only.txt");
    expect(git(remote, "show", "main:lore.yaml")).toContain("version:");
    expect(git(remote, "ls-tree", "-r", "--name-only", "main").split("\n"))
      .not.toContain(".lore/local-only.txt");

    git(root, "add", "-f", ".lore/local-only.txt");
    await expect(syncVault(root, { branch: "main" })).rejects.toMatchObject({
      code: ErrorCode.ValidationFailed,
    });
  });

  it("在另一台设备 clone 后执行 fast-forward 同步", async () => {
    const first = await temporaryDirectory("lore-sync-first-");
    const remote = await createRemote();
    await initializeVault(first);
    await addVaultRemote(first, "origin", remote);
    configureIdentity(first);
    await syncVault(first, { branch: "main" });

    const parent = await temporaryDirectory("lore-sync-clone-parent-");
    const second = path.join(parent, "vault");
    await cloneVault(remote, second, { branch: "main" });
    configureIdentity(second);
    await writeFile(path.join(first, "schema", "shared.md"), "# 已同步\n", "utf8");
    await syncVault(first, { branch: "main" });

    const pulled = await syncVault(second, { branch: "main" });
    expect(pulled.action).toBe("fast_forwarded");
    await expect(readFile(path.join(second, "schema", "shared.md"), "utf8"))
      .resolves.toBe("# 已同步\n");
    expect((await getVaultSyncStatus(second)).behind).toBe(0);
  });

  it("历史分叉时拒绝自动合并和推送", async () => {
    const first = await temporaryDirectory("lore-diverge-first-");
    const remote = await createRemote();
    await initializeVault(first);
    await addVaultRemote(first, "origin", remote);
    configureIdentity(first);
    await syncVault(first, { branch: "main" });
    const parent = await temporaryDirectory("lore-diverge-parent-");
    const second = path.join(parent, "vault");
    await cloneVault(remote, second, { branch: "main" });
    configureIdentity(second);

    await writeFile(path.join(second, "schema", "second.md"), "second\n", "utf8");
    git(second, "add", "schema/second.md");
    git(second, "commit", "-m", "second");
    await writeFile(path.join(first, "schema", "first.md"), "first\n", "utf8");
    await syncVault(first, { branch: "main" });

    await expect(syncVault(second, { branch: "main" })).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });
    expect(git(second, "log", "--merges", "--oneline")).toBe("");
  });

  it("推送前扫描持久知识中的高置信度敏感凭证", async () => {
    const root = await temporaryDirectory("lore-sensitive-vault-");
    const remote = await createRemote();
    await initializeVault(root);
    await addVaultRemote(root, "origin", remote);
    configureIdentity(root);
    await writeFile(
      path.join(root, "schema", "secret.md"),
      "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n",
      "utf8",
    );

    await expect(syncVault(root, { branch: "main" })).rejects.toMatchObject({
      code: ErrorCode.SensitiveContentDetected,
    });
    await expect(syncVault(root, { branch: "main", allow_sensitive: true }))
      .resolves.toMatchObject({ action: "pushed" });
  });

  it("拒绝在 HTTPS 远端地址中内嵌凭证", async () => {
    const root = await temporaryDirectory("lore-credential-vault-");
    await initializeVault(root);

    await expect(
      addVaultRemote(
        root,
        "origin",
        "https://user:secret@example.com/private/lore.git",
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(access(path.join(root, ".git"))).rejects.toThrow();
  });
});
