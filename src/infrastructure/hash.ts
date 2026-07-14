import { createHash } from "node:crypto";
import {
  HASH_ALGORITHM,
  IDENTIFIER_DIGEST_LENGTH,
  SNAPSHOT_ID_PREFIX,
  SOURCE_ID_PREFIX,
} from "../domain/constants.js";
import { SourceKind } from "../domain/enums.js";

/** 计算完整 SHA-256 十六进制摘要。 */
export function sha256(value: string | Buffer): string {
  return createHash(HASH_ALGORITHM).update(value).digest("hex");
}

/**
 * 根据来源类型和规范 URI 生成稳定 Source ID。
 * 同一份内容可以变化，但同一来源的身份不能随 Snapshot 变化。
 */
export function createSourceId(kind: SourceKind, canonicalUri: string): string {
  const digest = sha256(`${kind}\0${canonicalUri}`).slice(
    0,
    IDENTIFIER_DIGEST_LENGTH,
  );
  return `${SOURCE_ID_PREFIX}${digest}`;
}

/** 根据内容生成 Snapshot ID，使重复采集天然幂等。 */
export function createSnapshotId(content: Buffer): string {
  const digest = sha256(content).slice(0, IDENTIFIER_DIGEST_LENGTH);
  return `${SNAPSHOT_ID_PREFIX}${digest}`;
}
