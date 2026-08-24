# GovernLoop-DSH

**DSH runs the agent. GovernLoop-DSH gives it an independent project brain to consult.**

A thin native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that connects DSH agents to your existing ChatGPT Web conversation for independent review — without replacing DSH's native runtime, sandbox, sessions, subagents, or approval system.

> **No second agent framework. No duplicated sandbox. No duplicated session system. Just the missing review bridge.**

## What gap does it fill?

DeepSeek Harness already provides the execution framework: sessions, subagents, tools, sandboxing, permissions, approval, persistence, and resume.

What it does not natively provide is a reliable bridge from a running DSH agent to an already-open ChatGPT Web conversation that can act as an independent reviewer with the project context you already keep there.

GovernLoop-DSH fills only that gap:

```text
DeepSeek Harness
        ↓
critical checkpoint
        ↓
GovernLoop-DSH          thin native Cordis adapter
        ↓
GovernLoop Core         session / evidence / Neutral Relay
        ↓
existing ChatGPT Web conversation
        ↓
independent review + read-back
        ↓
human authority when required
        ↓
DeepSeek Harness resumes
```

The design rule is simple: **native first**. If DSH already provides a capability, GovernLoop-DSH uses it instead of rebuilding it.

## Why ChatGPT Web matters

The important part is not just “another model call.” It is the **existing ChatGPT Web conversation where the human already thinks about the project**: architecture, trade-offs, research, review history, product decisions, and the context accumulated across many turns.

Local coding agents are excellent at operating the machine. ChatGPT Web is often where the higher-level project conversation already lives. GovernLoop-DSH connects those two working surfaces instead of forcing the human to act as the clipboard between them.

This is especially useful for:

- **Solo builders and one-person companies (OPCs):** one person may be product owner, architect, reviewer, researcher, and operator at the same time. A persistent external review loop reduces context switching and gives the local agent a second reasoning surface without adding another orchestration stack.
- **Vibe coding workflows:** implementation can move extremely fast, which makes independent checkpoints more valuable, not less. The bridge lets the local agent keep moving while critical decisions, risky actions, and unexpected states are surfaced to the ChatGPT conversation the builder already uses.
- **Professional engineering teams:** the same separation is useful when execution and review should not collapse into one agent context. A local runtime can remain authoritative for code, tests, sandboxing, and permissions while an external conversation provides an independent review surface. Any use with proprietary code or evidence must still follow the organization’s security and data-handling policies.

The point is not to make ChatGPT Web the execution engine. The point is to let **execution stay local while project reasoning and independent review remain connected**.

## Why it matters

### 1. It complements DSH instead of competing with it

GovernLoop-DSH does not become another orchestration layer. DSH stays authoritative for execution, sandboxing, permissions, sessions, subagents, and native approval. The adapter only translates DSH lifecycle events into the external review bridge and carries evidence and review results back.

### 2. It is verified in the real loop

**Product Closure: VERIFIED (2026-08-24).**

The full path has been tested end-to-end with real DSH + real GovernLoop Neutral Relay + Chrome/CDP + a bound ChatGPT Web conversation:

- real message delivery and evidence attachments;
- complete ChatGPT response read-back;
- exact retry authorization after explicit human approval;
- fail-closed relay failure, PO decline, and missing-attachment paths;
- backgrounded ChatGPT tab operation;
- no automatic resend;
- automatic recovery from a real truncation-shaped response during production-default E2E.

Verification record: [`docs/verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md`](docs/verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md).

### 3. It removes the human clipboard relay

Without a bridge, the common workflow is manual:

```text
DSH stops → human copies context → opens ChatGPT → explains the issue
→ copies the answer back → tells DSH what happened → agent continues
```

With GovernLoop-DSH:

```text
DSH → checkpoint → ChatGPT Web → review read-back → DSH resumes
```

Only critical checkpoints are sent. Ordinary progress stays local, evidence is attached automatically, and the response returns to the same DSH workflow without a repeated copy/paste handoff.

### 4. Near-zero additional DSH model-token overhead

GovernLoop-DSH does **not** insert another LLM into DSH's internal reasoning loop. Classification, gating, evidence handling, transport, and retry control are deterministic/local operations. The external review happens in the ChatGPT Web conversation you already use.

So the governance plumbing itself adds **near-zero additional DSH model-token overhead**. This does not mean the external ChatGPT review is token-free; it means the adapter does not require an extra DSH model reasoning loop just to operate the bridge.

## DSH alone vs. DSH + GovernLoop-DSH

| Capability | DSH alone | DSH + GovernLoop-DSH |
|---|---|---|
| Agent execution | ✅ Native | ✅ Native |
| Sessions / subagents | ✅ Native | ✅ Native |
| Sandbox / permissions | ✅ Native | ✅ Native |
| Native approval | ✅ Native | ✅ Native |
| Existing ChatGPT Web project context | Manual handoff | ✅ Connected |
| Independent external review | Manual | ✅ Automatic checkpoint |
| Evidence delivery | Manual copy/paste | ✅ Automatic attachments |
| Review read-back | Manual copy/paste | ✅ Automatic |
| Extra DSH model loop for bridge mechanics | — | **Near-zero** |
| Relay / malformed-response failure | Human-dependent | **Fail closed** |

## Quick start

The plugin package lives in [`governloop-dsh/`](governloop-dsh/). Its README contains the full install, configuration, and test instructions.

Prerequisites:

- pinned `@deepseek-ai/dsh@0.1.1-rc.2`;
- [GovernLoop Core](https://github.com/liangzhipengdamon-maker/GovernLoop) with the Neutral Relay and session manager;
- Chrome running with CDP (`--remote-debugging-port=9233`);
- an open ChatGPT conversation bound to the GovernLoop session.

Install / mount:

```text
dsh plugin --profile <name> add governloop-dsh
```

Or mount locally with `governloop-dsh/cordis.patch.yml` and set `GOVERLOOP_SESSION_MANAGER_PATH` to `governloop_session.py`.

Full package guide: [`governloop-dsh/README.md`](governloop-dsh/README.md).

## Safety boundary

- ChatGPT review is advisory evidence, never execution authority.
- Explicit human authorization is required where the current DSH integration requires it.
- Failures stay blocked; no automatic resend.
- DSH native sandbox, permission, session, and approval behavior remains authoritative.
- GovernLoop-DSH stays thin; Core transport and evidence safety rules remain in GovernLoop Core.

## Compatibility

Current verified compatibility:

| governloop-dsh | @deepseek-ai/dsh | Status |
|---|---|---|
| 0.1.0 | 0.1.1-rc.2 | Product Closure VERIFIED |

DSH is developer preview, so upgrades should be re-verified before use.

## Research and verification history

AGE-60 (research), AGE-61 (architecture), and AGE-65 validation slices are preserved under `docs/` as historical evidence. They are **not current runtime authority**.

## License

[Apache-2.0](LICENSE).

See [`AGENTS.md`](AGENTS.md) for repository working rules.
