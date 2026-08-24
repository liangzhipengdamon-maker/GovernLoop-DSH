# DSH-GPTLoop

[English](README.md) | **简体中文** | [日本語](README.ja.md)

**DeepSeek Harness 的外循环。**

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）连接到一个持续存在的 GPT Web 外循环，用于项目级推理、独立审查和人类授权。

**快速内循环。持续外循环。一个项目。**

DSH 继续做它最擅长的事情：本地执行、工具调用、测试、沙箱、会话、子 Agent、权限、审批与恢复。DSH-GPTLoop 只补上缺失的一环——把 DSH 接到承载更广泛项目讨论的 GPT Web 会话。

> **不再造第二套 Agent 框架。不重复沙箱。不重复会话系统。只补缺失的外循环。**

## 内循环 + 外循环

```text
                 GPT Web
              持续外循环
       项目上下文 / 推理 / 审查
                 ↑
                 │
            DSH-GPTLoop
       GovernLoop 桥接 + DSH 适配器
                 │
                 ↓
        DeepSeek Harness
            快速执行内循环
      plan / act / tools / test / resume
```

产品边界很简单：

- **DSH = 快速本地执行 / 内循环**
- **GPT Web = 持续项目推理 + 独立审查 / 外循环**
- **DSH-GPTLoop = 连接二者的桥**

设计原则是 **native first**。DSH 已经原生提供的能力，DSH-GPTLoop 直接使用，不重复实现。

## 为什么 GPT Web 很重要

关键并不只是“再调用一个模型”，而是**人本来就在其中思考项目的 GPT Web 会话**：架构、研究、权衡、审查历史、产品决策、阻塞处理，以及跨多轮积累下来的上下文。

本地 Coding Agent 很擅长操作机器；GPT Web 往往承载着更高层的项目讨论。DSH-GPTLoop 把这两个工作面连接起来，不再让人充当两者之间的复制粘贴中间层。

这对以下人群尤其有价值：

- **独立开发者与 OPC（一人公司）：** 一个人可能同时是产品负责人、架构师、研究员、审查者和执行者。持续存在的外循环可以减少角色切换，让本地执行 Agent 直接利用 GPT Web 中已经维护的项目上下文。
- **Vibe Coding 工作流：** 实现速度可以非常快，因此关键节点的独立审查反而更加重要。关键决策、破坏性操作、阻塞和异常状态可以自动送到 GPT Web，而不需要把每一个本地步骤都变成新的模型对话。
- **专业工程团队：** 执行与审查不必压缩进同一个 Agent 上下文。本地 runtime 继续对代码、测试、沙箱和权限负责，GPT Web 则提供独立的推理/审查面。涉及专有代码或证据时，仍必须遵守组织的安全和数据处理政策。

目标不是让 GPT Web 变成执行引擎，而是让**执行留在本地，同时让项目级推理与独立审查保持连接**。

## GPT Web 作为项目外循环

GPT Web 不只是一个 review surface。**当相关工具已连接并获得授权时**，它可以横跨开发全生命周期，把多个系统的项目上下文带进同一个持续存在的推理工作区。

```text
                      GPT Web
                 持续项目外循环

          研究 / 产品 / 架构 / 审查
                         │
          ┌──────────────┼──────────────┐
          ↓              ↓              ↓
       Linear          GitHub       Docs / Drive
    issues / planning   PR / CI      specs / evidence
          │              │              │
          └──────────────┼──────────────┘
                         ↓
                    DSH-GPTLoop
                         ↓
                  DeepSeek Harness
                     本地执行
                         ↓
                 code / tools / tests
```

真实的软件项目远不只是“生成代码”：

**Idea / Research → Product Decision → Issue → Implementation → Test → Review → PR → CI → Merge → Release → Documentation → Follow-up**

DSH 最擅长的是其中高速的本地执行部分。GPT Web 则可以在相关工具可用时，把外围的项目上下文串起来，例如：研究与产品推理、Linear issue 与 blocker、GitHub 仓库 / PR / CI 证据、文档、release-readiness 审查，以及后续行动。

但这**不会**把这些系统的权威转移给 GPT Web：

- GitHub 仍然是仓库内容、commit、PR 和仓库生命周期状态的权威来源。
- 使用 Linear 时，Linear 仍然是 issue / project tracking 的权威来源。
- CI 仍然只是 verification evidence；CI 变绿本身并不等于 Merge / Release 授权。
- DSH 仍然对其原生 runtime、执行、sandbox、permission、session 和 approval 行为保持权威。
- 需要人类授权的关键生命周期动作，仍由人保留最终授权权力。

GPT Web 不替代这些系统。**它连接它们的上下文。**

> **本地 Agent 知道“现在正在做什么”；外循环知道“这个项目为什么要这样做”。**

而随着 Coding Agent 越来越快，这种分工反而更有价值：

> **内循环越快，外循环越重要。**

详细说明：[`docs/product/DSH-GPTLoop-outer-loop.md`](docs/product/DSH-GPTLoop-outer-loop.md)。

## 它补了 DSH 的什么缺口？

DeepSeek Harness 已经提供了完整的执行框架。它原生缺少的是：把运行中的 DSH Agent 可靠地连接到一个已经打开、并且保有项目上下文的 GPT Web 会话。

DSH-GPTLoop 只补这一层：

```text
DSH 关键检查点
        ↓
轻量原生 governloop-dsh 适配器
        ↓
GovernLoop Core
session / evidence / Neutral Relay
        ↓
已有 GPT Web 会话
        ↓
独立审查 + 回读
        ↓
需要时由人类授权
        ↓
DSH 恢复执行
```

