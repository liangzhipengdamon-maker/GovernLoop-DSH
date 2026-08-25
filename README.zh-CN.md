# DSH-GPTLoop

[English](README.md) | **简体中文**

**DeepSeek Harness 的外循环。**

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）连接到你已经在使用的 GPT Web 会话，用于项目上下文、独立审查和人类授权。

**快速内循环。持续外循环。一个项目。**

https://github.com/user-attachments/assets/60ece667-3e4c-46cd-8b83-1dea15ec7e08

*点击 ▶ 播放 45 秒真实工作流：DSH checkpoint → GPT Web review → 回读 → 必要时人类批准 → DSH 恢复执行。*

> **不是 DSH 用户？** WorkBuddy、OpenCode、Claude Code、Codex 或其他 Agent，请直接使用 [GovernLoop Core](https://github.com/liangzhipengdamon-maker/GovernLoop)。

## 为什么是 GovernLoop-DSH

DeepSeek Harness 的优势在于把执行留在本地运行时：工具、测试、沙箱、会话和审批，都由本地 execution loop 负责。GPT Web 的作用在另一层——它的长期记忆，承载着人类已经维护的项目思考：架构、权衡、评审记录和决策。governloop-dsh 只补两者之间缺失的桥：把 DeepSeek Harness 的关键 checkpoint 和 evidence 送到 GPT Web，把独立评审结果带回 DeepSeek Harness，并在需要时保留明确的人类授权——执行留在本地，项目思考保持连通。

- **去掉人工 clipboard relay。** Review request 和必要 evidence 可以自动进入 GPT Web，结果再回到同一条 DSH 工作流。
- **保留持续外循环。** GPT Web 负责持续的项目推理和独立审查，DSH 继续专注本地执行。
- **Native first。** DSH 继续对执行、sandbox、permission、session、subagent 和原生 approval 保持权威；DSH-GPTLoop 只补缺失的桥。
- **真实闭环已验证。** Product Closure 已通过真实 DSH、GovernLoop Core、Chrome/CDP 和绑定 GPT Web 会话完成端到端验证。

GPT Web 与 Linear、GitHub、Docs / Drive 等工具链的详细 outer-loop 定位，放在 [`docs/product/DSH-GPTLoop-outer-loop.md`](docs/product/DSH-GPTLoop-outer-loop.md)，首页不展开。

## 工作方式

```text
DeepSeek Harness
      ↓
关键 checkpoint + evidence
      ↓
DSH-GPTLoop / GovernLoop Core
      ↓
已有 GPT Web 会话
      ↓
独立审查 + 回读
      ↓
必要时由人类授权
      ↓
DSH 恢复执行
```

只有关键 checkpoint 离开本地执行循环，普通工作继续留在本地。

## 快速安装

前置条件：

- 固定 `@deepseek-ai/dsh@0.1.1-rc.2`；
- 先通过当前面向用户的入口安装 [GovernLoop Core](https://github.com/liangzhipengdamon-maker/GovernLoop)：`sh install.sh`；
- Chrome 通过 CDP 启动（`--remote-debugging-port=9233`）；
- 已打开 GPT Web 会话，并绑定到 GovernLoop session。

安装 DSH 插件：

```text
dsh plugin --profile web add governloop-dsh@0.1.1
```

或独立从 npm 安装：

```text
npm install governloop-dsh@0.1.1
```

`0.1.1` 移除了整包 DSH peer dependency，因此普通 npm 安装不再拉取完整的 DSH 依赖树。

也可以通过 `governloop-dsh/cordis.patch.yml` 本地挂载，并将 `GOVERLOOP_SESSION_MANAGER_PATH` 指向 `governloop_session.py`。

完整技术指南：[`governloop-dsh/README.md`](governloop-dsh/README.md)。

## 安全边界

- GPT 审查是 advisory evidence，不是执行授权。
- 当前 DSH 集成要求人类授权的地方，必须得到明确的人类授权。
- 失败保持 blocked；不自动重发。
- DSH 原生 sandbox、permission、session 和 approval 行为继续保持权威。
- 已连接的项目工具继续保留各自的 authority。

## 已验证兼容性

| 技术包 | @deepseek-ai/dsh | 状态 |
|---|---|---|
| `governloop-dsh` 0.1.1 | 0.1.1-rc.2 | Product Closure VERIFIED |

GovernLoop Core `v0.1.4` 仍保留本适配器使用的 session-manager CLI 边界。源码级兼容性检查未发现 Project/custom-GPT 会话 URL、Agent reload 处理或完整 CLI stdout 回读要求 DSH runtime 必须修改。但在把这一精确 Core 版本组合标记为 VERIFIED 之前，仍需完成一次全新的 DSH + Core `v0.1.4` E2E smoke。

DSH 仍处于 developer preview，升级前应重新验证。

## 更多说明

- 产品模型：[`docs/product/DSH-GPTLoop-outer-loop.md`](docs/product/DSH-GPTLoop-outer-loop.md)
- 验证证据：[`docs/verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md`](docs/verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md)
- 技术包：[`governloop-dsh/README.md`](governloop-dsh/README.md)
- 仓库规则：[`AGENTS.md`](AGENTS.md)

## License

[Apache-2.0](LICENSE)。
