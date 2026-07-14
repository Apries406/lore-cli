# Lore

Lore 是一个受 LLM-wiki 启发、兼容开放知识格式（OKF）的本地优先知识编译器。

当前版本已经完成 Raw → Wiki 的可运行知识编译闭环：

- 初始化 Lore 知识库；
- 采集不可变的本地文件快照；
- 同步已有来源，同时保持稳定的来源身份；
- 列出和查看来源；
- 校验 Lore 元数据与 OKF 概念文档；
- 展示知识库状态；
- 生成只读 Compile Packet 与候选 Wiki 页面；
- 校验 Skill 提交的结构化 Change Set 和逐行 Evidence；
- 生成审阅 Diff，并在独占锁中事务应用；
- 自动维护 Wiki 索引、日志和 Raw 编译账本；
- 对无后续改动的编译执行安全回滚；
- 使用字段加权 BM25 检索完整 Wiki 页面；
- 生成 Wiki-first、证据不足时回退 Raw 的 Query Packet；
- 审计 Evidence、重复/孤立页面、编译覆盖率、陈旧来源和遗留任务；
- 对旧 Vault 执行带备份、Evidence 升级和失败恢复的版本迁移；
- 提供面向人的输出和稳定的 JSON 输出。

## 开发

```bash
npm install
npm run check
npm run dev -- --help
```

## 快速开始

```bash
npm run build
node dist/cli.js init ./my-vault
node dist/cli.js --root ./my-vault source add ./notes.md
node dist/cli.js --root ./my-vault source sync <source-id>
node dist/cli.js --root ./my-vault source list
node dist/cli.js --root ./my-vault compile prepare <source-id>
node dist/cli.js --root ./my-vault compile evidence <run-id> --locator line:1-5
node dist/cli.js --root ./my-vault compile submit <run-id> --file ./change-set.yaml
node dist/cli.js --root ./my-vault diff <run-id>
node dist/cli.js --root ./my-vault apply <run-id>
node dist/cli.js --root ./my-vault rollback <run-id>
node dist/cli.js --root ./my-vault wiki search "双层知识模型"
node dist/cli.js --root ./my-vault wiki show wiki/pages/two-layer-model.md
node dist/cli.js --root ./my-vault query prepare "Lore 如何保存证据？"
node dist/cli.js --root ./my-vault audit
node dist/cli.js --root ./my-vault migrate plan
node dist/cli.js --root ./my-vault migrate apply
node dist/cli.js --root ./my-vault validate
node dist/cli.js --root ./my-vault status
```

当 Lore 被智能体或脚本调用时，请增加 `--json`，以获得稳定的机器可读输出。

## 编译模型

`compile prepare` 只读取不可变 Snapshot 和 Wiki，产出 `.lore/runs/<run-id>/packet.yaml`。语义层根据输入和候选页生成结构化 Change Set；`compile submit` 对路径、候选版本、页面限额和 Evidence 摘录哈希做确定性校验，并写入 staging 和 diff。

`apply` 是独立的审阅边界。它会获取编译锁、重新检查整个 Wiki 基线、备份受影响文件、原子写入页面、重建索引并执行全库校验。生效记录保存在 `raw/sources/<source-id>/compilations/<snapshot-id>/<run-id>.yaml`。`rollback` 只在整个 Wiki 仍等于该任务应用后的版本时执行，避免覆盖后续编辑。

仓库内的 [`lore-compile`](./skills/lore-compile/SKILL.md) Skill 负责语义归并工作流。它要求智能体始终通过 CLI 计算 Evidence、先展示 diff，并且只在用户明确授权后执行 apply。

## 查询模型

`wiki search` 使用标题、标签、描述和正文的字段加权 BM25 检索。`query prepare` 始终先返回完整 Wiki 候选；没有候选或首个候选低于 Profile 阈值时，再从所有 Active Source 的 latest Snapshot 返回逐行 Raw Evidence。查询过程只读，不会隐式修改知识库。

仓库内的 [`lore-query`](./skills/lore-query/SKILL.md) Skill 负责根据 Query Packet 回答问题、区分规范 Wiki 与未沉淀 Raw，并为关键结论保留页面或 Snapshot 引用。

## 长期健康审计

`audit` 在基础 Schema 和内容完整性校验之上，重新验证每条 Evidence 的 Source、Snapshot、行区间与摘录哈希；同时检查重复 `lore.id`/`merge_key`、重复或孤立页面、latest Snapshot 编译覆盖率、陈旧来源及长期未结束的编译任务。错误会令命令返回校验失败退出码，警告保留健康状态但需要后续维护。

## Vault 迁移

CLI 会在所有普通命令前检查 `lore.yaml` 的版本。旧 Vault 必须先通过 `migrate plan` 审阅动作，再执行 `migrate apply`。迁移会在 `.lore/migrations/` 备份所有受影响文件，保留用户 Profile 值并补齐新默认项，更新机器 Schema，为旧页面补算 Evidence 摘录哈希，并将成功记录追加到 `schema/migrations.yaml`；任何校验失败都会恢复迁移前文件。

## 架构

- `raw/`：不可变的来源快照；
- `wiki/`：可独立迁移的 OKF Bundle；
- `schema/`：Lore Profile 与机器契约；
- `.lore/`：可重建的运行状态，不提交到 Git。

CLI 负责确定性操作，Skill 负责语义判断；两者只通过 Compile Packet 和 Change Set 协议交互。
