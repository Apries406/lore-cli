# Lore

Lore 是一个专为 Agent 设计、受 LLM-wiki 启发并兼容开放知识格式（OKF）的本地优先知识编译器。人只需要表达“记住这个”“从我的知识库回答”“撤销这份来源”等意图；Raw、Wiki、Source、Snapshot、Compile Run 和 Evidence 都是 Agent 与 CLI 之间的内部协议，不是用户的前置知识。

`lore init` 是唯一的产品入口：它创建默认 Vault、检测本机 Agent，并可交互选择或自动安装 Lore Skills。初始化后，Codex、Claude Code、TRAE 和其他支持 Agent Skills 的工具可以在任意目录调用 Lore，无需用户重复传递 Vault 路径。

当前版本已经完成 Raw → Wiki 的可运行知识编译闭环：

- 初始化 Lore 知识库；
- 采集不可变的本地文件快照；
- 采集直接文本、目录、Web、飞书文档、Git 仓库和 Git diff；
- 同步已有来源，同时保持稳定的来源身份；
- 逻辑删除/恢复 Source，并查询 Snapshot、编译和 Wiki 影响历史；
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
- 受控 supersede/retire 知识，并默认从查询中排除失效页面；
- 按连续编译账本逆序撤销 Source 的 Wiki 影响；
- 对采集、编译和迁移使用统一写锁、事务备份与显式崩溃恢复；
- 采集前执行 `.loreignore`、符号链接和高置信度敏感凭证门禁；
- 交互选择 Codex、Claude Code、TRAE 或任意 Skills 目录；
- 自动检测已安装但尚未具备 Lore Skills 的 Agent；
- 保存用户默认 Vault，让 Agent 在任意工作目录使用 Lore；
- 一条命令安装配套的编译与查询 Skills；
- 提供简洁的人类反馈和稳定的 Agent JSON 协议。

## 开发

```bash
npm install
npm run check
npm run dev -- --help
```

生成可全局安装的本地发布包：

```bash
npm pack
npm install --global ./apries-lore-0.3.0.tgz
lore --version
```

## 快速开始

```bash
# 交互选择要接入的 Agent；Vault 默认创建在用户数据目录
lore init

# 或完全自动：检测本机 Agent，并为缺少 Lore Skills 的目标安装
lore init --auto-install

# 非交互环境可以明确指定一个或多个 Agent
lore init --agent codex --agent claude-code --agent trae

# 其他遵循 Agent Skills 标准的工具直接给出其 Skills 目录
lore init --skill-target /path/to/another-agent/skills

# 检查各 Agent 的检测和 Lore Skills 状态
lore agent status

# 切换默认 Vault；仅在多知识库场景需要
lore vault use /path/to/another-vault
```

初始化是幂等的：再次运行会补全 Vault、安装缺失 Skill；只有显式传入 `--force-skills` 才升级内容不同的已有 Skill。默认安装目录为 Codex `~/.agents/skills`、Claude Code `~/.claude/skills`、TRAE `~/.trae/skills`、TRAE 国内版 `~/.trae-cn/skills`。

Agent 调用 Lore 时使用 `--json` 获取稳定的机器协议。Lore 按显式 `--root`、`LORE_ROOT`、当前目录中的 Vault、用户默认 Vault 的顺序解析知识库，因此正常工作流不需要 `--root`。

下面是 Agent Skills 内部使用的典型命令；用户通常不需要直接执行：

```bash
lore --json source add ./notes.md
lore --json source add-text "一段需要记住的知识"
lore --json compile prepare <source-id>
lore --json query prepare "我以前记录过什么？"
lore --json audit
lore --json validate
```

目录和 Git 采集只包含受支持的文本文件，跳过二进制、超大文件与符号链接；目录采集还会跳过 `.git`、`.lore`、`node_modules` 等目录。目录与 Git 仓库采集都会执行 Vault 和来源根目录中的 `.loreignore`，Git 仓库只读取 tracked 文件。显式采集 `.env` 会被拒绝；任何新增或同步内容命中私钥、AWS Access Key、GitHub Token 或 OpenAI Key 的高置信度格式时也会被拒绝。只有确认目标 Vault 的访问边界安全后，才应为 `source add` 或 `source sync` 使用 `--allow-sensitive`。

飞书文档采集复用本机 `lark-cli` 的 user 登录态；Lore 不读取或保存认证信息。

## 编译模型

