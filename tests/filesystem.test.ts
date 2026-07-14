import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "../src/domain/enums.js";
import { LoreError } from "../src/errors.js";
import {
  assertPathWithinRoot,
  safeJoin,
} from "../src/infrastructure/filesystem.js";

describe("知识库路径安全", () => {
  const root = path.resolve("/tmp/lore-vault");

  it("接受知识库内部路径", () => {
    expect(safeJoin(root, "wiki", "pages", "example.md")).toBe(
      path.join(root, "wiki", "pages", "example.md"),
    );
  });

  it("拒绝逃逸知识库的路径", () => {
    expect(() => assertPathWithinRoot(root, path.resolve(root, "../secret"))).toThrow(
      expect.objectContaining<Partial<LoreError>>({
        code: ErrorCode.PathEscapesVault,
      }),
    );
  });

  it("拒绝知识库内部符号链接把后续访问带到其他位置", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "lore-symlink-vault-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "lore-symlink-external-"));
    try {
      await mkdir(path.join(vault, "wiki", "pages"), { recursive: true });
      await symlink(external, path.join(vault, "wiki", "pages", "linked"));

      expect(() => safeJoin(vault, "wiki", "pages", "linked", "secret.md")).toThrow(
        expect.objectContaining<Partial<LoreError>>({
          code: ErrorCode.PathEscapesVault,
        }),
      );
    } finally {
      await rm(vault, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });
});
