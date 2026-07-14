---
name: lore-query
description: 使用 Lore 的 Wiki-first 检索和不可变 Raw Evidence 回答个人知识库问题。用户要求“查询 Lore”“从知识库回答”“我以前记录过什么”“找某个知识点”、核对知识来源，或需要基于 Lore 页面和 Snapshot 给出可追溯回答时使用。
---

# Lore 知识查询

通过 CLI 获取受控 Query Packet，再进行语义回答。查询是只读操作，不修改 Raw、Wiki、Schema 或 `.lore`。

## 工作流

1. 执行 `lore --json status` 验证默认 Vault。Lore 会依次使用显式 `--root`、`LORE_ROOT`、当前目录中的 Vault 和用户默认 Vault；通常不需要用户提供路径。
2. 如果返回尚未初始化或没有默认 Vault，执行 `lore init` 完成 Agent-first 初始化和 Skill 安装，再继续查询。不要要求用户理解 Raw、Wiki、Source 或 Snapshot 才能开始使用。
3. 将用户的真实问题原样传给：

   ```bash
   lore --json query prepare "<question>"
   ```

4. 先阅读 `wiki_candidates`，按 `score`、标题、正文和页面 Evidence 判断相关性。不要只根据 `excerpt` 回答。
5. 仅当 packet 的 `fallback.used` 为 `true` 时使用 `raw_evidence`。Raw 摘录是补充证据，不自动成为规范知识。
6. 综合回答并紧邻相关结论给出引用：
   - Wiki 知识使用 `[页面标题](wiki/pages/<slug>.md)`。
   - Raw 证据使用 packet 提供的 `uri`，不得自行改写 locator 或 Snapshot ID。
7. 如果 Wiki 与 Raw 冲突，明确说明冲突、各自时间和来源；不要暗中选择一方。
8. 如果 packet 没有足够证据，直接说明 Lore 中没有足够信息，并列出已检查的候选。不得用常识伪装成 Lore 中已有的知识。

## 查询调整

- 候选过多：用更明确的问题重新执行 `query prepare`，或用 `lore --json wiki search "<terms>" --limit <n>` 探索。
- 需要完整页面：只对 search/packet 返回的路径执行 `lore --json wiki show <path>`。
- 用户明确要求检查所有 Raw 时，使用 `--fallback always`；用户禁止读取 Raw 时使用 `--fallback never`。
- 查询发现值得沉淀的新信息时只提出建议；除非用户同时要求写入知识库，否则不要触发编译。

## 回答约束

- 区分“Wiki 中的规范知识”和“Raw 中尚未沉淀的材料”。
- 优先给结论，再给必要依据；不要倾倒整个 Query Packet。
- 保留不确定性、适用范围、时间和版本限定。
- 每个关键事实至少对应一个实际候选或 Raw Evidence。
- 不直接读取 Vault 中 packet 未返回的任意 Raw 文件。
