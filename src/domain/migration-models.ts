/** 一项即将执行的 Vault 迁移动作。 */
export interface MigrationAction {
  path: string;
  description: string;
}

/** `migrate plan` 返回的只读迁移计划。 */
export interface MigrationPlan {
  current_version: number;
  target_version: number;
  required: boolean;
  actions: MigrationAction[];
}

/** 一次成功迁移的持久历史。 */
export interface MigrationRecord {
  migration_id: string;
  from_version: number;
  to_version: number;
  applied_at: string;
  backup_path: string;
  changed_files: string[];
}

/** `schema/migrations.yaml` 的版本历史。 */
export interface MigrationHistory {
  version: number;
  migrations: MigrationRecord[];
}

/** 应用迁移后的结构化结果。 */
export interface MigrationResult {
  plan: MigrationPlan;
  record?: MigrationRecord;
}
