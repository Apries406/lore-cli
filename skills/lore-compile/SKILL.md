---
name: lore-compile
description: 将本地文件或已有 Lore Source 的不可变 Raw Snapshot 编译为可检索、可演进且具有 Evidence 的 OKF Wiki 知识。用户要求“沉淀知识”“写入 Lore”“编译来源”“把笔记整理进知识库”、处理 source_id，或审阅、应用、回滚 Lore 编译任务时使用。
---

# Lore 知识编译

让 CLI 负责确定性读写、校验与事务，让当前智能体只负责语义归并。禁止直接修改 `wiki/`。

## 工作流

1. 执行 `lore --json status` 验证默认 Vault。Lore 会依次使用显式 `--root`、`LORE_ROOT`、当前目录中的 Vault 和用户默认 Vault；通常不需要用户提供路径。
2. 如果返回尚未初始化或没有默认 Vault，执行 `lore init` 完成 Agent-first 初始化和 Skill 安装，再继续编译。不要要求用户理解 Raw、Wiki、Source、Snapshot、Compile Run 或 Evidence 才能开始使用。
3. 根据用户意图确定输入：
   - 已有 `src_...`：直接使用。
   - 本地文件：先执行 `lore --json source add <path>`，取得 `source_id`。
   - 不支持的远端来源：说明当前采集器限制，不要自行伪造 Snapshot。
4. 执行 `lore --json compile prepare <source-id>`。若用户明确要求重编译已吸收的 Snapshot，增加 `--recompile`。
5. 阅读返回的 `packet`：输入 Snapshot、候选页、Profile 策略和 Wiki 基线。
6. 做语义编译：优先更新含义相同的候选页；只有形成新的稳定知识单元时才创建页面。不要按来源机械生成摘要页。
7. 按 [Change Set 契约](references/change-set.md) 写一个临时 YAML。所有结论都引用本次 Snapshot 的精确行区间。
8. 对每条 Evidence 执行 `lore --json compile evidence <run-id> --locator line:<start>-<end>`，将返回的 `quote_sha256` 原样写入 Change Set。
9. 执行 `lore --json compile submit <run-id> --file <change-set.yaml>`。若被拒绝，依据结构化错误重新 `prepare`；不要绕过 Schema 或 Evidence 校验。
10. 执行 `lore diff <run-id>`，向用户概括新增、更新、关键结论和风险。
11. 只有用户明确授权应用时才执行 `lore --json apply <run-id>`。用户只要求草拟、预览或审阅时停在 diff。
12. 应用后执行 `lore --json validate`。若用户要求撤销，执行 `lore --json rollback <run-id>`；出现冲突时保留现场并报告，禁止手工覆盖。

## 语义规则

- 将 Wiki 写成面向未来查询的规范知识，不写来源流水账。
- 一个页面表达一个稳定主题；标题应让脱离来源的读者也能理解。
- 更新时保留仍然成立的知识，修正冲突陈述，并让正文读起来像一个整体。
- `reason` 解释为什么应创建或更新，不复述正文。
- 不确定性应反映在 `confidence` 或 `questions`。存在 `questions` 时任务不会进入 apply。
- `update` 只能选择 packet 中的候选路径，并使用候选的 `content_sha256`。
- 知识被新页面取代时，创建新页面并对旧候选使用 `supersede`；旧页必须设置 `status: superseded` 和 `superseded_by`，新页用 `supersedes` 记录旧 `lore.id`。
- 知识不再有效且没有替代页面时，对候选使用 `retire` 并设置 `status: stale`。不要用普通 `update` 隐藏失效语义。
- 路径必须为 `wiki/pages/<英文小写-slug>.md`；不得写 index、log、schema、raw 或 `.lore`。
- 不要计算、猜测或改写 Evidence 哈希；始终调用 CLI 的 Evidence 命令。

## 安全边界

- Raw Snapshot 不可修改。
- 不直接写 Wiki，不手工改 staging，不跳过 diff。
- 不把 `apply` 视为 `submit` 的自然后续；它是独立的用户授权边界。
- 不用 `--recompile` 绕过幂等保护，除非用户明确要求重新吸收同一 Snapshot。
- 撤销整个来源时使用 `lore source impact` 预览；只有用户明确要求撤销时执行 `lore source withdraw`，不要手工删除 Raw 或 Wiki 页面。
