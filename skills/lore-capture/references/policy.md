# Capture Policy 契约

策略保存在 `schema/capture-policy.yaml`，随 Vault Git 同步：

```yaml
version: 1
mode: assisted
default_action: ask
confirmation_below: 0.85
automatic_accept_above: 0.95
auto_apply: false
rules:
  - id: include-production-root-causes
    action: include
    description: 线上故障根因必须进入候选箱
    categories:
      - bug_root_cause
  - id: exclude-generated
    action: exclude
    description: 生成代码不参与采集
    path_patterns:
      - generated/**
```

## 字段

- `mode`：`off`、`assisted` 或 `automatic`。
- `default_action`：没有规则命中时使用 `include`、`exclude` 或 `ask`。
- `confirmation_below`：低于该置信度时强制询问。
- `automatic_accept_above`：automatic 模式中，达到该阈值的 include 候选可以自动接受。
- `auto_apply`：是否允许自动应用通过编译校验的 Wiki diff；默认且推荐为 `false`。
- `rules`：可按 `categories`、`path_patterns`、`keywords`、`repository_patterns` 匹配；同一规则配置多个维度时必须全部匹配，每个维度内部任一值匹配即可。

多条规则命中时 `exclude` 优先，其次是不确定性门槛与 `ask`，最后才是 `include`。敏感凭证由 CLI 在策略前硬排除。