`compile prepare` 只读取不可变 Snapshot 和 Wiki，产出 `.lore/runs/<run-id>/packet.yaml`。语义层根据输入和候选页生成结构化 Change Set；`compile submit` 对路径、候选版本、页面限额和 Evidence 摘录哈希做确定性校验，并写入 staging 和 diff。

`apply` 是独立的审阅边界。它会获取 Vault 统一写锁、重新检查整个 Wiki 基线、备份受影响文件、原子写入页面、重建索引并执行全库校验。生效记录保存在 `raw/sources/<source-id>/compilations/<snapshot-id>/<run-id>.yaml`。`rollback` 只在整个 Wiki 仍等于该任务应用后的版本时执行，避免覆盖后续编辑。

仓库内的 [`lore-compile`](./skills/lore-compile/SKILL.md) Skill 负责语义归并工作流。它要求智能体始终通过 CLI 计算 Evidence、先展示 diff，并且只在用户明确授权后执行 apply。

## 查询模型

`wiki search` 使用标题、标签、描述和正文的字段加权 BM25 检索。`query prepare` 始终先返回完整 Wiki 候选；没有候选或首个候选低于 Profile 阈值时，再从所有 Active Source 的 latest Snapshot 返回逐行 Raw Evidence。查询过程只读，不会隐式修改知识库。

`stale` 与 `superseded` 页面默认不进入查询候选；审阅历史时可使用 `wiki search --include-inactive`。知识被取代时，Change Set 必须同时表达替代关系，而不是静默覆盖旧结论。

仓库内的 [`lore-query`](./skills/lore-query/SKILL.md) Skill 负责根据 Query Packet 回答问题、区分规范 Wiki 与未沉淀 Raw，并为关键结论保留页面或 Snapshot 引用。

## 长期健康审计

`audit` 在基础 Schema 和内容完整性校验之上，重新验证每条 Evidence 的 Source、Snapshot、行区间与摘录哈希；同时检查重复 `lore.id`/`merge_key`、重复或孤立页面、latest Snapshot 编译覆盖率、陈旧来源及长期未结束的编译任务。错误会令命令返回校验失败退出码，警告保留健康状态但需要后续维护。

`source withdraw` 会先验证该 Source 的 Applied 编译记录构成当前 Wiki 顶部的一条连续版本链，再按时间逆序调用事务回滚，最后 tombstone Source。只要期间夹杂其他来源或人工修改，命令就会在写入前拒绝，避免覆盖后续知识。

## Vault 迁移

CLI 会在所有普通命令前检查 `lore.yaml` 的版本。旧 Vault 必须先通过 `migrate plan` 审阅动作，再执行 `migrate apply`。迁移会在 `.lore/migrations/` 备份所有受影响文件，保留用户 Profile 值并补齐新默认项，更新机器 Schema，为旧页面补算 Evidence 摘录哈希，并将成功记录追加到 `schema/migrations.yaml`；任何校验失败都会恢复迁移前文件。

## 崩溃恢复

采集、来源状态变更、编译生效/回滚和迁移共享 `.lore/mutation.lock`。每次多文件写入会先保存备份和 `transaction.yaml`，再开始修改；正常异常会自动恢复，进程被强制终止时则保留 Prepared 日志和死亡进程锁。

遇到 `recovery_required` 时，先运行 `recover status` 审阅锁持有者、待恢复事务和损坏日志，再运行 `recover apply`。Lore 只自动恢复结构完整的日志；损坏日志必须人工检查，后续写操作会持续被阻止，避免在未知状态上叠加修改。

## Skills

`lore init` 会把包内的 `lore-compile` 与 `lore-query` 安装到用户选定或自动检测到的 Agent。`lore agent install --auto` 可在初始化后补装；`lore agent install codex claude-code trae` 可明确选择目标；`--target` 支持任意遵循 Agent Skills 标准的工具。

低层的 `lore skill install` 默认写入 Codex 当前使用的 `~/.agents/skills`。已有同名目录时不会静默覆盖；确认升级后使用 `--force`。

## 架构

- `raw/`：不可变的来源快照；
- `wiki/`：可独立迁移的 OKF Bundle；
- `schema/`：Lore Profile 与机器契约；
- `.lore/`：可重建的运行状态，不提交到 Git。

CLI 负责确定性操作，Skill 负责语义判断；两者只通过 Compile Packet 和 Change Set 协议交互。
