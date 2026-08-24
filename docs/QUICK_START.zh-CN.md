# DSH-GPTLoop 快速上手

这是当前公开版本最短的已验证使用路径。

## 已验证兼容性

- `governloop-dsh` `0.1.0`
- `@deepseek-ai/dsh@0.1.1-rc.2`
- 本地已安装 GovernLoop Core
- Chrome 以 CDP `9233` 端口启动
- 一个已经打开的 GPT Web 会话

DeepSeek Harness 仍处于 developer preview。DSH 升级后应重新验证兼容性。

## 1. 安装 GovernLoop Core

```bash
git clone https://github.com/liangzhipengdamon-maker/GovernLoop.git
cd GovernLoop
./scripts/install.sh
```

GovernLoop Core 提供 DSH adapter 所需的 session manager，以及通过 Chrome/CDP 工作的 Neutral Relay。

## 2. 用 CDP 启动 Chrome

启动 Chrome 时加入：

```text
--remote-debugging-port=9233
```

然后打开你希望作为持续外循环的 GPT Web 对话。

## 3. 绑定 GPT Web 对话

进入希望 GovernLoop 跟踪的项目目录后运行：

```bash
/governloop
```

按提示绑定当前 GPT Web conversation URL。

可以用下面的命令检查当前绑定：

```bash
/governloop status
```

## 4. 安装 DeepSeek Harness adapter

使用你实际运行的 DSH profile：

```bash
dsh plugin --profile <name> add governloop-dsh
```

本地开发时也可以通过 `governloop-dsh/cordis.patch.yml` 挂载；详见 [`../governloop-dsh/README.md`](../governloop-dsh/README.md)。

## 5. 验证一个真实 checkpoint

运行一个会触发 GovernLoop checkpoint 的 DSH 工作流。当前已验证闭环是：

```text
DeepSeek Harness
      ↓
关键 checkpoint + evidence
      ↓
GovernLoop bridge
      ↓
已有 GPT Web conversation
      ↓
独立审查 + 回读
      ↓
必要时由人类授权
      ↓
DeepSeek Harness 恢复执行
```

预期行为：

- 普通工作留在本地；
- 只有关键 checkpoint 离开本地 execution loop；
- GPT review 是 advisory evidence，不是执行授权；
- transport 或 malformed-response 失败保持 blocked；
- 不自动重发。

## Troubleshooting

### Chrome / CDP 不可用

**现象：** checkpoint 无法到达 GPT Web。

检查 Chrome 是否通过 `--remote-debugging-port=9233` 启动，并确认浏览器仍在运行。

### 没有绑定 GPT Web conversation

**现象：** GovernLoop 找不到 review request 的目标对话。

运行：

```bash
/governloop status
```

如果没有绑定 conversation，重新运行 `/governloop`，绑定目标 `https://chatgpt.com/c/...` 对话。

### DSH plugin 没有加载

**现象：** DSH workflow 中没有出现预期的 GovernLoop checkpoint 行为。

确认 plugin 安装在你实际运行的同一个 profile：

```bash
dsh plugin --profile <name> add governloop-dsh
```

同时确认 DSH 版本仍是当前已验证的 `0.1.1-rc.2`。不要直接把其他 developer-preview build 上的行为判断为插件回归。

### Adapter 找不到 session manager

本地/dev 挂载时，确认 `GOVERLOOP_SESSION_MANAGER_PATH`（或 Cordis patch config 中的 `sessionManagerPath`）指向已安装 GovernLoop Core 的 `governloop_session.py`。

不要把 `GOVERLOOP_RELAY_PATH` 当作 session manager fallback；这个名字只属于 GovernLoop Core 的 Neutral Relay。

### Review 被 block 或 timeout

当 delivery、response completion、review parsing 或必要的人类授权无法确认时，系统按设计 fail closed。

不要手工连续重发同一个 checkpoint。先修复 binding / CDP / session 问题，再通过正常 DSH workflow 重试。

## 更多说明

- 技术 adapter 指南：[`../governloop-dsh/README.md`](../governloop-dsh/README.md)
- 产品模型：[`product/DSH-GPTLoop-outer-loop.md`](product/DSH-GPTLoop-outer-loop.md)
- Product Closure 证据：[`verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md`](verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md)
