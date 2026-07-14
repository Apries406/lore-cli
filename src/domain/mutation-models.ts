import type { MutationOperation, TransactionStatus } from "./enums.js";

/** `.lore/mutation.lock` 的持有者信息。 */
export interface MutationLockMetadata {
  version: number;
  pid: number;
  operation: MutationOperation;
  subject: string;
  created_at: string;
}

/** 任何持久写入前落盘的恢复日志。 */
export interface TransactionJournal {
  version: number;
  transaction_id: string;
  operation: MutationOperation;
  subject: string;
  status: TransactionStatus;
  backup_root: string;
  changed_files: string[];
  created_at: string;
  updated_at: string;
}

/** `recover status/apply` 的结构化结果。 */
export interface RecoveryReport {
  lock?: MutationLockMetadata;
  lock_owner_alive: boolean;
  pending_transactions: TransactionJournal[];
  corrupt_journals: string[];
  recovered_transactions: string[];
}
