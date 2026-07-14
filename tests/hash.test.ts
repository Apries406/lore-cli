import { describe, expect, it } from "vitest";
import { SourceKind } from "../src/domain/enums.js";
import {
  createSnapshotId,
  createSourceId,
  sha256,
} from "../src/infrastructure/hash.js";

describe("哈希标识符", () => {
  it("根据来源类型和规范 URI 生成稳定的 Source ID", () => {
    const uri = "file:///tmp/example.md";

    expect(createSourceId(SourceKind.File, uri)).toBe(
      createSourceId(SourceKind.File, uri),
    );
    expect(createSourceId(SourceKind.File, uri)).not.toBe(
      createSourceId(SourceKind.Web, uri),
    );
    expect(createSourceId(SourceKind.File, uri)).toMatch(/^src_[a-f0-9]{12}$/u);
  });

  it("生成内容寻址的 Snapshot ID", () => {
    const content = Buffer.from("相同内容");

    expect(createSnapshotId(content)).toBe(createSnapshotId(content));
    expect(createSnapshotId(content)).not.toBe(
      createSnapshotId(Buffer.from("不同内容")),
    );
    expect(createSnapshotId(content)).toMatch(/^snp_[a-f0-9]{12}$/u);
    expect(sha256(content)).toMatch(/^[a-f0-9]{64}$/u);
  });
});
