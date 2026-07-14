import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DirectoryName,
  ErrorCode,
  SourceKind,
  SourceLifecycleAction,
  SourceStatus,
  TransactionStatus,
  VaultFileName,
} from "../src/domain/enums.js";
import { LoreError } from "../src/errors.js";
import { readYamlFile } from "../src/infrastructure/serialization.js";
import type { TransactionJournal } from "../src/domain/mutation-models.js";
import {
  addSource,
  getSourceHistory,
  getSourceImpact,
  readSourceSnapshot,
  syncSource,
  updateSourceLifecycle,
} from "../src/services/source-service.js";
import { initializeVault } from "../src/services/vault-service.js";

describe("长期使用的 Source Adapter 与生命周期", () => {
  const temporaryRoots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    delete process.env.LORE_LARK_CLI_BIN;
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
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

  async function createVault(): Promise<string> {
    const root = await temporaryDirectory("lore-adapter-vault-");
    await initializeVault(root);
    return root;
  }

  it("采集内容寻址的直接文本并支持逻辑删除与恢复", async () => {
    const root = await createVault();
    const added = await addSource(root, "一段直接输入的知识。", {
      kind: SourceKind.Text,
      title: "临时想法",
    });

    expect(added.source).toMatchObject({
      kind: SourceKind.Text,
      title: "临时想法",
      status: SourceStatus.Active,
    });
    const sourceJournal = await readYamlFile<TransactionJournal>(
      path.join(
        root,
        DirectoryName.Runtime,
        DirectoryName.SourceTransactions,
        `source_${added.source.source_id}_${added.snapshot.snapshot_id}`,
        VaultFileName.TransactionJournal,
      ),
    );
    expect(sourceJournal.status).toBe(TransactionStatus.Committed);
    expect(sourceJournal.changed_files).toContain(
      `raw/sources/${added.source.source_id}/latest.yaml`,
    );
    expect((await readSourceSnapshot(root, added.source.source_id)).content.toString()).toBe(
      "一段直接输入的知识。",
    );
    expect(
      (
        await updateSourceLifecycle(
          root,
          added.source.source_id,
          SourceLifecycleAction.Tombstone,
        )
      ).status,
    ).toBe(SourceStatus.Tombstoned);
    await expect(syncSource(root, added.source.source_id)).rejects.toThrow(
      "不能同步非 active 状态",
    );
    expect(
      (
        await updateSourceLifecycle(
          root,
          added.source.source_id,
          SourceLifecycleAction.Restore,
        )
      ).status,
    ).toBe(SourceStatus.Active);
    const history = await getSourceHistory(root, added.source.source_id);
    expect(history.snapshots).toHaveLength(1);
  });

  it("递归采集目录文本，同时执行默认目录和 .loreignore 规则", async () => {
    const root = await createVault();
    const sourceRoot = await temporaryDirectory("lore-adapter-directory-");
    await mkdir(path.join(sourceRoot, "nested"), { recursive: true });
    await mkdir(path.join(sourceRoot, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(sourceRoot, "notes.md"), "# 可采集笔记\n", "utf8");
    await writeFile(path.join(sourceRoot, "nested", "code.ts"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(sourceRoot, ".env"), "SECRET=hidden\n", "utf8");
    await writeFile(
      path.join(sourceRoot, "node_modules", "pkg", "index.js"),
      "ignored\n",
      "utf8",
    );

    const added = await addSource(root, sourceRoot, { kind: SourceKind.Directory });
    const content = (await readSourceSnapshot(root, added.source.source_id)).content.toString();

    expect(content).toContain("## notes.md");
    expect(content).toContain("## nested/code.ts");
    expect(content).not.toContain("SECRET=hidden");
    expect(content).not.toContain("node_modules");
  });

  it("采集并同步 HTTP 页面，每次内容变化生成新 Snapshot", async () => {
    const root = await createVault();
    let body = "<html><body>第一版知识</body></html>";
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试 HTTP Server 未获得端口");
    }
    const url = `http://127.0.0.1:${address.port}/knowledge`;

    const first = await addSource(root, url, { kind: SourceKind.Web });
    body = "<html><body>第二版知识</body></html>";
    const second = await syncSource(root, first.source.source_id);

    expect(first.source.kind).toBe(SourceKind.Web);
    expect(first.snapshot.snapshot_id).not.toBe(second.snapshot.snapshot_id);
    expect(second.snapshot.media_type).toBe("text/html");
  });

  it("采集 Git tracked 文件与指定 revision 的 diff", async () => {
    const root = await createVault();
    const repository = await temporaryDirectory("lore-adapter-git-");
    const git = (...arguments_: string[]) =>
      execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.name", "Lore Test");
    git("config", "user.email", "lore@example.test");
    await writeFile(path.join(repository, "README.md"), "# 第一版\n", "utf8");
    await writeFile(
      path.join(repository, ".env"),
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890\n",
      "utf8",
    );
    git("add", "README.md", ".env");
    git("commit", "-q", "-m", "first");
    await writeFile(path.join(repository, "README.md"), "# 第二版\n", "utf8");
    git("add", "README.md");
    git("commit", "-q", "-m", "second");

    const repositorySource = await addSource(root, repository, {
      kind: SourceKind.GitRepository,
    });
    const repositoryContent = (
      await readSourceSnapshot(root, repositorySource.source.source_id)
    ).content.toString();
    expect(repositoryContent).toContain("HEAD:");
    expect(repositoryContent).toContain("# 第二版");
    expect(repositoryContent).not.toContain("OPENAI_API_KEY");

    const diffSource = await addSource(root, repository, {
      kind: SourceKind.GitDiff,
      revision: "HEAD~1",
    });
    const diffContent = (
      await readSourceSnapshot(root, diffSource.source.source_id)
    ).content.toString();
    expect(diffContent).toContain("-# 第一版");
    expect(diffContent).toContain("+# 第二版");
  });

  it("通过 lark-cli JSON 信封采集飞书文档且不接触认证信息", async () => {
    const root = await createVault();
    const toolRoot = await temporaryDirectory("lore-adapter-lark-cli-");
    const fakeCli = path.join(toolRoot, "lark-cli");
    await writeFile(
      fakeCli,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true,identity:"user",data:{document:{document_id:"doccnTest",revision_id:7,content:"# 飞书知识\\n\\n正文内容。\\n"}}}));\n`,
      "utf8",
    );
    await chmod(fakeCli, 0o755);
    process.env.LORE_LARK_CLI_BIN = fakeCli;

    const added = await addSource(
      root,
      "https://example.feishu.cn/docx/doccnTest",
      { kind: SourceKind.LarkDocument },
    );

    expect(added.source).toMatchObject({
      kind: SourceKind.LarkDocument,
      canonical_uri: "lark+doc://document/doccnTest",
      title: "飞书知识",
    });
    expect(added.snapshot.collector).toContain("revision.7");
    expect((await readSourceSnapshot(root, added.source.source_id)).content.toString()).toContain(
      "正文内容",
    );
  });

  it("从 Wiki Evidence 反查 Source 对知识页面的影响", async () => {
    const root = await createVault();
    const added = await addSource(root, "来源影响分析", { kind: SourceKind.Text });
    await writeFile(
      path.join(root, "wiki/pages/impact.md"),
      `---\ntype: concept\ntitle: 来源影响\nlore:\n  evidence:\n    - id: ev_impact\n      source_id: ${added.source.source_id}\n      snapshot_id: ${added.snapshot.snapshot_id}\n      locator: line:1-1\n      quote_sha256: ${added.snapshot.content_sha256}\n---\n\n# 来源影响\n`,
      "utf8",
    );

    await expect(getSourceImpact(root, added.source.source_id)).resolves.toMatchObject({
      source_id: added.source.source_id,
      wiki_pages: [
        {
          path: "wiki/pages/impact.md",
          evidence_ids: ["ev_impact"],
        },
      ],
      compilation_runs: [],
    });
  });

  it("默认拒绝 .loreignore 路径与高置信度敏感凭证", async () => {
    const root = await createVault();
    const inputRoot = await temporaryDirectory("lore-adapter-sensitive-");
    const ignoredPath = path.join(inputRoot, ".env");
    await writeFile(ignoredPath, "SAFE_EXAMPLE=value\n", "utf8");
    await expect(addSource(root, ignoredPath)).rejects.toMatchObject<Partial<LoreError>>({
      code: ErrorCode.IgnoredSource,
    });

    const privateKeyPath = path.join(inputRoot, "private-key.txt");
    await writeFile(
      privateKeyPath,
      "-----BEGIN PRIVATE KEY-----\n测试占位内容\n-----END PRIVATE KEY-----\n",
      "utf8",
    );
    await expect(addSource(root, privateKeyPath)).rejects.toMatchObject<
      Partial<LoreError>
    >({ code: ErrorCode.SensitiveContentDetected });
    await expect(
      addSource(root, privateKeyPath, { allow_sensitive: true }),
    ).resolves.toMatchObject({ snapshot_created: true });

    const changingPath = path.join(inputRoot, "changing.txt");
    await writeFile(changingPath, "初始安全内容\n", "utf8");
    const changing = await addSource(root, changingPath);
    await writeFile(
      changingPath,
      "-----BEGIN PRIVATE KEY-----\n同步阶段的测试占位内容\n",
      "utf8",
    );
    await expect(syncSource(root, changing.source.source_id)).rejects.toMatchObject<
      Partial<LoreError>
    >({ code: ErrorCode.SensitiveContentDetected });
    await expect(
      syncSource(root, changing.source.source_id, new Date(), true),
    ).resolves.toMatchObject({ snapshot_created: true });
  });
});
