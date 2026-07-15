---
name: lore-capture
description: 在日常编码、调试、修复缺陷、形成架构决策或测试边界后，依据 Capture Policy 做任务结束知识检查，并把稳定知识送入 Knowledge Inbox。完成上述任务且准备最终回复前必须使用；用户用自然语言说明“什么必须沉淀”“什么必须排除”“不确定时问我”、要求查看或处理 Inbox 时也使用。
---

# Lore 日常知识采集

把“任务结束检查”变成 Agent 的固定收尾动作。CLI 负责安全采集、策略匹配、去重和持久化；当前智能体负责判断变更中是否形成了可跨任务复用的稳定知识。

## 任务结束检查

1. 在代码修改、调试、缺陷修复、设计讨论或测试边界工作完成后，最终回复用户之前执行：

   ```bash
   lore --json capture check <repository> --summary "本次实际完成的工作"
   ```

2. 若 `should_review` 为 `false`，或变更仅是机械改名、格式化、依赖锁更新、临时实验，不创建候选，正常结束任务。
3. 只根据检查包中的 `task_summary`、`eligible_paths` 和 `diff` 判断。不得自行读取 `excluded_paths`，不得把密钥、Token、个人身份信息或环境变量写入候选。
4. 将每个独立稳定知识单元写成一个 [Candidate](references/candidate.md)。适合沉淀的类型包括：
   - 架构决策及取舍；
   - 缺陷根因与可靠修复方式；
   - 领域约束和不明显行为；
   - 可复用操作手册与失败方案；
   - 关键测试边界。
5. 对每个候选执行 `lore --json capture propose --file <candidate.yaml>`。
6. 根据返回结果处理：
   - `stored: false`：遵守排除结果，不另行保存。
   - `status: needs_confirmation`：合并问题后向用户确认；不要猜答案。
   - `status: pending` 且 `auto_accept: false`：留在 Inbox，并在最终回复中简短说明有候选待审。
   - `auto_accept: true`：执行 `lore --json inbox accept <candidate-id>`，继续走下方编译链。
7. 接受候选只会生成 Raw Source 和 `prepared` Compile Run。使用 `$lore-compile` 生成、提交和展示 Wiki diff。只有 `schema/capture-policy.yaml` 中 `auto_apply: true`，或用户已明确授权应用这项知识时，才能执行 `lore apply`。应用成功后执行：

   ```bash
   lore --json inbox complete <candidate-id> --run <run-id>
   ```

任务检查是轻量收尾，不要把每次代码变更都写成知识。没有稳定知识时，零候选是正确结果。

## 自然语言控制策略

用户可以直接表达规则，例如“所有线上故障根因必须沉淀”“生成代码和实验目录必须排除”“置信度不足 90% 时问我”。将自然语言翻译成 [Capture Policy](references/policy.md) 的结构化修改：

1. 执行 `lore --json capture policy show` 读取当前策略及 `sha256`。
2. 在临时 YAML 中做最小修改，保留无关规则和用户已有设置。规则 ID 使用稳定的英文小写 kebab-case。
3. 执行 `lore --json capture policy validate --file <policy.yaml>`。
4. 向用户展示模式、阈值和具体规则变化。若用户的原话已经是明确执行指令，可直接进入下一步；若只是在讨论、存在范围歧义或会显著扩大自动采集范围，先确认。
5. 执行：

   ```bash
   lore --json capture policy apply --file <policy.yaml> --expected-sha256 <原sha256>
   ```

排除规则永远优先于包含规则。低于 `confirmation_below` 或 Candidate 含显式问题时必须询问。敏感凭证是 CLI 的硬排除，Policy 不能放行。

## Inbox 审阅

- `lore --json inbox list`：列出全部候选；可用 `--status pending` 等状态过滤。
- `lore --json inbox show <candidate-id>`：查看候选上下文和命中规则。
- `lore --json inbox accept <candidate-id>`：接受并进入 Raw → Compile 流程。
- `lore --json inbox reject <candidate-id> --reason "原因"`：拒绝并保留本机审阅记录。

Inbox 位于 `.lore/inbox/`，只属于当前设备，不进入 Git。接受后的 Raw、Wiki 和 `schema/capture-policy.yaml` 才属于可同步的 Vault 事实。

## 安全边界

- 不直接修改 Raw、Wiki 或 `.lore/inbox` 文件，始终调用 CLI。
- 不把绝对仓库路径写入最终 Raw 知识；CLI 会将来源压缩为仓库名和相对路径。
- `assisted` 是默认模式：候选进入 Inbox，但不会静默接受。
- `automatic` 只允许高置信度 include 候选自动接受；不等于自动应用 Wiki 变更。
- 用户说“这次不要记”时，本次不创建候选；只有用户要求长期规则时才修改 Policy。
