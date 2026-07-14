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

旧页面被新知识取代时，对旧页面提交：

```yaml
action: supersede
target:
  path: wiki/pages/old-model.md
  expected_sha256: 候选页的64位摘要
concept:
  type: concept
  title: 旧模型
  lore:
    status: superseded
    superseded_by: wiki/pages/new-model.md
    evidence:
      - id: ev_replacement
        source_id: src_0123456789ab
        snapshot_id: snp_0123456789ab
        locator: line:9-12
        quote_sha256: 由 compile evidence 返回的64位摘要
  body: 该知识已由新模型取代。
reason: 新模型覆盖了旧模型的适用范围
```

没有替代知识但结论已经失效时使用 `action: retire`，并设置 `lore.status: stale`。`supersede`、`retire` 与 `update` 一样只能操作 prepare 返回的候选并携带 `expected_sha256`。

如缺少会实质改变结论的信息，增加：

```yaml
questions:
  - 这条规则是否只适用于生产环境？
```

带问题的 Change Set 可提交供检查，但状态会成为 `needs_input`，不能应用。
