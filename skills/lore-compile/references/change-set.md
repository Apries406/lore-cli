# Change Set 契约

使用 `compile prepare` 返回的字段填充机器标识，不要自行生成 `run_id`、Source ID、Snapshot ID 或基线哈希。

```yaml
version: 1
run_id: run_0123456789abcdef
base_revision:
  wiki_sha256: 64位摘要
operation: compile
inputs:
  - source_id: src_0123456789ab
    snapshot_id: snp_0123456789ab
summary: 沉淀 Raw 与 Wiki 的职责边界
changes:
  - action: update
    target:
      path: wiki/pages/lore-knowledge-model.md
      expected_sha256: 候选页的64位摘要
    reason: 新证据补充了现有主题
    concept:
      type: concept
      title: Lore 双层知识模型
      description: Raw 保存不可变证据，Wiki 保存可演进知识。
      tags:
        - lore
        - knowledge-model
      lore:
        confidence: high
        evidence:
          - id: ev_raw_wiki_boundary
            source_id: src_0123456789ab
            snapshot_id: snp_0123456789ab
            locator: line:3-8
            quote_sha256: 由 compile evidence 返回的64位摘要
      body: |-
        # Lore 双层知识模型

        Raw 层保存不可变来源，Wiki 层保存经过语义归并的知识视图。
```

创建页面时使用 `action: create`，并省略 `expected_sha256`。允许的页面类型、单次变更数、新建页数和是否强制 Evidence 均以 packet 的 `policies` 为准。

如缺少会实质改变结论的信息，增加：

```yaml
questions:
  - 这条规则是否只适用于生产环境？
```

带问题的 Change Set 可提交供检查，但状态会成为 `needs_input`，不能应用。
