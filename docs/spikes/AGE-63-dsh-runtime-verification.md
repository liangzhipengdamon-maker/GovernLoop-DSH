# AGE-63 — DSH Runtime Verification (pre-implementation gate)

**Status:** verification spike complete — **all scenarios PASS**; results feed the
AGE-63 minimal plugin prototype (which is the next implementation issue; **AGE-62 is
the LearnMind-English real pilot and is untouched**).
**Date:** 2026-08-23
**Target:** `@deepseek-ai/dsh@0.1.1-rc.2` (npm, the pinned dev baseline)
**Method:** fully **keyless** — a throwaway probe plugin (`spike/runtime-verification/`)
drives the runtime directly (mock LLM adapter as a fail-loud net, `ctx.tools.execute`,
`ctx.agents.create`, `ctx.jobs`, `ctx.userQuestions`) inside a scratch DSH_HOME, so no
real model call, no credentials, and no user DSH-home state are touched.
**Artifacts:** `spike/runtime-verification/probe.js` (probe), `run.sh` (headless runner
with `--patch` overlay), `findings-2026-08-23.jsonl` (raw JSONL evidence).

This spike answers the AGE-61 §10 pre-implementation open questions for the
`BEFORE_DESTRUCTIVE_ACTION` vertical slice.

---

## 1. Results summary

