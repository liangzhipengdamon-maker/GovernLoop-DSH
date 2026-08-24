# DSH 原生能力边界登记簿（Native Capability Boundary Register）

**Status:** research/verification — 供 adoption gate 使用，不是授权文件
**Baseline:** `@deepseek-ai/dsh@0.1.1-rc.2`（首次登记 2026-08-24，源码级核验）
**原则来源:** GovernLoop 项目治理决定（用户明确指令，2026-08-24）

---

## 0. 原则：原生能力缺口证明门（Native-Gap Proof Gate）

**任何治理项目要加入 GovernLoop（核心或插件），前置条件是提交源码级证明——
DSH 原生不存在、或无法提供该能力。证明不充分的，不加入**（宁可留在 DSH 侧、
或暂缓；不得凭"理念上应由 GovernLoop 管"纳入）。

三条操作规则：

1. 每份 AGE 研究报告 / 架构文档必须含固定小节 **`Native-Gap Proof`**，
   列出该项对应的 DSH 源码证据路径（包名 / 文件 / 行号 / 配置行）+ 一句结论。
2. 新增治理项目时，先在本登记簿补一行（含证明路径），再谈实现。
3. 版本升级（DSH 为 rc，兼容性会变）→ 重验受影响行的证明；证明失效即该项
   重新进入待审状态。

---

## 1. 登记表（治理项目 × DSH 原生对应物 × 证明路径 × 判定）

| # | GovernLoop 治理项目 | DSH 原生对应物 | Native-Gap Proof（源码证据路径） | 判定 |
|---|---|---|---|---|
| G1 | Neutral Relay / CDP→ChatGPT Web | 无浏览器桥、无网页会话连接器 | 全 `lib/` 无 puppeteer/playwright/selenium/webdriver/cdp（`playwright` 仅 `dsh-web-frontend/package.json` devDependencies，DSH 自身 UI 测试）；`dsh-base/cordis.patch.yml` L396–418：`tool-web` `fetch:false`、未挂载 fetch provider（注释明言 SSRF fail-closed） | ✅ 符合前提 |
| G2 | 送达确认 / fail-closed 传输 | 无任何外部会话传输 → 无"送达"概念 | 随 G1（无外部传输即无送达语义）；DSH 事件平面均限自身进程/本地 JSONL/apiProxy 到自有 client | ✅ 符合前提 |
| G3 | ChatGPT 会话绑定（URL 会话级、永不持久化） | DSH 无外部会话实体 | `dsh-session` SessionHeader/SessionEvent 均为本地会话；无外部会话概念 | ✅ 符合前提 |
| G4 | 独立外部评审（independent reviewer） | 无外部评审路径；subagents 为 DSH 内部子代理 | AGE-60 §6.1 "DSH has no path to an *external* reviewer"；`dsh-subagent` 语义（同 cordis 上下文的子 Agent）；本轮 G1 佐证 | ✅ 符合前提 |
| G5 | 检查点语义（五个 review gate） | `session-checkpoint-policy`（持久化屏障）、`agent/pre-step` reject（通用否决） | AGE-60 §5：DSH "checkpoint" = durability barrier，GovernLoop "checkpoint" = review gate，互补不重复；DSH 无评审门语义 | ✅ 符合前提（语义层） |
| G6 | 证据安全规则（存在→相关→密文扫描→脱敏→sha256） | 附件存储 `dsh-attachment-local`、`spill-policy`（大小）、`tool-result-pruner`（压缩）；redaction **仅限 settings/credentials 域** | `dsh-host-apiproxy/.../settings.d.ts` L3–24：`redactSecrets: true` 仅针对 schema 声明槽（API key 不外泄到 UI）；**无通用出站证据密文扫描/脱敏** | ✅ 符合前提（机制层缺口成立） |
| G7 | 人类授权边界（review PASS / relay 成功 ≠ 授权） | `ctx.approval`（ask/never/one-shot）为**机制** | 机制与规则分层：DSH 提供审批机制；"评审结果不构成授权"是治理规则（GovernLoop `AGENT_SAFETY_CONTRACT`），DSH 无此规则层。**措辞固化**：GovernLoop 提供规则而非机制，避免被误判为重复 `ctx.approval` | ✅ 符合前提（规则≠机制，需在文档中保持此表述） |

**首版结论：现有七项治理项目全部过门。** 其中 G1（relay 缺口）与 G6（出站
密文扫描/脱敏缺口）的源码证据为 2026-08-24 本轮补齐；其余五项在
`docs/research/AGE-60-dsh-plugin-research.md` §5 已有记录，此处汇总统一致。

---

## 2. 证明方法（如何做一次合格的 Native-Gap Proof）

1. **固定基准**：记录核验的 `@deepseek-ai/dsh` 版本与日期（rc 版本会变）。
2. **搜索面**：`node_modules/@deepseek-ai/*/lib`（含 `types/`）与各
   `cordis.patch.yml` 配置行；必要时查 `package.json`（区分 deps / devDeps）。
3. **证据形式**：包名 + 文件路径 + 行号/配置行 + 一句结论（"无/有但语义不符"）。
4. **反例检查**：声称"原生不能"前，先搜关键词（browser / cdp / fetch / redact /
   secret / chatgpt…），确认**不存在**或**语义不匹配**（例：DSH 的 redaction 仅限
   settings 域，不构成通用证据脱敏）。
5. **记录**：结论写入本登记簿对应行；版本升级后重验。

---

## 3. 使用规则

- 本登记簿是**研究文档，不是授权**：一项过门 ≠ 已采纳；是否加入 GovernLoop 仍需
  PO adoption 决策（与 AGE-64 路线一致：验证 → adoption gate → 独立实现 issue）。
- 本登记簿不修改任何运行时/插件代码；`governloop-dsh/` 运行时保持不动。
- AGENTS.md 边界条款未改动（其自身治理要求显式授权）。

---

## 4. 变更记录

- 2026-08-24：首版登记（G1–G7）；随 AGE-65 Slice 2 研究一并提交（Draft PR #7）。
