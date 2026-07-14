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
});
