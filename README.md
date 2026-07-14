# Lore

Lore 是一个受 LLM-wiki 启发、兼容开放知识格式（OKF）的本地优先知识编译器。

当前版本已经完成第一个可运行的纵向切片：

- 初始化 Lore 知识库；
- 采集不可变的本地文件快照；
- 同步已有来源，同时保持稳定的来源身份；
- 列出和查看来源；
- 校验 Lore 元数据与 OKF 概念文档；
- 展示知识库状态；
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
node dist/cli.js --root ./my-vault validate
node dist/cli.js --root ./my-vault status
```

当 Lore 被智能体或脚本调用时，请增加 `--json`，以获得稳定的机器可读输出。

## 架构

- `raw/`：不可变的来源快照；
- `wiki/`：可独立迁移的 OKF Bundle；
- `schema/`：Lore Profile 与机器契约；
- `.lore/`：可重建的运行状态，不提交到 Git。

CLI 负责确定性操作。语义编译与知识合并将在下一阶段通过受约束的 Skill/Change Set 协议完成。