| # | Hypothesis (AGE-61 open question) | Result | Evidence (findings id) |
|---|---|---|---|
| S1 | `agent/pre-step` `reject` + session latch blocks all further steps (the pause primitive); `agent.followup` from idle resumes into a new rejected turn | **PASS** | `S1-latch-blocked-step`, `S1-summary` |
| S2 | `tools/pre-execute` receives **parsed, deep-frozen** arguments (`unknown`), not the raw wire string; `arguments.command` is available for `bash` | **PASS** | `S2-summary` |
| S3 | `deny` skips the tool body; `allow` runs it; live `tools/result` fires for both | **PASS** | `S3-bash-deny`, `S3-probe-deny`, `S3-probe-allow`, `S3-summary` |
| S4 | a **global** `tools/pre-execute` listener observes a child (subagent) agent's calls; a child-scoped listener does not observe parent-context calls | **PASS** | `S4-scope` |
| S5 | `ctx.jobs` settlement does not implicitly wake the agent (delivery is the consumer's choice) | **PASS** | `S5-job` |
| S6 | `ctx.userQuestions.ask()` in headless: no provider → `NO_PROVIDER` (throws, does not hang); a plugin-registered provider answers | **PASS** | `S6-no-provider`, `S6-with-provider` |
| S7 | zero model calls happen during the whole run (mock adapter never invoked) | **PASS** | `S7-summary` |

---

## 2. Findings per scenario

### S1 — pause primitive: pre-step reject + latch (PASS)

- Turn 1: first `agent/pre-step` → probe ran the scenario, set the latch, returned
  `{kind:'reject'}` → **no step started**, turn closed.
- Turn 2 (resume path): when the agent reached `idle`, the probe issued
  `agent.followup(...)` (the design's verdict-injection wake) → a **new turn** opened
  → `agent/pre-step` (turn 2, step 1) → latch → rejected again
  (`S1-latch-blocked-step {"turn":2,"step":1}`).
- Totals: `turnsSeen: 2`, **`stepsSeen: 0`**, **`assistantMessages: 0`**,
  `turnEndReasons: [{"kind":"blocked"}]` — a rejected turn durably ends with
  `{kind:'blocked'}` (not `aborted`/`error`).
- **Design impact:** the latch-at-`agent/pre-step` pause (AGE-61 Rev 2 §4.1) works;
  the resume path (idle → `followup` → new turn) works. **Caveat observed:** in an
  earlier variant, a `followup` issued *during* the pre-step waterfall (agent still
  `running`) did not produce a second turn before the run ended; the idle-issued
  `followup` did. Recommendation: **wake only from quiescence** (`agent.whenIdle` →
  `followup`), which is exactly what AGE-61 §5.1/§4.4 specify — do not wake from
  inside a pre-step/tool-gate handler.

### S2 — gate input contract: parsed, deep-frozen arguments (PASS)

- All 5 executions observed at `tools/pre-execute` (real `bash` + `probe_tool`):
  `argumentsType: "object"`, `isObject: true`, **`frozen: true`**,
  `command` extracted (`git push --force`, `ok`, `child`, `parent`).
- **Confirms AGE-61 Rev 2 §2.1:** the classifier receives the registry-materialized,
  deep-frozen parsed arguments object (`ToolExecutionInput.arguments: unknown`), not
  the raw wire string. The raw string is only in the durable `tool/call` record.
- For `bash`, the parsed object exposes `arguments.command` — the classifier's
  primary input is available exactly as designed.

### S3 — deny/allow pipeline (PASS)

- Real `bash` call with `git push --force`: denied → `isError: true`, body never ran.
- `probe_tool` denied → `isError: true`, `bodyRan: 0`; allowed → `isError: false`,
  value `"ran:ok"`, `bodyRan: 1`.
- Live `tools/result` fired for all 5 direct executions (`liveToolResults: 5`);
  durable `tool/result` appended **0** times — these were **agentless direct
  `ctx.tools.execute` calls**, and the durable append is **loop-owned** (the agent
  loop appends `tool/result` after `tools/result`). In-loop calls (including denied
  ones, per the tool-execution-pipeline doc) do produce the durable record.
- **Design impact:** evidence taps must listen to live `tools/result` **and**
  durable `session/event` (`tool/result`); the classifier's own gate runs in-loop so
  denied calls will have durable records in real sessions.

### S4 — global interception across agent scopes (PASS)

- Child agent created via `ctx.agents.create({sessionId:'probe-child-1', ...})`.
- A call executed **under the child agent** was seen by the **global**
  `tools/pre-execute` listener (`globalSawChild: true`) **and** by the
  child-scoped listener (`childScopedForChild: 1`).
- A parent-context call was **not** seen by the child-scoped listener
  (`childScopedForParentCall: 0`).
- **Design impact:** a plain-context (global) `tools/pre-execute` classifier covers
  subagent children's tool calls (AGE-61 open Q2 answered); per-agent scoping works
  for finer-grained policy later.

### S5 — jobs seam is inert (PASS)

- A `ctx.jobs` job settled (`status: "completed"`) while the agent was idle;
  `agentWokeDuringJob: false` — no implicit wake, no status flip.
- **Design impact:** the relay wait can use `ctx.jobs.wait()` / `onJobDone` for the
  outcome and the plugin controls waking explicitly via `followup` (AGE-61 §4.2,
  open Q3 answered). `completionDelivery: quiet` semantics belong to the consuming
  tool layer, not the seam.

### S6 — userQuestions headless (PASS — with an important design consequence)

- `ctx.userQuestions.ask()` **without a provider → `NO_PROVIDER`** (thrown, does not
  hang) — headless has no UI provider ("the Web host runtime supplies the shipped
  Service Provider").
- A **plugin-registered provider** answered the same ask
  (`{"answers":[{"id":"q1","selected":["approve"]}]}`).
- **Design impact (refines AGE-61 ADR-13):** the `AWAITING_PO_AUTHORIZATION` surface
  in headless **requires the plugin to register its own `userQuestions` provider**
  (e.g. a file/CLI/approval-file based provider, or the ACP bridge). Constraint:
  **one provider per context** — a second registration throws `DUPLICATE_PROVIDER` —
  so the plugin must register only when none is active (try/catch or a capability
  check), and in web deployments let the Web provider serve instead. The user's
  second-round review note ("ask() waits for the human") is confirmed for the
  provider-present case; headless needs the plugin provider.

### S7 — keyless guarantee (PASS)

- `mockStreamCalls: 0` — the fail-loud mock adapter was never invoked; no
  `step/start`, no `assistant/message`. The whole verification ran without a model
  call, so results are deterministic and credential-free.

---

## 3. Open questions still requiring runtime/real-agent confirmation

These need a **real (keyed) run** or a real agent loop and are therefore deferred to
the AGE-63 implementation tests (AGE-61 §9 harness, which can run with a real key or
the stub relay):

1. **"Loop continues after deny unless latched"** (the reviewer's race) — with a real
   model, after a denied call the model may emit the next tool call; the latch at
   `agent/pre-step` is the mitigation. The pipeline-order half is verified (deny →
   live `tools/result`; durable append loop-owned); the loop-continuation half needs
   a keyed run in the §9 harness (test 1/2 of the plan).
2. **`agent/turn-stopping` serial-hold** for FINAL_VERIFICATION — needs a real
   declared-completion flow; the serial/awaited semantics are documented, empirical
   hold-without-timeout behavior still to be exercised in the §9 harness (test 17).
3. `ctx.jobs` **quiet vs wakeup notice delivery** through the `tool-jobs` layer (the
   seam inertness is verified; the consumer-layer delivery lane is tool-jobs config).
4. `MessageSource` module augmentation from an out-of-repo package (compile-time
   concern; type-level verified, runtime compile step is an implementation detail).

---

## 4. Delivered conclusions for AGE-63 prototype

- **Pause:** latch at `agent/pre-step` + wake-from-idle `followup` — verified.
- **Classifier input:** parsed deep-frozen `arguments` object with `command` — verified.
- **Subagent coverage:** global `tools/pre-execute` listener sees children — verified.
- **Relay wait:** `ctx.jobs` for the outcome + explicit `followup` wake — verified.
- **PO authorization:** plugin-registered `userQuestions` provider required for
  headless (`NO_PROVIDER` otherwise); register only when no provider is active.
- **Evidence:** live `tools/result` + durable `session/event` (`tool/result`); direct
  agentless executes do not append durable records (loop-owned) — in-loop capture is
  the contract for real sessions.

The AGE-61 architecture contract (Rev 2) stands with one refinement: **ADR-13 default
changes from "userQuestions" to "userQuestions with a plugin-supplied provider in
headless (register only when absent)"**.

## 5. Repro

```bash
bash spike/runtime-verification/run.sh
# scratch DSH_HOME under /tmp/dsh-verify-<ts>; findings at $SCRATCH/findings.jsonl
# pinned baseline: DSH_BIN=/Users/Zhuanz/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh
```
