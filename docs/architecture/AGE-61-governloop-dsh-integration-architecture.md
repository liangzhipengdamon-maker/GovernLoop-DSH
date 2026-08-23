# AGE-61 — GovernLoop × DeepSeek Harness Integration Architecture

**Status:** architecture/design only — no implementation, no runtime/plugin code
**Date:** 2026-08-23 (Rev 2 — addresses PR #2 review BLOCKED findings 1–5 and incorporates PR #1 review corrections)
**Provenance:** based on `age-60/research-dsh-plugin-pr` @ `ae5fa72` (main @ `c115921`
+ AGE-60 research document, content-identical to canonical `age-60/research-dsh-plugin`
@ `9fb7783`), plus the AGE-60 review-correction commit (canonical `31d3bc7`, mirrored
`abfbefc`, cherry-picked here as `83d6b6a`). **AGE-60 is NOT merged into canonical
`main`.** Primary local input: `docs/research/AGE-60-dsh-plugin-research.md`. DSH
claims cross-checked against `@deepseek-ai/dsh@0.1.1-rc.2` package sources and
`deepseek-ai/deepseek-harness` (default branch `master`) where load-bearing.

**Revision history**

| Rev | Change |
|---|---|
| 1 | Initial design (PR #2 head `65006da`) |
| 2 | Review fixes: (1) authority model — ChatGPT review never mints capability; new `AWAITING_PO_AUTHORIZATION` state and one-shot retry token from human authorization only; (2) `tools/pre-execute` deny is detection, not pause — session-scoped latch at `agent/pre-step` is the pause primitive; (3) classifier inputs corrected to parsed `ToolExecution.arguments: unknown` (raw wire string is in `tool/call`, not at the gate); (4) fail-closed review parsing via a structured review envelope — unknown/malformed review stays blocked for destructive actions; (5) one execution model per checkpoint (no alternation between hold-at-turn-stopping and background-job). |

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
   stops the work, never lets it through. In particular, for destructive/high-risk
   actions an **unknown, unparseable, stale, or ambiguous review outcome stays
   blocked** and requires manual/human resolution — it is never treated as
   advisory/non-blocking.
3. **Reviewer PASS ≠ execution permission.** A ChatGPT review is **advisory
   evidence only**. It may recommend or classify, but it must **never mint the
   capability** that bypasses the destructive gate. Destructive/high-risk actions
   require **fresh, explicit human (Product Owner) authorization** before any
   retry/bypass capability is issued (GovernLoop `AGENT_SAFETY_CONTRACT`).
4. **Deny is detection, not pause.** `tools/pre-execute` `deny` skips the tool body
   and the loop can continue after the durable `tool/result`. The pause primitive is
   a **session-scoped latch** consulted at `agent/pre-step` (§4).
5. **No automatic resend.** Where GovernLoop core forbids re-sending (duplicate
   delivery risk), the plugin must not retry the transport.
6. **Send decisions, not logs.** Evidence is selected, bounded, and relevant.

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

**Every checkpoint uses exactly ONE execution model** (§4.8): either the
*latch-at-`agent/pre-step` + background review* model or the *hold-at-
`agent/turn-stopping`* model. Never both for the same checkpoint.

| GovernLoop checkpoint | Kind | Primary DSH hook | Trigger condition | Pause? (execution model) | Evidence | Resume |
|---|---|---|---|---|---|---|
| `NEW_BLOCKER` | runtime | `agent/error` (emit) | a step/turn errors (non-recoverable), or a tool result is an error with a non-retryable code (`SANDBOX_UNAVAILABLE`, invariant failures, `INVARIANT`, fatal `WorkflowError`, goal `blocked` after `blockedAfterConsecutiveRounds`) | **yes** — **latch model**: checkpoint recorded; latch set; `agent/pre-step` rejects all steps until the checkpoint settles or is dismissed | error payload (`{code,message}`), triggering tool name/args, last N surface events, workspace state facts | advisory verdict injected (`agent.followup()`, new turn); resume-with-notice permitted |
| `UNEXPECTED_STATE` | runtime (+ agent-declared) | `agent/error`; `agent/status` anomalies; invariant violations (`ctx.invariants`); `agent/request-error` terminal | state facts contradict expectations: unexpected error, policy-mode drift, invariant failure, agent notices drift and declares | **yes** — **latch model** (same as NEW_BLOCKER) | error + state facts + `readSurface` snapshot of the affected window | advisory verdict injected + resume |
| `BEFORE_DESTRUCTIVE_ACTION` | runtime | `tools/pre-execute` (waterfall) | the Destructive Action Classifier (§2) matches the tool call | **yes** — **latch model, hard**: call is **denied** (fail-closed) *before* execution; latch set synchronously; `agent/pre-step` rejects all further steps; latch released **only** by (a) a one-shot retry token minted from **explicit human (PO) authorization** (§4.3) or (b) explicit human resolution | command string, parsed args, cwd, tool name, matched rule + confidence, recent transcript window | structured review verdict is **advisory**; for destructive actions a retry requires `AWAITING_PO_AUTHORIZATION` → one-shot token (bound to session + call fingerprint + exact command/args + expiry) → inject verdict + `agent.followup()`; a blocked/unknown/declined review keeps the latch set |
| `REVIEW_REQUIRED` | hybrid | `agent/pre-step` (waterfall, policy counter); agent-declared tool/command | policy: every N steps/turns or before configured milestones (push, PR, merge attempt, large diff); or agent/human declares | **yes** — **latch model**: pre-step policy check sets the latch; turn closes without a step | transcript window since last checkpoint (`readSurface`), tool results, diff artifacts (`tool/result.meta` from tool-fs), todo state | advisory verdict injected + `agent.followup()` (fresh turn) |
| `FINAL_VERIFICATION` | hybrid (declared primary) | `agent/turn-stopping` (serial, awaited) | explicit declaration at end of work (agent-declared tool or `/governloop end --final`); **never** fired from idle/status alone (false-positive risk) | **yes** — **hold model**: the turn-stopping boundary is held (awaited) until the checkpoint settles; no background job | per core contract: final evidence report + manifest/verification artifact (+ session export ZIP only when core requests it) | if PASS → allow the turn to close / report completion; if issues → `agent.followup()` with corrective review (latch model not used here) |

### 1.3 Secondary / observation hooks (no pause)

- `agent/status` — observe pause/resume externally (latch-driven pauses show `running → idle`).
- `agent/session-start` — on resume, fold durable checkpoint state (§4.7) and re-raise nothing automatically (no auto-resend).
- `agent/disposed`, `session/disposed`, `turn/end {kind:'aborted'}` — cancel in-flight review and clear the latch (§4.6).
- `tools/result` (live) / durable `tool/result` — evidence taps; **never** pause.

### 1.4 v1 vs deferred mapping

- **v1 (prototype, §8):** `BEFORE_DESTRUCTIVE_ACTION` (runtime, latch model +
  PO authorization).
- **v1.1:** `NEW_BLOCKER` (runtime, error-based) and `FINAL_VERIFICATION` (declared,
  hold model).
- **deferred:** `UNEXPECTED_STATE` (needs state-drift heuristics), `REVIEW_REQUIRED`
  policy counters (needs tuning), slash commands (needs UI), durable events
  (§4.7 — needs the out-of-repo session-event registration decision).

---

## 2. Destructive Action Classifier

Purpose: decide at `tools/pre-execute` whether a tool call is a
`BEFORE_DESTRUCTIVE_ACTION` candidate. **This is a checkpoint trigger, not a
security engine** — no generic sandboxing, no policy language, no allow-list
framework beyond a tiny explicit config. It **detects and denies only**; it never
issues capability (§2.4).

### 2.1 Inputs (what the gate actually receives — verified for 0.1.1-rc.2)

At `tools/pre-execute`, the listener receives a frozen `ToolExecution` whose
`arguments` field is **`unknown` — the registry-materialized, losslessly
snapshotted, deep-frozen parsed JSON arguments** (per `dsh-tools/lib/types/index.d.ts`
@ 0.1.1-rc.2: `readonly arguments: unknown` — "Losslessly JSON-serializable parsed
arguments (tools validate their own schema)"; "Parsed arguments cross one
lossless-JSON materialization boundary **before policy** and are deep-frozen"; and
upstream `docs/subsystems/tools.md`: "materializes its parsed JSON arguments once
into a pipeline-owned `ToolExecution`").

The classifier therefore operates on:

- `exec.name` — the tool name (`bash`, `write`/`edit`, `str_replace_editor`, `run_code`, …);
- `exec.arguments: unknown` — **parsed** arguments. For first-party tools using
  `defineTool` the shape is validated/narrowed by the tool's schema; a raw
  `ToolDefinition` receives `args: unknown`. The classifier narrows defensively
  (plain object, own enumerable keys; malformed/non-object → treat as suspicious for
  write/delete/remote tools, §2.4);
- `exec.agent.session.header.cwd` — the session workspace (canonical filesystem identity);
- `exec.callId` / `exec.rootCallId` — call identity (used later for the one-shot
  token binding, §4.3).

**The raw model argument string (`ToolCallBlock.arguments: string`) is NOT available
at the gate** — it belongs to the durable `tool/call` record. A raw-string fallback
is **not** added unless proven against the pinned rc (it is not proven; the parsed
object is the contract).

For `bash`, `exec.arguments` is the parsed tool-call object `{ command, description,
timeoutMs?, workdir?, run_in_background?, sandbox_permissions?, justification? }` —
the classifier scans `arguments.command`.

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

### 2.4 False-positive / false-negative policy, fail-closed behavior, and capability

- **Fail-closed:** a definite rule match → `deny` (the call is not dispatched) +
  checkpoint recorded + **latch set** (§4). A malformed/non-object `arguments` for a
  write/delete/remote tool → treat as a match (deny + review). No match → allow
  through (the gate never blocks on uncertainty alone — over-blocking breaks the
  agent loop).
- **False positives are acceptable** — they produce a review, which is the safe
  direction; the checkpoint message carries the matched rule + confidence so a
  reviewer can dismiss quickly. Config `allowRules[]` (exact command prefixes)
  exists only to reduce noise for provably safe operations (e.g.
  `rm -rf node_modules` in a temp clone), never to widen risk.
- **False negatives are the risk** — mitigated by: pattern breadth, opaque-command
  rule, protected-path list, and by DSH's own sandbox as the second line of defense
  (file effects), and by the human authorization boundary as the third.
- **Capability is never granted by the classifier or the review.** The classifier
  only detects and denies. The review is advisory. A **one-shot retry token** — the
  only way past a destructive deny — is minted **exclusively from explicit human
  (PO) authorization** (§4.3), never from a ChatGPT verdict, and is bound to
  `session + call fingerprint + exact command/args + expiry`.
- **Non-goals:** no generic policy engine, no rule language beyond the small config,
  no network/process sandboxing, no content scanning of written files beyond the
  protected-path list, no capability issuance of any kind.

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

### 3.4 Checkpoint message and the structured review envelope

The checkpoint message is structured text: `CHECKPOINT: <TYPE>`, `SESSION: <id>`,
`TRIGGER: <kind>`, `RULE: <ruleId>` (when applicable), concise decision context,
`EVIDENCE: <paths>`. The relay itself requires only `REVIEW_REQUEST_ID` + `REPO` +
natural-language task.

**Review answers are solicited in a structured envelope** so verdict parsing is
structural, not heuristic natural-language interpretation:

```text
REVIEW_ENVELOPE:
{
  "verdict": "APPROVE" | "BLOCK" | "ADVISE",
  "confidence": "high" | "medium" | "low",
  "rationale": "<1-3 sentences>",
  "required_fixes": ["<actionable item>", ...]   // empty for APPROVE
}
```

- The checkpoint message instructs the reviewer to answer within the envelope and
  nothing else for the verdict fields.
- Parsing rule: the envelope must parse and validate. **For destructive/high-risk
  checkpoints (BEFORE_DESTRUCTIVE_ACTION), any missing, malformed, unknown,
  low-confidence, or ambiguous envelope → treated as BLOCKED** and routed to manual
  human resolution (never advisory/non-blocking). For advisory checkpoints
  (NEW_BLOCKER, UNEXPECTED_STATE, REVIEW_REQUIRED), a malformed envelope is surfaced
  to the human as an unverified review.
- `APPROVE` from the envelope is **advisory** — it never mints the retry token
  (§2.4, §4.3).

---

## 4. Pause → Review → Read-back → Resume State Machine

### 4.1 The pause primitive: session-scoped latch

`tools/pre-execute` **detects and denies**; it does **not** pause. Pausing is done by
a **session-scoped latch** (one boolean + checkpoint record per session):

1. On a classifier match, the pre-execute listener returns `deny` **and sets the
   latch synchronously** (recorded: checkpoint type, call fingerprint, `triggeredAt`).
2. A plain-context `agent/pre-step` listener consults the latch **first**: while the
   latch is set, it returns `{kind:'reject'}` for every proposed step. Per DSH
   semantics the rejected step's claimed messages are not retained and the turn
   closes without a step — the agent settles to `idle`. This is the pause.
3. The latch is released only on a terminal outcome for the checkpoint: review
   settled (advisory paths), or — for destructive actions — a one-shot token minted
   from human authorization, or explicit human resolution, or session teardown.

This is the **only** pause mechanism for tool-gate and step-level checkpoints. (The
serial `agent/turn-stopping` hold is used **only** for FINAL_VERIFICATION; §4.8.)

### 4.2 States

```text
RUNNING ──trigger──▶ CHECKPOINT_PENDING ──evidence ready──▶ REVIEW_IN_FLIGHT
   ▲                                                          │
   │                                                          │ response file
   │                                                          ▼
   │                                              REVIEW_RECEIVED (envelope validated)
   │                                                          │
   │                            advisory checkpoints ─────────┤
   │                                                          ▼
   │                                              AWAITING_PO_AUTHORIZATION
   │                                                          │  (destructive/high-risk only;
   │                                                          │   explicit human auth)
   │                                                          ▼
   └──────── inject verdict + followup ── RESUME_PENDING ◀── one-shot token minted
               (latch released)
```

| State | Meaning | DSH counterpart |
|---|---|---|
| `RUNNING` | agent works normally | `agent/status: running`, steps admitted |
| `CHECKPOINT_PENDING` | trigger fired; facts/evidence captured; **latch set** | tool denied (gate) and/or `agent/pre-step` rejecting; agent settles to `idle` |
| `REVIEW_IN_FLIGHT` | relay invoked (background job); waiting for ChatGPT turn | agent remains `idle` (`agent.whenIdle()` observed); relay job via `ctx.jobs` |
| `REVIEW_RECEIVED` | response file present; freshness (§4.5) and envelope (§3.4) validated | — |
| `AWAITING_PO_AUTHORIZATION` | **destructive/high-risk only**: review advisory verdict received; explicit human (PO) authorization required before any retry capability | agent stays `idle`; plugin surfaces the authorization request to the human (`ctx.userQuestions` / command); one-shot token minted here, bound to `session + call fingerprint + exact command/args + expiry` |
| `RESUME_PENDING` | verdict (+ token, when applicable) staged; about to inject | — |
| `RUNNING` | verdict injected + driver woken; latch released | `agent.followup()`; `agent/status: running` |
| `FAILED` (terminal for one checkpoint) | any failure below; **no automatic resend**; for destructive checkpoints the latch **stays set** until explicit human resolution | agent stays paused (destructive) or resumes-with-notice (advisory) per §4.4 |

### 4.3 Capability: the one-shot retry token (destructive/high-risk only)

- **Minted exclusively in `AWAITING_PO_AUTHORIZATION` from explicit human (PO)
  authorization** — obtained through `ctx.userQuestions` (or a plugin command), never
  from the ChatGPT review, never by the model, never by the plugin on its own.
- Token contents (immutable, recorded): `{ sessionId, checkpointId, callId,
  fingerprint(args, cwd), exactCommand, mintedAt, expiresAt }`.
- Token use: the agent may re-issue **the exact denied call once** (same fingerprint)
  while the token is unexpired. Any modification to the call (different command,
  different args, different cwd) or an expired token → **denied again** (new
  checkpoint).
- Expiry default (config): 10 minutes from minting.
- The token is the **only** path past a destructive deny. There is no
  "review-approve ⇒ retry" path.
- Advisory checkpoints (NEW_BLOCKER, UNEXPECTED_STATE, REVIEW_REQUIRED) never mint
  tokens — the review verdict is injected as context and the agent resumes normally.

### 4.4 Transitions

1. `RUNNING → CHECKPOINT_PENDING`: classifier match at `tools/pre-execute`
   (deny + latch set), or `agent/pre-step` policy reject (REVIEW_REQUIRED), or
   error observed (NEW_BLOCKER/UNEXPECTED_STATE) — all set the latch. The pause is
   *at the next `agent/pre-step`* — never an in-flight blocking of a tool body.
2. `CHECKPOINT_PENDING → REVIEW_IN_FLIGHT`: evidence bundle assembled (bounded);
   `governloop_session.py checkpoint` invoked as a `ctx.jobs` background job.
3. `REVIEW_IN_FLIGHT → REVIEW_RECEIVED`: job settles with exit 0; response file
   exists; freshness check passes (§4.5); **envelope validates** (§3.4).
4. `REVIEW_RECEIVED → AWAITING_PO_AUTHORIZATION` (destructive/high-risk only):
   advisory verdict recorded; authorization request surfaced to the human; token
   minted on explicit human approval (§4.3). If the human **declines** → `FAILED`,
   latch stays set, denial stands.
5. `REVIEW_RECEIVED → RESUME_PENDING` (advisory checkpoints): verdict staged.
6. `RESUME_PENDING → RUNNING`: verdict injected (§5) + `agent.followup()` (new turn;
   the pause closed the previous turn at `agent/pre-step`), latch released.

### 4.5 Failure states (each terminal for the checkpoint — no auto-resend)

| Failure | Detection | Behavior |
|---|---|---|
| `EVIDENCE_INCOMPLETE` | candidate attachment refused by core (exit 1 `CHECKPOINT_DELIVERY_INCOMPLETE`), or bounded assembly failed | checkpoint recorded FAILED; **destructive: latch stays set** (denial stands); advisory: resume-with-notice; refusal text surfaced to the agent |
| `RELAY_FAILURE` | relay exit ≠ 0 (non-refusal) | same fail-closed handling; no retry without explicit instruction |
| `SEND_NOT_CONFIRMED` | `SEND_NOT_CONFIRMED` / `SEND_PENDING_TIMEOUT` from core | **never** re-click/re-send (core forbids); FAILED + manual-verification guidance surfaced to the human (via `agent.inject` + UI where present) |
| `REVIEW_TIMEOUT` | relay wait-timeout (default 900 s) | FAILED; **destructive: latch stays set, stays blocked** ("review did not complete; manual resolution required"); advisory: resume-with-notice |
| `UNKNOWN_REVIEW` / `AMBIGUOUS` | envelope missing/malformed/unknown/low-confidence (§3.4) | **destructive: stays blocked**, latch set, routed to manual human resolution; advisory: surfaced as unverified review, resume-with-notice |
| `PO_DECLINED` | human declines authorization in `AWAITING_PO_AUTHORIZATION` | destructive: FAILED, latch stays set, denial stands |
| `TOKEN_EXPIRED` | retry attempt after `expiresAt` | denied again (fresh checkpoint required) |
| `SESSION_CANCELLED` | `agent/cancel`, `turn/end {kind:'aborted'}`, `agent/disposed`, session disposed while in-flight | cancel/abandon the relay job (`job_kill`) when safe; clear the latch; never inject into a dead session; state discarded |
| `DUPLICATE_CHECKPOINT` | same checkpoint key (session + type + trigger fingerprint) already pending/in-flight | second trigger is **merged** into the current evidence (additive) or dropped with a log — one review per key at a time |
| `STALE_REVIEW` | response file older than checkpoint start, or a newer checkpoint superseded it | discard; do not inject |

### 4.6 Fail-closed resume policy (configurable per checkpoint type)

- **destructive action gate:** the latch stays set until (a) a one-shot token minted
  from explicit human authorization, or (b) explicit human resolution. The agent
  **never** self-unblocks; review PASS alone never unblocks.
- error/state checkpoints: resume-with-notice is allowed by default (the error is
  already in the transcript; the review adds context).
- `FINAL_VERIFICATION`: a FAILED delivery means the session end is **not** reported
  as verified.

### 4.7 Freshness and staleness

Every checkpoint records `triggeredAt` (monotonic clock) and a durable fingerprint.
`REVIEW_RECEIVED` requires `responseFile.mtime >= triggeredAt` **and** the response
file's path matches the session's response naming
(`governloop-response-<SESSION>-<TYPE>-<seq>.md` in `GOVERLOOP_STATE_DIR`).
A response that fails either check is stale → discarded, state FAILED.

### 4.8 One execution model per checkpoint (no alternation)

| Checkpoint | Execution model |
|---|---|
| `BEFORE_DESTRUCTIVE_ACTION` | **latch model** (deny + latch at pre-step + background review + PO authorization + one-shot token) |
| `NEW_BLOCKER` / `UNEXPECTED_STATE` | **latch model** (record + latch at pre-step + background review + advisory resume) |
| `REVIEW_REQUIRED` | **latch model** (pre-step policy sets latch + background review + advisory resume) |
| `FINAL_VERIFICATION` | **hold model** (serial `agent/turn-stopping` awaited; no background job, no latch) |

Status/turn ownership per model: in the **latch model**, the paused turn is closed by
the `agent/pre-step` reject (claimed messages are not retained; `turn/end` records the
close) and resumption is always a **new turn** via `agent.followup()`. In the **hold
model**, the open turn is suspended inside the serial boundary and either closes
(PASS) or is steered (issues) — the same turn semantics as a normal
`agent/turn-stopping` listener.

### 4.9 Concurrency and cancellation

- One in-flight checkpoint per session (per-agent key). A second trigger while
  `REVIEW_IN_FLIGHT` merges evidence or is dropped (§4.5 DUPLICATE).
- Cancellation paths: agent cancel → abandon relay job → clear latch → FAILED(state
  discarded); plugin unload (Cordis fiber dispose) → cancel job, clear latch, no
  injection.
- The relay job is owned by the agent's session (`ctx.jobs` owner isolation) so
  `job_kill` from the session is authorized.

### 4.10 Durability and restart (deferred to v1.1, designed now)

Checkpoint/review state is durable state, so a restart/resume must not auto-resend.
v1 keeps state in memory + log-only session events. v1.1 appends durable
`governloop/checkpoint` and `governloop/review` session events (extending
`SessionEventMap`, **marked `ignorable`** until the out-of-repo event registration
surface lands — §10 ADR-4) and a `ctx.sessionProjections` unit; `agent/session-start`
folds the last state and treats any `REVIEW_IN_FLIGHT` at crash as FAILED (no
auto-resend; a destructive latch at crash stays **latched** until human resolution —
fail closed on restart).

---

## 5. Review Injection Contract

### 5.1 Mechanism choice

| Mechanism | Wakes? | Use |
|---|---|---|
| `agent.inject(message)` | no | advisory notes, refusal/send-failure guidance — never the primary verdict carrier |
| `agent.steer(message)` | yes (next-step boundary) | only when resuming a **still-open** turn — with the latch model the paused turn is already closed, so steer is not the canonical wake; keep for FINAL_VERIFICATION "issues" follow-up inside the held turn |
| `agent.followup(message)` | yes (next turn) | **primary** verdict carrier for all latch-model checkpoints (BEFORE_DESTRUCTIVE_ACTION, NEW_BLOCKER, UNEXPECTED_STATE, REVIEW_REQUIRED) |
| `agent.whenIdle()` | no — observation | confirm the agent is paused before review; confirm resumption after injection |
| `agent.cancel(cause, {keepInbox})` | n/a | hard pause fallback (not default; loses step continuity) |

**Decision:** verdict injection uses **`agent.followup()`** for latch-model
checkpoints (the pause closed the turn) and `agent.steer()` only for the held-turn
FINAL_VERIFICATION path. `inject` alone is insufficient (the agent is idle and would
stay idle); `whenIdle` is not an injection mechanism. Rationale: followup/steer are
the documented wake primitives (`dsh-agent` README), the verdict must wake a paused
agent, and both produce durable `user/message` events on the session log.

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
      verdict: 'approve' | 'block' | 'advise'   // parsed from the envelope; advisory only
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
kind — no such kind exists; see §5.5). A token grant (`AWAITING_PO_AUTHORIZATION`
outcome) is **not** carried in this message kind: it is recorded separately
(`governloop/token` state) and the injected review message explicitly states that
approval alone grants nothing (§5.5).

### 5.3 Message framing

- Role: `user` (it enters the inbox like any queued input; the loop treats it as a
  user-role message — this is the only supported path for agent-visible content).
- Content: `[GovernLoop review — <checkpointId>]` + verdict line + the ChatGPT
  envelope text + the token grant notice (when one was minted: "a one-shot
  authorization token valid for <N> min for the exact denied call") + the fixed
  advisory footer (§5.5).
- Identity: one message per review, exactly one `MessageSource` (DSH requires one
  source per message).

### 5.4 Injection ordering and durability

1. Mint any token (destructive path) **before** injecting; the injected message
   references it; the latch is released only after the message is enqueued.
2. Inject **before** waking: `followup(msg)` enqueues + wakes in one call.
3. The injected message is a durable `user/message` event — replay-safe.
4. The `governloop/review` durable event (v1.1) records the verdict, response
   fingerprint, token (when minted), and the message id, so the transcript links
   review ↔ message ↔ capability.
5. The plugin never injects into a session it does not own (check `exec.agent` /
   session id on every path).

### 5.5 Advisory, not authority

Every injected verdict carries a fixed footer (text owned by GovernLoop core config):

> This review is advisory evidence. It does NOT authorize repository mutation,
> commit, push, PR, merge, deploy, release, or any other action. Follow the shared
> authorization boundary; only explicit user authorization grants action.

The plugin never sets approval policy, never changes sandbox mode, never calls
`ctx.agents.create/resume`, and never writes credentials — a review can inform the
agent, but cannot unlock anything by itself (§9 test 9). The **only** capability the
plugin can ever issue is the one-shot retry token, and that is minted exclusively
from explicit human (PO) authorization in `AWAITING_PO_AUTHORIZATION` (§4.3).

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
| Pause/resume adapter (latch at `agent/pre-step`, followup/steer) | ✅ | ❌ |
| Review read-back injection (provenance §5) | ✅ | ❌ (produces the response file only) |
| **Human (PO) authorization boundary** — who decides | ❌ **must not decide, only surface** | ✅ `AGENT_SAFETY_CONTRACT`: destructive/high-risk require fresh explicit human authorization; review PASS is not authority |
| **One-shot retry token mechanics** (binding/expiry; minted only from explicit human authorization) | ✅ mechanics only, no judgment | ✅ owns the rule that only explicit human authorization may mint it |
| Structured review envelope validation (block on unknown for destructive) | ✅ structural parsing | ❌ (review content is ChatGPT-side) |

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
checkpoint/evidence/relay/authorization semantics, and **no capability decision**:
the plugin surfaces human-authorization requests and implements token mechanics, but
never decides whether authorization is granted (that is the human's explicit act) and
never mints capability from a review.

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
  optionally `dshmarket` — both optional, after the plugin exists (ecosystem
  reconnaissance only; never architecture authority).
- Docs: README install guide + tested-DSH matrix + `AGENTS.md` boundaries.

### 7.5 Security posture

- Follow GovernLoop's supply-chain stance: pin versions, ship prebuilt artifacts,
  document `allowBuilds` guidance if git installs are offered, review before release.
- The plugin runs with full harness process privileges (DSH has no plugin
  isolation) — keep its surface minimal and its own secrets handling zero.
- The one-shot retry token (§4.3) is the plugin's only capability-issuing surface;
  it is in-memory, bound, expiring, and minted only from explicit human
  authorization — audit it (log-only event) on every mint and use.

---

## 8. Minimal Prototype Boundary

**First vertical slice — `BEFORE_DESTRUCTIVE_ACTION` on the `bash` tool for git
destructive patterns.**

```text
DSH tool action (git push --force)
→ tools/pre-execute classifier deny + latch set     ← runtime detection + hard gate
→ agent/pre-step rejects while latch set            ← pause (agent settles idle)
→ evidence bundle (command, parsed args, cwd, rule)
→ governloop_session.py checkpoint …                ← GovernLoop evidence + relay
→ independent ChatGPT review (structured envelope)
→ response file → envelope read-back
→ AWAITING_PO_AUTHORIZATION (human decides; token)  ← explicit human authorization
→ inject verdict + followup                         ← DSH resume (exact call retry once)
```

**Why this checkpoint first:**

1. Fully **runtime-detectable** — deterministic, no agent cooperation needed; the
   whole loop is testable end-to-end.
2. **Highest risk, highest value** — destructive git history operations are exactly
   what governance should catch.
3. **Fail-closed semantics are naturally testable** — default deny + latch is
   observable; review-alone-never-unblocks is assertable.
4. Exercises every layer of the architecture (gate, latch-pause, evidence, relay,
   envelope read-back, PO authorization, token, resume) with the smallest rule set
   (one category of §2.2).

**Slice scope (v1):**

- Classifier: `bash` only, git-destructive patterns + `rm -rf`-class (§2.2 first two
  rows); global `tools/pre-execute` listener; fail-closed deny; allow-list config
  shape only (empty by default).
- Pause: session-scoped latch; plain-context `agent/pre-step` reject while set.
- One checkpoint type wired (BEFORE_DESTRUCTIVE_ACTION); other mappings stubbed
  (documented, not implemented).
- Review: structured envelope (§3.4); unknown/malformed → blocked (latch held).
- Authorization: `AWAITING_PO_AUTHORIZATION` surfaced via `ctx.userQuestions` (human
  answers in the loop; stubbed in tests); one-shot retry token (§4.3) minted only on
  human approval; expiry 10 min.
- Evidence: command + parsed args + cwd + matched rule + last 5 events.
- In-memory state + log-only session events; no durable `governloop/*` events yet.
- Relay invoked via `governloop_session.py`; tests use the stub (§9).
- No slash commands, no UI, no projections, no Typert wiring.

**Success criteria:** a headless DSH session whose task issues `git push --force`
gets denied, latched, receives a ChatGPT review envelope (stubbed in tests), stays
blocked on review-approve alone, resumes only after explicit human authorization
mints the one-shot token, and the exact call may then run once; a clean task never
triggers the checkpoint; every failure path in §4.5 is covered by a test.

---

## 9. Headless Test Plan (stub relay + stub human authorization, no real ChatGPT)

### 9.1 Harness

- A test DSH profile (headless) mounting the plugin + a **stub relay**: a fake
  `governloop_session.py`/`neutral_relay.py` that (a) validates the invocation
  contract (argv, env, exit codes), (b) writes a canned envelope response file, and
  (c) records every invocation for assertions. Driven via
  `dsh --profile <test-profile> "<task>"` with a scratch workspace and
  `GOVERLOOP_RELAY_PATH`/`GOVERLOOP_STATE_DIR` pointing at the stub.
- Human authorization is stubbed through a controllable `ctx.userQuestions` answerer
  (approve / decline / no-answer) so the PO step is testable headless.

### 9.2 Test matrix

| # | Scenario | Assertion |
|---|---|---|
| 1 | Task calls `git push --force` | `tools/pre-execute` returns `deny`; tool body never runs; checkpoint recorded exactly once; **latch set** |
| 2 | **Pause via latch** | while the latch is set, the next `agent/pre-step` returns `reject`; no further steps execute before the checkpoint settles; `agent/status` reaches `idle` (`whenIdle`) |
| 3 | Evidence extraction | checkpoint message contains command/args/cwd/rule; attachment candidates bounded (≤ caps); no whole-log dump |
| 4 | Relay invocation contract | stub asserts exact subcommand `checkpoint BEFORE_DESTRUCTIVE_ACTION`, `--message`, `--attach` paths, env passthrough; exit codes 0/1/3 honored |
| 5 | Review read-back + envelope | stub writes envelope response file → plugin validates freshness + envelope; malformed/unknown envelope → **stays blocked** (latch held), routed to manual resolution |
| 6 | **Review-approve alone does NOT unblock** | envelope `APPROVE` received → state goes to `AWAITING_PO_AUTHORIZATION`; **no token minted, no retry, latch held** |
| 7 | PO authorization mints the one-shot token | human approves → token minted (session+call fingerprint+exact command/args+expiry recorded); verdict injected with `kind:'governloop-review'` + advisory footer; agent wakes and the exact call runs once |
| 8 | PO decline stays blocked | human declines → FAILED; latch held; denial stands; no further attempts allowed |
| 9 | **No accidental lifecycle / capability authority** | assert the plugin never: calls `ctx.agents.create/resume`, registers tools beyond its own, mutates `sandbox/mode` or `approval/policy`, writes credentials, changes session persistence; review text does not unlock any policy; **no token is ever minted from a review** |
| 10 | Token binding and expiry | retry with modified args (different fingerprint) → denied (new checkpoint); retry after `expiresAt` → denied (new checkpoint); retry of the exact call within expiry → allowed exactly once, second use denied |
| 11 | Fail-closed (relay failure) | stub exits 1 → `CHECKPOINT_DELIVERY_INCOMPLETE` handling; **no second invocation** (stub call count == 1); latch stays set |
| 12 | Fail-closed (send not confirmed) | stub returns SEND_PENDING_TIMEOUT semantics → no auto-resend (call count == 1); manual-verification guidance injected |
| 13 | Review timeout | stub hangs past timeout → FAILED; **latch stays set (blocked)**, manual resolution required |
| 14 | Duplicate checkpoint | two identical destructive calls in one turn → one checkpoint (merged/dropped), one relay invocation |
| 15 | Stale review | response file with mtime < checkpoint start → discarded, not injected |
| 16 | Session cancelled mid-review | `agent.cancel` during `REVIEW_IN_FLIGHT` → relay job killed, latch cleared, no injection, no crash |
| 17 | FINAL_VERIFICATION hold model (v1.1 stub) | declared completion holds at `agent/turn-stopping` (serial, awaited) until the checkpoint settles; **no background job**; PASS closes the turn, issues → steer |
| 18 | Plugin failure containment | a throwing listener does not break the loop (DSH: "plugin failure ends the current turn, not the loop"); the latch is not left stuck after plugin failure (fail-closed → agent informed) |

### 9.3 Environment/invariants

- Stub state dir is per-test and wiped; canonical `~/.governloop` config untouched
  (assert).
- Tests run read-only against the workspace (workspace-write sandbox with a scratch
  workspace).
- An invariant check asserts the plugin never writes outside its own row config.
- A capability audit invariant asserts every token mint and use is recorded and that
  tokens are bound/expiring (no bare "approve everything" state).

---

## 10. Open Questions / ADR Candidates

| # | Decision | Candidates | Recommended default |
|---|---|---|---|
| ADR-1 | Tool-gate semantics | (a) deny + latch + background review + PO-authorization token (this doc); (b) `approval/request` answerer (cannot express "pending"; one terminal answerer per deployment; competes with ACP bridge) | **(a)** — review never mints capability; revisit (b) only if a machine answerer becomes core-owned |
| ADR-2 | Pause primitive | `agent/pre-step` reject via session-scoped latch (this doc) vs turn-stopping hold vs awaiting review inside the tool gate | latch at pre-step; verify empirically that a reject stops all further steps (§10 open Q1) |
| ADR-3 | One execution model per checkpoint | enforced per §4.8 | latch model for tool/step checkpoints; hold model for FINAL_VERIFICATION only |
| ADR-4 | Durable `governloop/*` session events | now (`ignorable`) vs v1.1 | v1.1 (persistence read path refuses unknown non-`ignorable` types; out-of-repo registration surface deferred) |
| ADR-5 | Checkpoint dedupe/cooldown | per-key single-flight (§4.9) vs cooldown timer | single-flight + merge; cooldown later |
| ADR-6 | `approval/request` answerer | never answer in v1 | never (avoid the terminal-answerer conflict) |
| ADR-7 | Headless vs web first | headless-first (no UI dependency) vs web (UI affordances) | headless-first (§8) |
| ADR-8 | Classifier config surface | tiny rule config + allow list vs generic policy language | tiny config; no generic engine (§2.4) |
| ADR-9 | Distribution identity | `governloop-dsh` unscoped vs `@governloop/dsh-plugin` vs GitHub-only | npm package (prebuilt lib) + GitHub; scope decided with user |
| ADR-10 | Session mapping | 1 GovernLoop session ↔ 1 DSH session vs per-task across resumes | 1:1 per DSH session; document task mapping in the checkpoint message |
| ADR-11 | Evidence default confidentiality | per-checkpoint defaults (§3.2) vs conservative all-text-only | §3.2 defaults + core validation as the safety layer |
| ADR-12 | Review answer format | structured envelope (§3.4) vs free-form natural language | structured envelope; unknown/malformed → blocked for destructive |
| ADR-13 | PO authorization surface | `ctx.userQuestions` (in-loop) vs plugin command vs `approval/request` | `ctx.userQuestions` for v1 (stubbable headless); command/UI later |
| ADR-14 | One-shot retry token design | bound token (session+call fingerprint+exact args+expiry) vs bare approve-flag | bound, expiring token (§4.3); audit every mint/use |
| ADR-15 | Steer vs followup after latch | followup (new turn; latch closed the turn) vs steer (same turn) | followup for latch model; steer only for held-turn FINAL_VERIFICATION |

**Open questions to verify in DSH source before implementation:**

1. Does a `agent/pre-step` `reject` reliably stop **all** further model steps until
   the latch clears (no other admission path — e.g. steering/inject wake) — verify
   empirically in a headless harness?
2. Does a global `tools/pre-execute` listener observe delegated subagent children's
   tool calls (scope filtering: unscoped listeners are global — verify empirically)?
3. `ctx.jobs` completion delivery (`wakeup` vs `quiet`) for the relay wait — quiet is
   preferred (no model wake on job end; the verdict injection wakes).
4. `MessageSource` declaration-merge path for an out-of-repo package (module
   augmentation against `@deepseek-ai/dsh-llm`).
5. Behavior of `agent.followup` on an agent in `idle` with pending injected content
   (ordering of queue vs injected context at the step boundary).
6. Exact parsed-`arguments` shape for `bash` under `defineTool` (command field
   validation/narrowing) — the classifier's primary input.
7. `agent/turn-stopping` serial-hold semantics: what happens to the turn if a
   listener returns a rejected promise or never settles (timeout bounds) before
   relying on the hold model for FINAL_VERIFICATION.

---

## Appendix A — Verified DSH facts this design depends on

| Claim | Verification |
|---|---|
| `tools/pre-execute` waterfall with `PreToolDecision = allow \| deny \| ask`; cannot rewrite args | `dsh-tools` README + `lib/types/index.d.ts` (AGE-60 §2.2) |
| **`ToolExecutionInput.arguments: unknown` — parsed, deep-frozen arguments; raw model string is NOT at the gate** | `dsh-tools/lib/types/index.d.ts` @ 0.1.1-rc.2: `readonly arguments: unknown` ("Losslessly JSON-serializable parsed arguments"); "Parsed arguments cross one lossless-JSON materialization boundary **before policy**"; upstream `docs/subsystems/tools.md` ("materializes its parsed JSON arguments once") |
| **Raw model argument string belongs to the durable `tool/call` record** | `dsh-llm/lib/types/types.d.ts` — `ToolCallBlock.arguments: string` ("Raw JSON string as produced by the model") |
| **`tools/pre-execute` deny is not a pause** — deny skips the body and flows through post/finalize/result into durable `tool/result`; the loop can continue | `docs/tool-execution-pipeline.md` (denied → post → result) + `dsh-tools` README |
| `ctx.tools.guard()` monotonic after pre-execute | `dsh-tools` README |
| `agent/pre-step` waterfall; `reject` closes the turn without a step (claimed messages not retained) | `dsh-agent`/`dsh-agent-loop` READMEs + `runtime-types.d.ts` |
| `agent/turn-stopping` serial, awaited; steering re-reads inbox | `runtime-types.d.ts` |
| `agent/session-start` source vocabulary = `startup \| resume \| clear \| compact` | `dsh-agent/lib/types/runtime-types.d.ts` + upstream `docs/subsystems/core.md` |
| `agent.followup/steer/inject/whenIdle/cancel` semantics | `dsh-agent` README |
| `MessageSourceMap` is merge-extensible; kinds user/plugin/model/tool | `dsh-llm/lib/types/message.d.ts` ("Merge-extensible sum type — plugins add their own `kind`s") |
| Session log is append-only source of truth; `user/message` durable; `SessionEventMap` merge-extensible; unknown non-`ignorable` types refuse reconstruction | `dsh-session` README + `types.d.ts` + `KNOWN_SESSION_EVENT_TYPES` |
| DSH "checkpoint" = durability barrier (different meaning) | `dsh-session-checkpoint-policy` README |
| GovernLoop checkpoint types + delivery contract (TEXT_RELAY PASS AND ATTACHMENTS PASS; no auto-resend; exit codes) | GovernLoop `neutral-relay-checkpoint-delivery.md`, `governloop_session.py` |
| GovernLoop authorization boundary (review ≠ authority; destructive/high-risk require fresh explicit user authorization) | GovernLoop `AGENT_SAFETY_CONTRACT.md` |
| DSH plugin install model: `dsh plugin --profile … add <pkg>`; `dsh.bundle.patch`; profile `cordis.patch.yml`; developer preview | `dsh`/`dsh-app-boot` READMEs + upstream `docs/user/develop/basic/publish.md` |

## Appendix B — References

- AGE-60 research: `docs/research/AGE-60-dsh-plugin-research.md` (this branch's parent lineage, incl. review-correction commit)
- DSH upstream docs (branch `master`): `docs/architecture.md`, `docs/subsystems/{core,tools,approval,session,subagent,workflow,goal,sandbox}.md`, `docs/tool-execution-pipeline.md`, `docs/user/develop/*`
- GovernLoop core: `repos/GovernLoop` — `docs/ops/AGENT_SAFETY_CONTRACT.md`, `docs/architecture/neutral-relay-checkpoint-delivery.md`, `skills/workbuddy/governloop/scripts/governloop_session.py`, `tools/neutral-relay/neutral_relay.py`