## 为什么值得使用

### 1. 补充 DSH，而不是和 DSH 竞争

DSH-GPTLoop 不会变成另一层编排系统。DSH 仍然对执行、沙箱、权限、会话、子 Agent 和原生审批保持权威。适配器只负责把 DSH 生命周期事件转换为外部审查桥接，并把证据和审查结果送回 DSH。

### 2. 已在真实闭环中完成验证

**Product Closure: VERIFIED（2026-08-24）。**

完整链路已在真实环境中端到端验证：真实 DSH + 真实 GovernLoop Neutral Relay + Chrome/CDP + 绑定的 GPT Web 会话。

已验证：

- 真实消息发送与证据附件；
- GPT 完整回复回读；
- 明确人类批准后的精确 retry 授权；
- relay failure、PO decline、missing attachment 均 fail closed；
- GPT Web 标签页在后台时仍可工作；
- 不自动重发；
- 在 production-default E2E 中真实出现的“疑似截断回复”能够被自动识别并恢复。

验证记录：[`docs/verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md`](docs/verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md)。

### 3. 去掉人工 clipboard relay

没有外循环桥时，常见流程是：

```text
DSH 停下 → 人复制上下文 → 打开 GPT Web → 解释问题
→ 复制回答 → 再告诉 DSH → Agent 继续
```

使用 DSH-GPTLoop：

```text
DSH → checkpoint → GPT Web → review read-back → DSH resumes
```

只有关键 checkpoint 会被发送。普通进度留在本地，证据自动附带，回复自动回到同一条 DSH 工作流，不需要反复复制粘贴。

### 4. 近乎零额外 DSH 模型 Token 开销

DSH-GPTLoop **不会**在 DSH 的内部推理循环里再插入一个 LLM。分类、gate、证据处理、传输和 retry 控制都由确定性的本地逻辑完成；外部审查发生在你本来就在使用的 GPT Web 会话中。

因此，桥接机制本身带来的 **额外 DSH model-token 开销接近于零**。这并不意味着外部 GPT 审查完全不消耗 token，而是说：仅仅为了让桥接机制工作，不需要额外增加一轮 DSH 模型推理。

## DSH 单独使用 vs. DSH + DSH-GPTLoop

| 能力 | DSH 单独使用 | DSH + DSH-GPTLoop |
|---|---|---|
| Agent 执行 | ✅ 原生 | ✅ 原生 |
| 会话 / 子 Agent | ✅ 原生 | ✅ 原生 |
| 沙箱 / 权限 | ✅ 原生 | ✅ 原生 |
| 原生审批 | ✅ 原生 | ✅ 原生 |
| 已有 GPT Web 项目上下文 | 人工转交 | ✅ 已连接 |
| 持续外循环项目推理 | 人工 | ✅ 已连接 |
| 跨工具项目上下文（已连接时） | 分散/人工 | ✅ 可进入外循环 |
| 独立外部审查 | 人工 | ✅ 自动 checkpoint |
| 证据交付 | 人工复制/粘贴 | ✅ 自动附件 |
| 审查结果回读 | 人工复制/粘贴 | ✅ 自动 |
| 桥接机制额外 DSH 模型循环 | — | **接近零** |
| Relay / malformed-response failure | 依赖人工 | **Fail closed** |

## 快速开始

技术插件包仍然位于 [`governloop-dsh/`](governloop-dsh/)。完整安装、配置和测试说明见该目录 README。

前置条件：

- 固定 `@deepseek-ai/dsh@0.1.1-rc.2`；
- [GovernLoop Core](https://github.com/liangzhipengdamon-maker/GovernLoop)，包含 Neutral Relay 和 session manager；
- Chrome 通过 CDP 启动（`--remote-debugging-port=9233`）；
- 已打开 GPT Web 会话，并绑定到 GovernLoop session。

安装 / 挂载：

```text
dsh plugin --profile <name> add governloop-dsh
```

也可以通过 `governloop-dsh/cordis.patch.yml` 本地挂载，并将 `GOVERLOOP_SESSION_MANAGER_PATH` 指向 `governloop_session.py`。

完整技术指南：[`governloop-dsh/README.md`](governloop-dsh/README.md)。

## 安全边界

- GPT 审查只是 advisory evidence，不是执行授权。
- 当前 DSH 集成要求人类授权的地方，必须获得明确的人类授权。
- 失败保持 blocked；不自动重发。
- DSH 原生 sandbox、permission、session 和 approval 行为仍然具有权威性。
- 已连接的项目工具继续保留各自的权威；DSH-GPTLoop 不会把 GPT Web 变成通用执行权威或生命周期授权源。
- DSH-GPTLoop 保持轻量；Core transport 与 evidence safety 规则继续归 GovernLoop Core 所有。

## 兼容性

当前已验证兼容性：

| 技术包 | @deepseek-ai/dsh | 状态 |
|---|---|---|
| `governloop-dsh` 0.1.0 | 0.1.1-rc.2 | Product Closure VERIFIED |

DSH 仍处于 developer preview，因此升级前应重新验证。

## 命名

**DSH-GPTLoop** 是本 README 使用的对外产品/展示名称。现有 GitHub 仓库暂时仍名为 `GovernLoop-DSH`，技术包仍为 `governloop-dsh`。当前 PR 不执行仓库或 package rename。

## 研究与验证历史

AGE-60（research）、AGE-61（architecture）和 AGE-65 validation slices 均保存在 `docs/` 下作为历史证据。它们**不是当前 runtime authority**。

## License

[Apache-2.0](LICENSE)。

仓库工作规则见 [`AGENTS.md`](AGENTS.md)。
