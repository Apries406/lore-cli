# Capture Candidate 契约

一个文件只表达一个可独立接受或拒绝的稳定知识单元：

```yaml
version: 1
title: 统一写锁保证 Vault 写事务串行化
summary: Source、Compile 和 Migration 必须共享同一把 Vault 写锁。
details: 调试确认多个独立锁会让并发写入互相覆盖；统一锁在持久化前串行化所有写操作。
category: architecture_decision
confidence: 0.96
tags:
  - lore
  - transaction
questions: []
origin:
  kind: git_diff
  repository: /workspace/lore
  revision: abc123
  changed_paths:
    - src/services/mutation-service.ts
```

`confidence` 为 0..1。存在会改变结论、适用范围或安全边界的问题时，写入 `questions`，不要用高置信度掩盖不确定性。

候选正文不得复制大段 diff，不写本次任务流水账。`details` 应说明未来 Agent 可复用的结论、原因和适用边界。
