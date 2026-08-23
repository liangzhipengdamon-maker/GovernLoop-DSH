# AGE-61 — GovernLoop × DeepSeek Harness Integration Architecture

**Status:** architecture/design only — no implementation, no runtime/plugin code
**Date:** 2026-08-23
**Provenance:** based on `age-60/research-dsh-plugin-pr` @ `ae5fa72` (main @ `c115921`
+ AGE-60 research document, content-identical to canonical `age-60/research-dsh-plugin`
@ `9fb7783`). **AGE-60 is NOT merged into canonical `main`.** Primary local input:
`docs/research/AGE-60-dsh-plugin-research.md`. DSH claims cross-checked against
`@deepseek-ai/dsh@0.1.1-rc.2` package sources and `deepseek-ai/deepseek-harness`
(default branch `master`) where load-bearing.

---

## 0. Scope and principles

This document is the **implementation contract** for a thin native DeepSeek Harness
plugin (`governloop-dsh`) that connects DSH agents to GovernLoop's independent
ChatGPT review with checkpoints and evidence.

```text
DeepSeek Harness
        ↓
GovernLoop-DSH         thin native Cordis plugin
        ↓
GovernLoop Core        unchanged, agent-agnostic
        ↓
session / checkpoints / evidence / Neutral Relay
        ↓
independent ChatGPT review
        ↓
review read-back
        ↓
DeepSeek Harness resumes
```

Non-negotiable principles:

1. **Thin.** The plugin translates DSH events and carries evidence/verdicts. It never
   re-implements checkpoint semantics, evidence safety rules, relay mechanics, or
   authorization boundaries.
2. **Fail closed.** Any uncertainty about a review checkpoint or destructive action
   stops the work, never lets it through.
3. **No automatic resend.** Where GovernLoop core forbids re-sending (duplicate
   delivery risk), the plugin must not retry the transport.
4. **Advisory, not authority.** Review verdicts injected into the agent are evidence;
   they never authorize mutation, merge, deploy, or release (GovernLoop
   `AGENT_SAFETY_CONTRACT`).
5. **Send decisions, not logs.** Evidence is selected, bounded, and relevant.

Terminology: **checkpoint** in this document always means a *GovernLoop review
checkpoint* (NEW_BLOCKER, UNEXPECTED_STATE, BEFORE_DESTRUCTIVE_ACTION,
REVIEW_REQUIRED, FINAL_VERIFICATION) — not DSH's durability barriers
(`session-checkpoint-policy`), which are a separate, complementary mechanism.

---

## 1. Exact DSH event → GovernLoop checkpoint mapping

### 1.1 Trigger taxonomy

| Kind | Meaning | Detection |
|---|---|---|
| **Runtime-detectable** | The plugin observes a DSH event/state and triggers the checkpoint deterministically | `agent/*` events, `tools/*` pipeline, session events, invariant violations |
| **Agent-declared** | The agent (or human) explicitly requests the checkpoint through a plugin surface | a registered `governloop_request_review` / `governloop_final_verification` tool, or a `/governloop`-family slash command |
| **Hybrid** | A policy rule fires at a lifecycle boundary, optionally with agent/human declaration | policy counters at `agent/pre-step` / `agent/turn-stopping`, plus declaration |

**Do not pretend every checkpoint maps to exactly one DSH event.** The mapping below
names primary (canonical) hooks and secondary hooks per checkpoint.

### 1.2 The mapping

| GovernLoop checkpoint | Kind | Primary DSH hook | Trigger condition | Pause? | Evidence | Resume |
|---|---|---|---|---|---|---|
| `NEW_BLOCKER` | runtime | `agent/error` (emit) | a step/turn errors (non-recoverable), or a tool result is an error with a non-retryable code (`SANDBOX_UNAVAILABLE`, invariant failures, `INVARIANT`, fatal `WorkflowError`, goal `blocked` after `blockedAfterConsecutiveRounds`) | **yes** — reject next steps (`agent/pre-step`) until the checkpoint settles or is dismissed | error payload (`{code,message}`), triggering tool name/args, last N surface events, workspace state facts | inject verdict + `agent.steer()` (same turn) or `agent.followup()` (new turn) |
| `UNEXPECTED_STATE` | runtime (+ agent-declared) | `agent/error`; `agent/status` anomalies; invariant violations (`ctx.invariants`); `agent/request-error` terminal | state facts contradict expectations: unexpected error, policy-mode drift, invariant failure, agent notices drift and declares | **yes** — same as NEW_BLOCKER (hard pause) | error + state facts + `readSurface` snapshot of the affected window | inject verdict + resume |
| `BEFORE_DESTRUCTIVE_ACTION` | runtime | `tools/pre-execute` (waterfall) | the Destructive Action Classifier (§2) matches the tool call | **yes** — the call is **denied** (fail-closed) *before* execution; the agent stays paused at the gate | command string, parsed args, cwd, tool name, matched rule + confidence, recent transcript window | verdict injected; if approved, the agent may **retry the identical call once** (mirrors DSH bash escalation retry semantics); if blocked, the denial stands |
| `REVIEW_REQUIRED` | hybrid | `agent/pre-step` (waterfall, policy counter); `agent/turn-stopping` (serial, milestone policy); agent-declared tool/command | policy: every N steps/turns or before configured milestones (push, PR, merge attempt, large diff); or agent/human declares | **yes** — reject at `agent/pre-step` (turn closes without a step) or withhold at `agent/turn-stopping` | transcript window since last checkpoint (`readSurface`), tool results, diff artifacts (`tool/result.meta` from tool-fs), todo state | inject verdict + `agent.followup()` (fresh turn) |
| `FINAL_VERIFICATION` | hybrid (declared primary) | `agent/turn-stopping` when agent declares completion; `/governloop end --final` command; agent-declared tool | explicit declaration at end of work; **never** fired from idle/status alone (false-positive risk) | **yes** — the turn is held at `agent/turn-stopping` (serial, awaited) until the checkpoint settles | per core contract: final evidence report + manifest/verification artifact (+ session export ZIP only when core requests it) | inject verdict; if PASS → allow session end / report completion; if issues → `agent.followup()` with corrective review |

