# DSH-GPTLoop

**English** | [简体中文](README.zh-CN.md)

> **Not using DeepSeek Harness?** This repository is the DSH adapter. For
> WorkBuddy, OpenCode, Claude Code, Codex, or any other agent, use
> [GovernLoop Core](https://github.com/liangzhipengdamon-maker/GovernLoop) directly.

**The outer loop for DeepSeek Harness.**

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) to a persistent GPT Web outer loop for project reasoning, independent review, and human authority.

**Fast inner loop. Persistent outer loop. One project.**

DSH keeps doing what it is good at: local execution, tools, tests, sandboxing, sessions, subagents, permissions, approval, and resume. DSH-GPTLoop adds only the missing bridge to the GPT Web conversation where the wider project discussion already lives.

> **No second agent framework. No duplicated sandbox. No duplicated session system. Just the missing outer loop.**

## Inner loop + outer loop

```text
                 GPT Web
        persistent outer loop
   project context / reasoning / review
                 ↑
                 │
            DSH-GPTLoop
      GovernLoop bridge + DSH adapter
                 │
                 ↓
        DeepSeek Harness
        fast execution loop
   plan / act / tools / test / resume
```

The product boundary is simple:

- **DSH = fast local execution / inner loop**
- **GPT Web = persistent project reasoning + independent review / outer loop**
- **DSH-GPTLoop = the bridge between them**

The design rule is **native first**. If DSH already provides a capability, DSH-GPTLoop uses it instead of rebuilding it.

## Why GPT Web matters

The important part is not just another model call. It is the **existing GPT Web conversation where the human already thinks about the project**: architecture, research, trade-offs, review history, product decisions, blocker resolution, and context accumulated across many turns.

Local coding agents are excellent at operating the machine. GPT Web is often where the wider project conversation already lives. DSH-GPTLoop connects those two working surfaces instead of forcing the human to act as the clipboard between them.

This matters especially for:

- **Solo builders and one-person companies (OPCs):** one person may be product owner, architect, researcher, reviewer, and operator at the same time. A persistent outer loop reduces context switching and lets the local execution agent consult the project context already maintained in GPT Web.
- **Vibe coding workflows:** implementation can move extremely fast. That makes independent checkpoints more valuable, not less. Critical decisions, destructive actions, blockers, and unexpected states can be surfaced without turning every local step into another model conversation.
- **Professional engineering teams:** execution and review do not have to collapse into one agent context. The local runtime can remain authoritative for code, tests, sandboxing, and permissions while GPT Web provides a separate reasoning/review surface. Proprietary code and evidence must still follow the organization’s security and data-handling policies.

The point is not to make GPT Web the execution engine. The point is to let **execution stay local while project reasoning and independent review remain connected**.

## GPT Web as the project outer loop

GPT Web can be more than a review surface. **When the relevant tools are connected and authorized**, it can sit across the development lifecycle and bring their context into one persistent reasoning workspace.

```text
                      GPT Web
               persistent project outer loop

      research / product / architecture / review
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
                   local execution
                         ↓
               code / tools / tests
```

A real software project spans far more than code generation:

**Idea / Research → Product Decision → Issue → Implementation → Test → Review → PR → CI → Merge → Release → Documentation → Follow-up**

DSH is strongest in the fast local execution part of that chain. GPT Web can help connect the surrounding project context — for example research and product reasoning, Linear issues and blockers, GitHub repositories / pull requests / CI evidence, documentation, release-readiness review, and follow-up work — when those systems are available to the GPT workspace.

That does **not** move authority into GPT Web:

- GitHub remains the authority for repository content, commits, pull requests, and repository lifecycle state.
- Linear remains the authority for issue and project tracking when it is used.
- CI remains verification evidence; a green check is not itself merge or release authorization.
- DSH remains authoritative for its native runtime, execution, sandbox, permission, session, and approval behavior.
- Humans retain consequential lifecycle authority where required.

GPT Web does not replace those systems. **It connects their context.**

> **The local agent knows what it is doing now. The outer loop knows why the project is doing it.**

And as coding agents become faster, this separation becomes more useful:

> **The faster the inner loop becomes, the more valuable the outer loop becomes.**

More detail: [`docs/product/DSH-GPTLoop-outer-loop.md`](docs/product/DSH-GPTLoop-outer-loop.md).

## What gap does it fill?

DeepSeek Harness already provides the execution framework. What it does not natively provide is a reliable bridge from a running DSH agent to an already-open GPT Web conversation with the project context the human already maintains there.

DSH-GPTLoop fills only that gap:

```text
DSH critical checkpoint
        ↓
thin native governloop-dsh adapter
        ↓
GovernLoop Core
session / evidence / Neutral Relay
        ↓
existing GPT Web conversation
        ↓
independent review + read-back
        ↓
human authority when required
        ↓
DSH resumes
```

## Why it matters

### 1. It complements DSH instead of competing with it

DSH-GPTLoop does not become another orchestration layer. DSH stays authoritative for execution, sandboxing, permissions, sessions, subagents, and native approval. The adapter only translates DSH lifecycle events into the external review bridge and carries evidence and review results back.

### 2. It is verified in the real loop

