# governloop-dsh

Technical DSH adapter package for **DSH-GPTLoop — The outer loop for DeepSeek Harness**.

DSH-GPTLoop connects [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) to a persistent GPT Web outer loop for project reasoning, independent review, and human authority. This package stays deliberately thin: DSH remains the fast local execution loop; GPT Web remains the persistent outer-loop reasoning surface; GovernLoop provides the bridge.

> **Native first. No second agent framework. No duplicated sandbox. No duplicated session system.**

The outer loop can also become a cross-tool project context surface when the relevant systems are connected to GPT Web — for example research sources, Linear planning/issues, GitHub repositories / pull requests / CI evidence, documentation, and release-readiness work. Those systems retain their own authority; the adapter does not turn GPT Web into a universal execution or lifecycle authority.

Product explanation: [`../docs/product/DSH-GPTLoop-outer-loop.md`](../docs/product/DSH-GPTLoop-outer-loop.md).

**Version 0.1.0 — minimal vertical slice:** `BEFORE_DESTRUCTIVE_ACTION` on destructive `bash` commands (git history-rewriting + `rm -rf` class). Design contract: `docs/architecture/AGE-61-governloop-dsh-integration-architecture.md` (Rev 2). Verified runtime assumptions: `docs/spikes/AGE-63-dsh-runtime-verification.md`.

```text
DSH tool action (git push --force)
→ tools/pre-execute classifier deny + latch
→ agent/pre-step rejects while latch set (pause)
→ evidence → governloop_session.py → GPT Web review (structured envelope)
→ explicit human (PO) authorization via userQuestions
→ one-shot retry token (exact call, expiring)
→ verdict injected + followup (resume)
```

## Authority model (non-negotiable)

- GPT Web review is **advisory evidence only**. It never authorizes execution.
- A destructive action may only run after **explicit human (Product Owner) authorization** mints a **one-shot retry token** bound to `session + call fingerprint + exact command/args + expiry` (default 10 min).
- **Fail closed:** an unknown/malformed/low-confidence review, a declined PO, a relay failure, or a timeout keeps the action blocked (session latch held). **No automatic resend.**
- DSH native sandbox, permissions, sessions, and approval behavior remain authoritative.
- Connected tools keep their own authority: GitHub for repository state, Linear for issue/project tracking when used, CI as verification evidence, and humans for consequential lifecycle authorization where required.
- GovernLoop Core remains agent-agnostic; this plugin only translates DSH events and carries evidence/verdicts through the `governloop_session.py` CLI seam.

## Install

```text
dsh plugin --profile <name> add governloop-dsh
```

Or mount locally (dev): `dsh --profile <name> --patch <repo>/governloop-dsh/cordis.patch.yml "…"` with `GOVERLOOP_SESSION_MANAGER_PATH` (or `config.sessionManagerPath`) pointing at `governloop_session.py`.

### Config (`cordis.patch.yml` row)

| Key | Default | Meaning |
|---|---|---|
| `sessionManagerPath` | env `GOVERLOOP_SESSION_MANAGER_PATH` | session-manager executable (preferred; P1 path-contract fix) |
| `relayPath` | (config only) | **DEPRECATED config-only** alias for the session-manager path. `GOVERLOOP_RELAY_PATH` is **no longer** a session-manager fallback — it belongs exclusively to Core's Neutral Relay |
| `stateDir` | env `GOVERLOOP_STATE_DIR` | GovernLoop session state dir |
| `cdpPort` | env `GOVERLOOP_CDP_PORT` | CDP port passthrough |
| `tokenTtlMs` | 600000 | one-shot retry token expiry |
| `evidenceMaxEvents` | 20 | rolling evidence buffer size |
| `relayTimeoutMs` | 600000 | relay wait bound |
| `attachPaths` | `[]` | evidence attachments (core validates/redacts) |
| `allowRules` | `[]` | exact command prefixes exempt from review (noise reduction only) |
| `debugOut` | `''` | lifecycle JSONL log (tests/ops) |

## Tested compatibility

| governloop-dsh | @deepseek-ai/dsh | Status |
|---|---|---|
| 0.1.0 | 0.1.1-rc.2 | Product Closure VERIFIED |
| — | other rcs | verify before upgrade (developer preview, breaking changes) |

## Tests

```text
node --test governloop-dsh/tests/unit.test.mjs governloop-dsh/tests/unit-gate.test.mjs governloop-dsh/tests/unit-relay.test.mjs
DSH_BIN=<pinned dsh binary> node governloop-dsh/tests/harness/run-e2e.mjs
```

- The E2E is **keyless** (scripted mock LLM adapter, stub relay, scratch DSH_HOME) and requires the pinned `@deepseek-ai/dsh@0.1.1-rc.2` binary via `DSH_BIN`.
- Scenarios include approve (full chain), PO decline (blocked), relay failure (fail closed, no auto-resend), malformed review envelope (blocked), and malformed PO answer (blocked).

## Closure confirmations (AGE-63 final review round, 2026-08-24)

- **execution-plane governance**: the gate is `tools/pre-execute` (allow/deny decision path). It is not a general argument-mutation hook. Result/evidence observation is `tools/result` plus durable `tool/result`; the evidence path never grants execution authority.
- **DSH native enforcement stays authoritative**: a GovernLoop allow only lets a call proceed through the normal DSH pipeline. The connector never calls `setSandboxMode` / `setApprovalPolicy` and never elevates DSH permissions.
- **per-session isolation**: latch / pending-checkpoint / retry state is keyed by DSH `SessionId`; no global approval state exists.
- **ADR-13 headless provider: preserved** — transport fallback only; never overwrites an active provider, never auto-approves, missing answer/provider fails closed, and cleanup restores only what it owns.
- **token/grant**: explicit human PO authorization → narrowly bound single-use grant → exact execution only; GPT review alone never authorizes; replay/reuse and mismatch fail closed.
- **transport/control plane**: `ctx.apiProxy` is DSH Host↔Client infrastructure, not the governance boundary.

## Layout

- `lib/index.js` — plugin wiring
- `lib/checkpoint.js` — latch + state machine
- `lib/classifier.js` — destructive action classifier
- `lib/envelope.js` — structured review envelope
- `lib/token.js` — one-shot retry token
- `lib/relay.js` — `governloop_session.py` CLI client
- `tests/` — unit tests + keyless headless E2E harness