### 1.3 Secondary / observation hooks (no pause)

- `agent/status` — observe pause/resume externally (plugin-driven pauses show `running → idle`).
- `agent/session-start` — on resume, fold durable checkpoint state (§4.7) and re-raise nothing automatically (no auto-resend).
- `agent/disposed`, `session/disposed`, `turn/end {kind:'aborted'}` — cancel in-flight review (§4.6).
- `tools/result` (live) / durable `tool/result` — evidence taps; **never** pause.

### 1.4 v1 vs deferred mapping

- **v1 (prototype, §8):** `BEFORE_DESTRUCTIVE_ACTION` (runtime, tool gate).
- **v1.1:** `NEW_BLOCKER` (runtime, error-based) and `FINAL_VERIFICATION` (declared).
- **deferred:** `UNEXPECTED_STATE` (needs state-drift heuristics), `REVIEW_REQUIRED`
  policy counters (needs tuning), slash commands (needs UI), durable events
  (§4.7 — needs the out-of-repo session-event registration decision).

---

## 2. Destructive Action Classifier

Purpose: decide at `tools/pre-execute` whether a tool call is a
`BEFORE_DESTRUCTIVE_ACTION` candidate. **This is a checkpoint trigger, not a
security engine** — no generic sandboxing, no policy language, no allow-list
framework beyond a tiny explicit config.

### 2.1 Inputs (what the gate can see)

From `ToolExecution` at `tools/pre-execute`: `{ name, arguments (raw JSON string as
produced by the model), agent, parent?, callId }`, plus `exec.agent.session.header.cwd`
(the session workspace). The classifier parses `arguments` defensively
(malformed JSON → treat as suspicious for write/delete tools, §2.4).

### 2.2 Rule set (v1, deterministic, conservative)

Tool targets: `bash` (and `tool-pwsh` on Windows), `write`/`edit` via `tool-fs`,
`str_replace_editor`, `run_code` (inspect embedded tool calls where possible).

| Category | Patterns (bash command scan; fs by path) |
|---|---|
| **Destructive filesystem** | `rm -rf` / `rm -r` on non-temp paths; `rm` of tracked/protected paths; `rm`/`mv` of `.git`; `truncate` on project files; `shred`, `wipefs`, `mkfs`, `fdisk`, `format`; `dd` to block devices |
| **Git destructive / history-rewriting** | `git push --force` / `-f` (and `--force-with-lease` — flag for review by default); `git reset --hard`; `git rebase` with `--force`/`--exec` rewrite intent; `git filter-branch` / `filter-repo`; `git branch -D`; `git branch --delete --force`; `git tag -d` / `--delete`; `git update-ref -d`; `git gc --prune`; `git clean -fd`/`-fdx`; `git checkout -- .` (discards working tree); `git push` targeting `main`/protected refs (config-gated) |
| **Branch/worktree deletion** | `git worktree remove --force`; `git branch -D` (above); `git worktree prune` (flag only if config demands) |
| **Release/deploy** | `npm publish` / `yarn publish`; `gh release create`; `gh pr merge`; `git push --tags`; `git tag -a` + `push`; `terraform apply`/`destroy`; `kubectl apply`/`delete` (prod context flag); `helm upgrade`; deployment script invocations (config-gated paths) |
| **Irreversible external actions** | remote deletes (`ssh … rm`, `rsync --delete`), DB migrations (config-gated), external API writes (config-gated), `curl -X DELETE/POST` to non-localhost (config-gated) |

Every rule carries: a **stable rule id**, a **severity** (`hard-deny` = always
review; `review` = review when configured on), and a **confidence** (pattern match =
high; variable/alias/wrapper = medium).

### 2.3 What cannot be detected deterministically

- Semantic intent behind variables/aliases/functions: `rm -rf "$DIR"` — the literal
  pattern is detectable; *what `$DIR` resolves to* is not. Rule: flag the destructive
  primitive regardless of operands unless the operand is a clearly safe literal
  (e.g. `$TMPDIR`, `node_modules` under cwd — config-gated allow).
- Shell interpolation and obfuscation: `$(...)`, encoded commands, `eval` —
  detectable only as "opaque"; policy: opaque + destructive keyword → review.
- Content of writes: `tool-fs write` to a protected path is detectable; *what the
  content does* (e.g. overwriting `.env` with a secret) is content-dependent —
  protected-path list covers the highest-risk cases.