**Product Closure: VERIFIED (2026-08-24).**

The full path has been tested end-to-end with real DSH + real GovernLoop Neutral Relay + Chrome/CDP + a bound GPT Web conversation:

- real message delivery and evidence attachments;
- complete GPT response read-back;
- exact retry authorization after explicit human approval;
- fail-closed relay failure, PO decline, and missing-attachment paths;
- backgrounded GPT Web tab operation;
- no automatic resend;
- automatic recovery from a real truncation-shaped response during production-default E2E.

Verification record: [`docs/verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md`](docs/verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md).

### 3. It removes the human clipboard relay

Without the outer loop bridge:

```text
DSH stops → human copies context → opens GPT Web → explains the issue
→ copies the answer back → tells DSH what happened → agent continues
```

With DSH-GPTLoop:

```text
DSH → checkpoint → GPT Web → review read-back → DSH resumes
```

Only critical checkpoints are sent. Ordinary progress stays local, evidence is attached automatically, and the response returns to the same DSH workflow without repeated copy/paste handoffs.

### 4. Near-zero additional DSH model-token overhead

DSH-GPTLoop does **not** insert another LLM into DSH's internal reasoning loop. Classification, gating, evidence handling, transport, and retry control are deterministic/local operations. The external review happens in the GPT Web conversation you already use.

So the bridge mechanics themselves add **near-zero additional DSH model-token overhead**. This does not mean the external GPT review is token-free; it means the adapter does not require an extra DSH model reasoning loop just to operate the bridge.

## DSH alone vs. DSH + DSH-GPTLoop

| Capability | DSH alone | DSH + DSH-GPTLoop |
|---|---|---|
| Agent execution | ✅ Native | ✅ Native |
| Sessions / subagents | ✅ Native | ✅ Native |
| Sandbox / permissions | ✅ Native | ✅ Native |
| Native approval | ✅ Native | ✅ Native |
| Existing GPT Web project context | Manual handoff | ✅ Connected |
| Persistent outer-loop project reasoning | Manual | ✅ Connected |
| Cross-tool project context (when connected) | Fragmented/manual | ✅ Available to outer loop |
| Independent external review | Manual | ✅ Automatic checkpoint |
| Evidence delivery | Manual copy/paste | ✅ Automatic attachments |
| Review read-back | Manual copy/paste | ✅ Automatic |
| Extra DSH model loop for bridge mechanics | — | **Near-zero** |
| Relay / malformed-response failure | Human-dependent | **Fail closed** |

## Product demo

Real recorded workflow, ~45 seconds, end-to-end (no simulation): a DSH agent
triggers a destructive-action checkpoint → the GovernLoop bridge sends evidence
to the existing GPT Web conversation → the independent review comes back →
explicit human approval → the exact retry executes → DSH resumes.

https://github.com/user-attachments/assets/60ece667-3e4c-46cd-8b83-1dea15ec7e08

*(Click ▶ to play the 45-second demo inline. Background music: PIXABAY.)*

## Quick start

The technical plugin package remains [`governloop-dsh/`](governloop-dsh/). Its README contains the full install, configuration, and test instructions.

Prerequisites:

- pinned `@deepseek-ai/dsh@0.1.1-rc.2`;
- [GovernLoop Core](https://github.com/liangzhipengdamon-maker/GovernLoop) — install it
  first (`./scripts/install.sh`); it provides the session manager
  (`governloop_session.py`) and the Neutral Relay;
- Chrome running with CDP (`--remote-debugging-port=9233`);
- an open GPT Web conversation bound to the GovernLoop session.

Install / mount:

```text
dsh plugin --profile <name> add governloop-dsh
```

Or mount locally with `governloop-dsh/cordis.patch.yml` and set `GOVERLOOP_SESSION_MANAGER_PATH` to `governloop_session.py`.

Full package guide: [`governloop-dsh/README.md`](governloop-dsh/README.md).

## Safety boundary

- GPT review is advisory evidence, never execution authority.
- Explicit human authorization is required where the current DSH integration requires it.
- Failures stay blocked; no automatic resend.
- DSH native sandbox, permission, session, and approval behavior remains authoritative.
- Connected project tools retain their own authority; DSH-GPTLoop does not turn GPT Web into a universal execution or lifecycle authority.
- DSH-GPTLoop stays thin; Core transport and evidence safety rules remain in GovernLoop Core.

## Compatibility

Current verified compatibility:

| Technical package | @deepseek-ai/dsh | Status |
|---|---|---|
| `governloop-dsh` 0.1.0 | 0.1.1-rc.2 | Product Closure VERIFIED |

DSH is developer preview, so upgrades should be re-verified before use.

## Naming

**DSH-GPTLoop** is the public product/display name used by this README. The existing GitHub repository remains `GovernLoop-DSH` and the technical package remains `governloop-dsh` for now. This PR does not rename either one.

## Research and verification history

AGE-60 (research), AGE-61 (architecture), and AGE-65 validation slices are preserved under `docs/` as historical evidence. They are **not current runtime authority**.

## License

[Apache-2.0](LICENSE).

See [`AGENTS.md`](AGENTS.md) for repository working rules.
