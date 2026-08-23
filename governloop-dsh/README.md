# governloop-dsh

Thin native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin that connects DSH agents to **GovernLoop**'s independent ChatGPT review with
checkpoints and evidence.

**Version 0.1.0 — minimal vertical slice:** `BEFORE_DESTRUCTIVE_ACTION` on
destructive `bash` commands (git history-rewriting + `rm -rf` class). Design
contract: `docs/architecture/AGE-61-governloop-dsh-integration-architecture.md`
(Rev 2). Verified runtime assumptions: `docs/spikes/AGE-63-dsh-runtime-verification.md`.

```text
DSH tool action (git push --force)
→ tools/pre-execute classifier deny + latch
→ agent/pre-step rejects while latch set (pause)
→ evidence → governloop_session.py → ChatGPT review (structured envelope)
→ explicit human (PO) authorization via userQuestions
→ one-shot retry token (exact call, expiring)
→ verdict injected + followup (resume)
```

## Authority model (non-negotiable)

- The ChatGPT review is **advisory evidence only**. It never authorizes execution.
- A destructive action may only run after **explicit human (Product Owner)
  authorization** mints a **one-shot retry token** bound to
  `session + call fingerprint + exact command/args + expiry` (default 10 min).
- **Fail closed:** an unknown/malformed/low-confidence review, a declined PO, a
  relay failure, or a timeout keeps the action blocked (session latch held).
  **No automatic resend.**
- GovernLoop core is unchanged and agent-agnostic; this plugin only translates DSH
  events and carries evidence/verdicts through the `governloop_session.py` CLI seam.

## Install

```text
dsh plugin --profile <name> add governloop-dsh
```

Or mount locally (dev): `dsh --profile <name> --patch <repo>/governloop-dsh/cordis.patch.yml "…"`
with `GOVERLOOP_RELAY_PATH` pointing at `governloop_session.py`.

### Config (`cordis.patch.yml` row)

| Key | Default | Meaning |
|---|---|---|
| `relayPath` | env `GOVERLOOP_RELAY_PATH` | session-manager executable |
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
| 0.1.0 | 0.1.1-rc.2 | tested (unit + headless E2E) |
| — | other rcs | verify before upgrade (developer preview, breaking changes) |

## Tests

```text
node --test governloop-dsh/tests/unit.test.mjs governloop-dsh/tests/unit-gate.test.mjs  # 21 unit tests (classifier/envelope/token/gate-latch-provider)
DSH_BIN=<pinned dsh binary> node governloop-dsh/tests/harness/run-e2e.mjs
```

- The E2E is **keyless** (scripted mock LLM adapter, stub relay, scratch DSH_HOME)
  and requires the pinned `@deepseek-ai/dsh@0.1.1-rc.2` binary via the `DSH_BIN`
  env var (no machine-specific path is committed).
- Scenarios: approve (full chain), PO decline (blocked), relay failure (fail
  closed, no auto-resend), malformed review envelope (blocked), malformed PO
  answer (blocked).

## Closure confirmations (AGE-63 final review round, 2026-08-24)

- **execution-plane governance**: the gate is `tools/pre-execute` (allow/deny
  decision path). It is NOT a general argument-mutation hook — `tools/pre-execute`
  does not rewrite execution arguments (parsed arguments only; input rewrite is
  not supported at that seam). Result/evidence observation is `tools/result`
  (live) plus the durable `tool/result`; the evidence path never grants execution
  authority.
- **DSH native enforcement stays authoritative**: a GovernLoop allow only lets a
  call proceed through the NORMAL DSH pipeline — DSH sandbox, permission policy,
  `approval/policy: never`, missing runtime capability, and native fail-closed
  conditions still apply. The connector never calls `setSandboxMode` /
  `setApprovalPolicy` and never elevates DSH permissions.
- **per-session isolation**: latch / pending-checkpoint / retry state is keyed by
  the DSH `SessionId`; a session cannot consume or inherit another session's
  state; no global approval state exists (sub-agent tool calls pass through the
  same global pipeline listener but each session's checkpoint state is its own).
- **ADR-13 headless provider: preserved** — it is a headless *transport
  fallback* only: never overwrites an already-active provider, never
  auto-approves, never claims governance authority, missing answer / missing
  provider fails closed, and `dispose()` restores the slot only if it is still
  ours (Cordis-effect cleanup on unload; a provider installed later is left
  untouched).
- **token/grant**: the security invariant holds — explicit human PO
  authorization → narrowly bound single-use grant (session + fingerprint +
  exact command/args + expiry) → exact execution only; ChatGPT review alone
  never authorizes; replay/reuse and mismatch fail closed. The physical mint
  location (connector-side mechanics) is an architecture-placement question
  tracked for AGE-64 / future Core centralization — intentionally NOT relocated
  in this PR.
- **transport/control plane**: `ctx.apiProxy` is DSH Host↔Client
  infrastructure, not the governance boundary; nothing in this connector treats
  it as a public remote-control API.
- **not implemented here (AGE-64 scope)**: universal execution identity,
  multi-agent lineage aggregation, governance transcript/projection events
  (`governloop/review-request` / `governloop/review-response`), cross-agent
  durable context, remote-agent protocol, ChatGPT memory integration.

## Layout

- `lib/index.js` — plugin wiring
- `lib/checkpoint.js` — latch + state machine (AGE-61 §4)
- `lib/classifier.js` — destructive action classifier (AGE-61 §2)
- `lib/envelope.js` — structured review envelope (AGE-61 §3.4)
- `lib/token.js` — one-shot retry token (AGE-61 §4.3)
- `lib/relay.js` — `governloop_session.py` CLI client (AGE-61 §6.2)
- `tests/` — unit tests + keyless headless E2E harness (stub relay)