- Actions the agent performs outside DSH tools: in DSH **every** agent action is a
  tool call, so `tools/pre-execute` covers the direct surface; but calls made by
  subagent children and nested `run_code` dispatches re-enter the same pipeline —
  the classifier must be registered as a **global** (plain-context) `tools/pre-execute`
  listener so all agents (including delegated children) pass through it. Background
  jobs launched by tools are covered at launch time (the launch is a tool call).
- Non-file side effects the sandbox vocabulary does not model (network/process —
  DSH sandbox is file-effects only): covered only by the pattern list above.

### 2.4 False-positive / false-negative policy and fail-closed behavior

- **Fail-closed:** a definite rule match → `deny` (the call is not dispatched) +
  checkpoint fired. A parse failure of a write/delete/remote tool's arguments →
  treat as a match (deny + review). No match → allow through (the gate never
  blocks on uncertainty alone — over-blocking breaks the agent loop).
- **False positives are acceptable** — they produce a review, which is the safe
  direction; the checkpoint message carries the matched rule + confidence so a
  reviewer can dismiss quickly. Config `allowRules[]` (exact command prefixes)
  exists only to reduce noise for provably safe operations (e.g.
  `rm -rf node_modules` in a temp clone), never to widen risk.
- **False negatives are the risk** — mitigated by: pattern breadth, opaque-command
  rule, protected-path list, and by DSH's own sandbox as the second line of defense
  (file effects), and by the human authorization boundary as the third.
- **Retry semantics:** after `deny` + review, an approved verdict lets the model
  retry the identical call **once** (mirrors DSH bash escalation retry). A blocked
  verdict keeps the denial; the agent must not re-attempt without a new review.
- **Non-goals:** no generic policy engine, no rule language beyond the small config,
  no network/process sandboxing, no content scanning of written files beyond the
  protected-path list.

---

## 3. Evidence Selection Contract

**Principle: send decisions, not logs.** The plugin extracts *selected, bounded,
relevant* evidence; GovernLoop core owns validation, safety, and delivery.

### 3.1 Evidence sources (DSH-native)

| Source | How to read | Use |
|---|---|---|
| Session events | `ctx.on('session/event')` (live) + `ctx.sessionQuery.readSurface/readEvent/listEvents` (exact) | transcript window, turn/step context, `agent/inbox/*` facts |
| Tool call/result | durable `tool/result` (content + optional `meta`) + live `tools/result` | triggering call args, output tail, `meta` (e.g. tool-fs diffs) |
| File/diff artifacts | `tool/result.meta` diff payloads; on-demand bounded `read` of specific paths named by the trigger | diff evidence, protected-path context |
| Command/test output | bash `tool/result` content tail (bounded) | failing test output for NEW_BLOCKER / UNEXPECTED_STATE |
| Session export | `GET /api/session.export?sessionId=…` (web) / `readRaw` via persistence | **only** when core requests full evidence (FINAL_VERIFICATION contract: final report + manifest) |

### 3.2 Default evidence bundle per checkpoint (v1)

| Checkpoint | Default bundle (bounded) |
|---|---|
| `NEW_BLOCKER` / `UNEXPECTED_STATE` | error `{code,message}` + tool name/args (trigger) + last 5–10 surface events + failing output tail (≤ 4 KiB) |
| `BEFORE_DESTRUCTIVE_ACTION` | command string + parsed args + cwd + matched rule id/confidence + last 5 surface events |
| `REVIEW_REQUIRED` | transcript window since last checkpoint (≤ ~20 events or ≤ 16 KiB) + diff artifacts (≤ 3) + todo state |
| `FINAL_VERIFICATION` | final evidence report + manifest/verification artifact (+ export ZIP when core requests) |

Hard bounds the plugin enforces (exact numbers are core-policy-owned; these are the
plugin's caps): ≤ 5 attachments per checkpoint, ≤ 64 KiB per attachment, ≤ 128 KiB
total, no raw whole-log dumps, no `node_modules`/caches/browser profiles.

### 3.3 Plugin-extracts vs core-owns

- **Plugin (DSH-side):** selects candidate artifacts and formats the checkpoint
  message; attaches a **relevance hint** per candidate; reads DSH state.
- **Core (unchanged):** existence check → relevance check → secret scan → redaction
  (`.redacted`) → filename/size/sha256 recording → attachment delivery confirmation
  (`TEXT_RELAY: PASS` AND `REQUIRED_ATTACHMENTS_DELIVERED: PASS`) → refusal →
  `CHECKPOINT_DELIVERY_INCOMPLETE` (exit 1). The plugin **never** runs the secret
  scan or decides delivery success — it passes candidates through
  `governloop_session.py checkpoint --attach <path> …` and honors the exit code.

### 3.4 Checkpoint message format (plugin → core)

Structured text, not JSON: `CHECKPOINT: <TYPE>`, `SESSION: <id>`, `TRIGGER: <kind>`,
`RULE: <ruleId>` (when applicable), concise decision context, `EVIDENCE: <paths>`,
and — for review verdicts — the advisory footer (§5.5). The relay itself requires
only `REVIEW_REQUEST_ID` + `REPO` + natural-language task; extra structure is
plain-text lines that humans and ChatGPT both read naturally.

---

## 4. Pause → Review → Read-back → Resume State Machine

### 4.1 States

```text
RUNNING ──trigger──▶ CHECKPOINT_PENDING ──evidence ready──▶ REVIEW_IN_FLIGHT
   ▲                                                             │
   │                                                             │ response file
   │                                                             ▼
   └────────── inject+steer ── RESUME_PENDING ◀── validated ── REVIEW_RECEIVED
```

| State | Meaning | DSH counterpart |
|---|---|---|
| `RUNNING` | agent works normally | `agent/status: running`, steps admitted |
| `CHECKPOINT_PENDING` | trigger fired; facts/evidence being captured; agent paused at a boundary | gate denied (tool), or `agent/pre-step` rejected, or turn held at `agent/turn-stopping`; agent settles to `idle` |
| `REVIEW_IN_FLIGHT` | relay invoked (background job); waiting for ChatGPT turn | agent remains `idle` (`agent.whenIdle()` observed); relay job running via `ctx.jobs` |
| `REVIEW_RECEIVED` | response file present; plugin validates freshness/durability | — |
| `RESUME_PENDING` | verdict staged; about to inject | — |
| `RUNNING` | verdict injected + driver woken | `agent.followup()`/`agent.steer()`; `agent/status: running` |
| `FAILED` (terminal for one checkpoint) | any failure below; **no automatic resend** | agent resumes-with-notice or stays gated per §4.4 |

### 4.2 Transitions

1. `RUNNING → CHECKPOINT_PENDING`: classifier match at `tools/pre-execute` (deny) or
   `agent/pre-step` reject (REVIEW_REQUIRED/FINAL_VERIFICATION) or error observed.
   The pause is *at the boundary* — never an in-flight blocking of a tool body.
2. `CHECKPOINT_PENDING → REVIEW_IN_FLIGHT`: evidence bundle assembled (bounded);
   `governloop_session.py checkpoint` invoked as a `ctx.jobs` background job.
3. `REVIEW_IN_FLIGHT → REVIEW_RECEIVED`: job settles with exit 0; response file
   exists; freshness check passes (response mtime ≥ checkpoint start; §4.5).
4. `REVIEW_RECEIVED → RESUME_PENDING`: verdict parsed (approve/block/advise from
   response content; the review is natural language — verdict classification is
   heuristic + explicit keywords, with unknown → treat as advisory-not-blocking).
5. `RESUME_PENDING → RUNNING`: verdict injected (§5) + `agent.steer()` (tool-gate
   resumption in the same turn) or `agent.followup()` (new turn).

### 4.3 Failure states (each terminal for the checkpoint — no auto-resend)

| Failure | Detection | Behavior |
|---|---|---|
| `EVIDENCE_INCOMPLETE` | candidate attachment refused by core (exit 1 `CHECKPOINT_DELIVERY_INCOMPLETE`), or bounded assembly failed | checkpoint recorded FAILED; the gate stays denied (destructive) or agent resumes-with-notice (other types); the refusal text is surfaced to the agent |
| `RELAY_FAILURE` | relay exit ≠ 0 (non-refusal) | same fail-closed handling; no retry without explicit instruction |
| `SEND_NOT_CONFIRMED` | `SEND_NOT_CONFIRMED` / `SEND_PENDING_TIMEOUT` from core | **never** re-click/re-send (core forbids); FAILED + manual-verification guidance surfaced to the human (via `agent.inject` + UI where present) |
| `REVIEW_TIMEOUT` | relay wait-timeout (default 900 s) | FAILED; policy-configurable: destructive → stay denied; advisory → resume-with-notice ("review did not complete; verify manually") |
| `SESSION_CANCELLED` | `agent/cancel`, `turn/end {kind:'aborted'}`, `agent/disposed`, session disposed while in-flight | cancel/abandon the relay job (`job_kill`) when safe; never inject into a dead session; state discarded |
| `DUPLICATE_CHECKPOINT` | same checkpoint key (session + type + trigger fingerprint) already pending/in-flight | second trigger is **merged** into the current evidence (additive) or dropped with a log — one review per key at a time |
| `STALE_REVIEW` | response file older than checkpoint start, or a newer checkpoint superseded it | discard; do not inject |

### 4.4 Fail-closed resume policy (configurable per checkpoint type)

- destructive action gate: `deny` stands until an explicit review verdict or human
  instruction — the agent never self-unblocks.
- error/state checkpoints: resume-with-notice is allowed by default (the error is
  already in the transcript; the review adds context).
- `FINAL_VERIFICATION`: a FAILED delivery means the session end is **not** reported
  as verified.

### 4.5 Freshness and staleness

Every checkpoint records `triggeredAt` (monotonic clock) and a durable fingerprint.
`REVIEW_RECEIVED` requires `responseFile.mtime >= triggeredAt` **and** the response
file's path matches the session's response naming
(`governloop-response-<SESSION>-<TYPE>-<seq>.md` in `GOVERLOOP_STATE_DIR`).
A response that fails either check is stale → discarded, state FAILED.

### 4.6 Concurrency and cancellation

- One in-flight checkpoint per session (per-agent key). A second trigger while
  `REVIEW_IN_FLIGHT` merges evidence or is dropped (§4.3 DUPLICATE).
- Cancellation paths: agent cancel → abandon relay job → FAILED(state discarded);
  plugin unload (Cordis fiber dispose) → cancel job, no injection.
- The relay job is owned by the agent's session (`ctx.jobs` owner isolation) so
  `job_kill` from the session is authorized.

### 4.7 Durability and restart (deferred to v1.1, designed now)

Checkpoint/review state is durable state, so a restart/resume must not auto-resend.
v1 keeps state in memory + log-only session events. v1.1 appends durable
`governloop/checkpoint` and `governloop/review` session events (extending
`SessionEventMap`, **marked `ignorable`** until the out-of-repo event registration
surface lands — §10 ADR-4) and a `ctx.sessionProjections` unit; `agent/session-start`
folds the last state and treats any `REVIEW_IN_FLIGHT` at crash as FAILED (no
auto-resend).

---

## 5. Review Injection Contract

### 5.1 Mechanism choice

| Mechanism | Wakes? | Use |
|---|---|---|
| `agent.inject(message)` | no | advisory notes, refusal/send-failure guidance — never the primary verdict carrier |
| `agent.steer(message)` | yes (next-step boundary) | resuming an **open** turn after a tool-gate denial (the denial result is already in history; steering makes the model continue and retry-if-approved) |
| `agent.followup(message)` | yes (next turn) | **primary** for verdicts that must start fresh work: REVIEW_REQUIRED, FINAL_VERIFICATION follow-ups, NEW_BLOCKER/UNEXPECTED_STATE after pause |
| `agent.whenIdle()` | no — observation | confirm the agent is paused before review; confirm resumption after injection |
| `agent.cancel(cause, {keepInbox})` | n/a | hard pause fallback (not default; loses step continuity) |

**Decision:** verdict injection uses **`agent.followup()`** for turn-level
checkpoints and **`agent.steer()`** for tool-gate resumption. `inject` alone is
insufficient (the agent is idle and would stay idle); `whenIdle` is not an
injection mechanism. Rationale: followup/steer are the documented wake primitives
(`dsh-agent` README), the verdict must wake a paused agent, and both produce durable
`user/message` events on the session log.

### 5.2 Provenance — distinguishability (verified against DSH sources)

`MessageSourceMap` (`@deepseek-ai/dsh-llm`) is a **merge-extensible sum type**
("plugins add their own `kind`s"). Built-ins: `user`, `plugin`, `model`, `tool`.

The plugin declares a dedicated kind:

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'governloop-review': {
      kind: 'governloop-review'
      checkpointId: string        // e.g. 'BEFORE_DESTRUCTIVE_ACTION-<seq>'
      verdict: 'approve' | 'block' | 'advise'
      reviewSession?: string      // opaque review identifier (conversation/turn ref)
      responseSha256?: string     // fingerprint of the response file, for audit
      form?: 'relay'              // ContextForm: "a message another agent addressed to this one"
    }
  }
}
```

This makes the review verdict **structurally** distinct from: user input
(`kind:'user'`), model output (`kind:'model'`, assistant role), tool output
(`kind:'tool'`), and GovernLoop authority (the plugin never emits an authority
kind — no such kind exists; see §5.5).

### 5.3 Message framing

- Role: `user` (it enters the inbox like any queued input; the loop treats it as a
  user-role message — this is the only supported path for agent-visible content).
- Content: `[GovernLoop review — <checkpointId>]` + verdict line + the ChatGPT
  response text + a fixed advisory footer (§5.5).
- Identity: one message per review, exactly one `MessageSource` (DSH requires one
  source per message).

### 5.4 Injection ordering and durability

1. Inject **before** waking: `followup(msg)` enqueues + wakes in one call.
2. The injected message is a durable `user/message` event — replay-safe.
3. The `governloop/review` durable event (v1.1) records the verdict, response
   fingerprint, and the message id, so the transcript links review ↔ message.
4. The plugin never injects into a session it does not own (check `exec.agent` /
   session id on every path).

### 5.5 Advisory, not authority

Every injected verdict carries a fixed footer (text owned by GovernLoop core config):

> This review is advisory evidence. It does NOT authorize repository mutation,
> commit, push, PR, merge, deploy, release, or any other action. Follow the shared
> authorization boundary; only explicit user authorization grants action.

The plugin never sets approval policy, never changes sandbox mode, never calls
`ctx.agents.create/resume`, and never writes credentials — a review can inform the
agent, but cannot unlock anything by itself (§9 test 8).

---

## 6. Plugin/Core Boundary

### 6.1 Responsibility table

| Concern | GovernLoop-DSH plugin (this repo) | GovernLoop Core (unchanged) |
|---|---|---|
| Cordis registration / lifecycle | ✅ plugin row, `apply(ctx)`, fiber-scoped effects | ❌ |
| DSH lifecycle listeners | ✅ `agent/*`, `tools/*`, `session/event` | ❌ |
| Checkpoint definitions & semantics | ❌ (translates only) | ✅ five checkpoint types, meaning, ordering |
| Trigger classification (runtime/declared/hybrid) | ✅ maps DSH events → checkpoint types | ✅ owns the checkpoint protocol |
| Destructive action classifier | ✅ DSH-tool pattern rules (§2) | ❌ (DSH-specific) |
| DSH evidence extraction (selection, bounds, formatting) | ✅ | ✅ validates/exists/relevance/secret-scan/redaction/sha256 |
| Session identity (repo→task→session, ids) | ❌ consumes via CLI | ✅ |
| Neutral Relay / CDP transport | ❌ invokes via CLI | ✅ |
| ChatGPT conversation binding (per-session URL) | ❌ | ✅ |
| Delivery confirmation (3-state send model) | ❌ | ✅ |
| Fail-closed transport behavior / no auto-resend | ❌ honored | ✅ enforced |
| Pause/resume adapter (DSH gates, steer/followup) | ✅ | ❌ |
| Review read-back injection (provenance §5) | ✅ | ❌ (produces the response file only) |
| Human authorization boundary | ❌ (must not weaken) | ✅ `AGENT_SAFETY_CONTRACT` |

### 6.2 The interface seam (stable contract)

The plugin talks to core **only through the session-manager CLI**
(`governloop_session.py`), which keeps core agent-agnostic:

| Subcommand | Plugin usage |
|---|---|
| `new [--title …]` | resolve/create GovernLoop session; handle `USER_CONVERSATION_SELECTION_REQUIRED` (exit 3) → ask the human once (never persist the URL) |
| `status` | read session/binding/checkpoint state before firing |
| `bind <url>` | bind conversation URL (user-provided once per session) |
| `checkpoint <TYPE> [--message …] [--attach …]` | the whole review transport (request file, relay, attachments, response file, delivery confirmation) |
| `end [--final] [--attach …]` | FINAL_VERIFICATION + session end |

Contract details the plugin MUST honor:

- Env: `GOVERLOOP_STATE_DIR`, `GOVERLOOP_CDP_PORT`, `GOVERLOOP_RELAY_PATH` (passed
  through, never overridden).
- Exit codes: `0` success; `1` error incl. `CHECKPOINT_DELIVERY_INCOMPLETE`; `3`
  `USER_CONVERSATION_SELECTION_REQUIRED`.
- Outputs: `CHECKPOINT: <type>` / `SESSION: <id>` / `RESPONSE (head): …` lines;
  response file `governloop-response-<SESSION>-<TYPE>-<seq>.md` in the state dir
  (used for read-back; the plugin reads the file, not the echo).
- **Never** parse or rewrite the relay's canonical output semantics; never re-invoke
  after a refusal/timeout (no auto-resend).
- The plugin does not read/write `~/.governloop/relay/config.json` and never writes
  the canonical routing config.

Future: if core grows a library API, the plugin may adopt it; v1 uses the CLI seam.

### 6.3 Non-goals for the plugin

No agent creation/resume, no approval-policy or sandbox-mode mutation, no credential
handling, no web UI (v1), no session-persistence writes, no re-implementation of
checkpoint/evidence/relay/authorization semantics.

---

## 7. Installation / Distribution Contract

### 7.1 Packaging

- npm package `governloop-dsh` (scope decision in §10 ADR-9) with manifest:
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` — the patch inserts the
  plugin row `- id: governloop-dsh / name: 'governloop-dsh'` with a small config
  (relay path, classifier rules, checkpoint policy).
- **Ship prebuilt `lib/`** (no `prepare` script) so installs do not require pnpm
  `allowBuilds` (git-hosted installs run build scripts unsandboxed — avoid entirely).
- `peerDependencies`: `@deepseek-ai/dsh` pinned range; `engines`: current Node LTS.
- No dependency on modifying DeepSeek Harness upstream (out-of-tree plugin; upstream
  does not accept external PRs).

### 7.2 Installation

```text
dsh plugin --profile <name> add governloop-dsh
```

`dsh` reconciles the bundle into `dsh.profile.bundles` automatically. Local dev:
`pnpm dsh web --patch ./governloop-dsh/cordis.patch.yml` (official plugin-authoring
path). A profile `cordis.patch.yml` may layer config (policy overrides) — a patch
replaces whole row configs, so the plugin's own defaults must be complete.

### 7.3 Compatibility matrix and lifecycle

- DSH is **developer preview** (rc-only, breaking changes). The plugin pins and is
  tested against exact DSH rcs; the README/registry metadata carries a matrix:
  `governloop-dsh x.y.z ↔ @deepseek-ai/dsh 0.1.1-rc.2 (tested)`, with
  "untested rc — verify before upgrade" for others.
- Independent GovernLoop release lifecycle: plugin semver is decoupled from core
  versions; the CLI seam is the compatibility contract (core keeps the
  `governloop_session.py` surface stable).
- No auto-upgrade of DSH by the plugin; no npm `latest` trust beyond peer-range
  validation.

### 7.4 Discovery

- GitHub repo (`liangzhipengdamon-maker/GovernLoop-DSH`) + npm listing.
- Community listing on `awesome-dsh-plugin` (the ecosystem's discovery surface) and
  optionally `dshmarket` — both optional, after the plugin exists.
- Docs: README install guide + tested-DSH matrix + `AGENTS.md` boundaries.

### 7.5 Security posture

- Follow GovernLoop's supply-chain stance: pin versions, ship prebuilt artifacts,
  document `allowBuilds` guidance if git installs are offered, review before release.
- The plugin runs with full harness process privileges (DSH has no plugin
  isolation) — keep its surface minimal and its own secrets handling zero.

---

## 8. Minimal Prototype Boundary

**First vertical slice — `BEFORE_DESTRUCTIVE_ACTION` on the `bash` tool for git
destructive patterns.**

```text
DSH tool action (git push --force)
→ tools/pre-execute classifier deny        ← runtime checkpoint gate
→ evidence bundle (command, args, cwd, rule)
→ governloop_session.py checkpoint …       ← GovernLoop evidence + relay
→ independent ChatGPT review
→ response file → verdict read-back
→ agent.followup + steer                     ← DSH resume (retry-if-approved)
```

**Why this checkpoint first:**

1. Fully **runtime-detectable** — deterministic, no agent cooperation needed; the
   whole loop is testable end-to-end.
2. **Highest risk, highest value** — destructive git history operations are exactly
   what governance should catch.
3. **Fail-closed semantics are naturally testable** — default deny is observable.
4. Exercises every layer of the architecture (gate, evidence, relay, read-back,
   resume) with the smallest rule set (one category of §2.2).

**Slice scope (v1):**

- Classifier: `bash` only, git-destructive patterns + `rm -rf`-class (§2.2 first two
  rows); global `tools/pre-execute` listener; fail-closed deny; allow-list config
  shape only (empty by default).
- One checkpoint type wired (BEFORE_DESTRUCTIVE_ACTION); other mappings stubbed
  (documented, not implemented).
- Pause at the tool gate; resume via `followup`+`steer`.
- Evidence: command + args + cwd + matched rule + last 5 events.
- In-memory state + log-only session event; no durable `governloop/*` events yet.
- Relay invoked via `governloop_session.py`; tests use the stub (§9).
- No slash commands, no UI, no projections, no Typert wiring.

**Success criteria:** a headless DSH session whose task issues `git push --force`
gets denied, receives a ChatGPT review verdict (stubbed in tests), and resumes only
per the verdict; a clean task never triggers the checkpoint; every failure path in
§4.3 is covered by a test.

---

## 9. Headless Test Plan (stub relay, no real ChatGPT)

### 9.1 Harness

- A test DSH profile (headless) mounting the plugin + a **stub relay**: a fake
  `governloop_session.py`/`neutral_relay.py` that (a) validates the invocation
  contract (argv, env, exit codes), (b) writes a canned response file, and
  (c) records every invocation for assertions. Driven via
  `dsh --profile <test-profile> "<task>"` with a scratch workspace and
  `GOVERLOOP_RELAY_PATH`/`GOVERLOOP_STATE_DIR` pointing at the stub.

### 9.2 Test matrix

| # | Scenario | Assertion |
|---|---|---|
| 1 | Task calls `git push --force` | `tools/pre-execute` returns `deny`; tool body never runs; checkpoint fired exactly once |
| 2 | Pause | after the gate, no further steps execute before the review settles; `agent/status` reaches `idle` (`whenIdle`) |
| 3 | Evidence extraction | checkpoint message contains command/args/cwd/rule; attachment candidates bounded (≤ caps); no whole-log dump |
| 4 | Relay invocation contract | stub asserts exact subcommand `checkpoint BEFORE_DESTRUCTIVE_ACTION`, `--message`, `--attach` paths, env passthrough; exit codes 0/1/3 honored |
| 5 | Review read-back | stub writes response file → plugin reads it (freshness check passes) → verdict parsed |
| 6 | Resume | verdict injected with `kind:'governloop-review'` source + advisory footer; agent wakes and (on approve) retries the identical call once |
| 7 | Fail-closed (relay failure) | stub exits 1 → `CHECKPOINT_DELIVERY_INCOMPLETE` handling; **no second invocation** (stub call count == 1); tool stays denied |
| 8 | Fail-closed (send not confirmed) | stub returns SEND_PENDING_TIMEOUT semantics → no auto-resend (call count == 1); manual-verification guidance injected |
| 9 | **No accidental lifecycle authorization** | assert the plugin never: calls `ctx.agents.create/resume`, registers tools beyond its own, mutates `sandbox/mode` or `approval/policy`, writes credentials, or changes session persistence; review text does not unlock any policy |
| 10 | Review timeout | stub hangs past timeout → FAILED; destructive gate stays denied; advisory checkpoints resume-with-notice |
| 11 | Duplicate checkpoint | two identical destructive calls in one turn → one checkpoint (merged/dropped), one relay invocation |
| 12 | Stale review | response file with mtime < checkpoint start → discarded, not injected |
| 13 | Session cancelled mid-review | `agent.cancel` during `REVIEW_IN_FLIGHT` → relay job killed, no injection, no crash |
| 14 | Plugin failure containment | a throwing listener does not break the loop (DSH: "plugin failure ends the current turn, not the loop") |

### 9.3 Environment/invariants

- Stub state dir is per-test and wiped; canonical `~/.governloop` config untouched
  (assert).
- Tests run read-only against the workspace (workspace-write sandbox with a scratch
  workspace).
- An invariant check asserts the plugin never writes outside its own row config.

---

## 10. Open Questions / ADR Candidates

| # | Decision | Candidates | Recommended default |
|---|---|---|---|
| ADR-1 | Tool-gate review semantics | (a) deny + async review + retry-if-approved; (b) `approval/request` answerer (cannot express "pending"; one terminal answerer per deployment; competes with ACP bridge) | **(a)** for v1; revisit (b) only if a machine answerer becomes core-owned |
| ADR-2 | Where REVIEW_REQUIRED pauses | `agent/pre-step` reject (turn closes without a step) vs `agent/turn-stopping` hold | pre-step reject for step-frequency policy; turn-stopping for milestone policy |
| ADR-3 | MessageSource extension | dedicated `kind:'governloop-review'` (merge-extensible, verified) vs `kind:'plugin'` + content framing | dedicated kind (structural distinguishability, §5.2) |
| ADR-4 | Durable `governloop/*` session events | now (`ignorable`) vs v1.1 | v1.1 (persistence read path refuses unknown non-`ignorable` types; out-of-repo registration surface deferred) |
| ADR-5 | Checkpoint dedupe/cooldown | per-key single-flight (§4.6) vs cooldown timer | single-flight + merge; cooldown later |
| ADR-6 | `approval/request` answerer | never answer in v1 | never (avoid the terminal-answerer conflict) |
| ADR-7 | Headless vs web first | headless-first (no UI dependency) vs web (UI affordances) | headless-first (§8) |
| ADR-8 | Classifier config surface | tiny rule config + allow list vs generic policy language | tiny config; no generic engine (§2.5) |
| ADR-9 | Distribution identity | `governloop-dsh` unscoped vs `@governloop/dsh-plugin` vs GitHub-only | npm package (prebuilt lib) + GitHub; scope decided with user |
| ADR-10 | Session mapping | 1 GovernLoop session ↔ 1 DSH session vs per-task across resumes | 1:1 per DSH session; document task mapping in the checkpoint message |
| ADR-11 | Evidence default confidentiality | per-checkpoint defaults (§3.2) vs conservative all-text-only | §3.2 defaults + core validation as the safety layer |

**Open questions to verify in DSH source before implementation:**

1. Does a global `tools/pre-execute` listener observe delegated subagent children's
   tool calls (scope filtering: unscoped listeners are global — verify empirically)?
2. Exact `agent/turn-stopping` steering re-read behavior with the plugin's own
   listener ordering (serial mode).
3. `ctx.jobs` completion delivery (`wakeup` vs `quiet`) for the relay wait — quiet is
   preferred (no model wake on job end; the verdict injection wakes).
4. `MessageSource` declaration-merge path for an out-of-repo package (module
   augmentation against `@deepseek-ai/dsh-llm`).
5. Behavior of `agent.followup` on an agent in `idle` with pending injected content
   (ordering of queue vs injected context at the step boundary).

---

## Appendix A — Verified DSH facts this design depends on

| Claim | Verification |
|---|---|
| `tools/pre-execute` waterfall with `PreToolDecision = allow \| deny \| ask`; cannot rewrite args | `dsh-tools` README + `lib/types/index.d.ts` (AGE-60 §2.2) |
| `ctx.tools.guard()` monotonic after pre-execute | `dsh-tools` README |
| `agent/pre-step` waterfall; reject closes the turn without a step | `dsh-agent`/`dsh-agent-loop` READMEs + `runtime-types.d.ts` |
| `agent/turn-stopping` serial, awaited; steering re-reads inbox | `runtime-types.d.ts` |
| `agent.followup/steer/inject/whenIdle/cancel` semantics | `dsh-agent` README |
| `MessageSourceMap` is merge-extensible; kinds user/plugin/model/tool | `dsh-llm/lib/types/message.d.ts` ("Merge-extensible sum type — plugins add their own `kind`s") |
| Session log is append-only source of truth; `user/message` durable; `SessionEventMap` merge-extensible; unknown non-`ignorable` types refuse reconstruction | `dsh-session` README + `types.d.ts` + `KNOWN_SESSION_EVENT_TYPES` |
| DSH "checkpoint" = durability barrier (different meaning) | `dsh-session-checkpoint-policy` README |
| GovernLoop checkpoint types + delivery contract (TEXT_RELAY PASS AND ATTACHMENTS PASS; no auto-resend; exit codes) | GovernLoop `neutral-relay-checkpoint-delivery.md`, `governloop_session.py` |
| GovernLoop authorization boundary (review ≠ authority) | GovernLoop `AGENT_SAFETY_CONTRACT.md` |
| DSH plugin install model: `dsh plugin --profile … add <pkg>`; `dsh.bundle.patch`; profile `cordis.patch.yml`; developer preview | `dsh`/`dsh-app-boot` READMEs + upstream `docs/user/develop/basic/publish.md` |

## Appendix B — References

- AGE-60 research: `docs/research/AGE-60-dsh-plugin-research.md` (this branch's parent lineage)
- DSH upstream docs (branch `master`): `docs/architecture.md`, `docs/subsystems/{core,tools,approval,session,subagent,workflow,goal,sandbox}.md`, `docs/tool-execution-pipeline.md`, `docs/user/develop/*`
- GovernLoop core: `repos/GovernLoop` — `docs/ops/AGENT_SAFETY_CONTRACT.md`, `docs/architecture/neutral-relay-checkpoint-delivery.md`, `skills/workbuddy/governloop/scripts/governloop_session.py`, `tools/neutral-relay/neutral_relay.py`
