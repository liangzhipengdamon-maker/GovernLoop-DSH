# AGE-65 — DSH native approval vs GovernLoop token/latch (third slice)

**Status:** research/verification — keyless, source-level + minimal runtime probe; no implementation, no runtime modification
**Date:** 2026-08-24
**Target:** `@deepseek-ai/dsh@0.1.1-rc.2` (baseline `origin/main @ 1c6b650`)
**Method:** (1) source inspection of the native approval seam (`dsh-user-approval`,
`dsh-tools` `tools/pre-execute`→`serviceAsk`, `dsh-user-questions`, session audit
events) against the GovernLoop one-shot retry token (`governloop-dsh/lib/token.js`,
AGE-61 §4.3 / AGE-64 §7); (2) minimal keyless runtime probe
(`spike/age-65-slice3-approval/`): mock adapter, scratch DSH_HOME, a trivial
`probe-echo` tool gated by `{kind:'ask'}`, and an `approval/request` answerer that
answers call1→`allowed-once`, call2→`allowed-once`, call3→throw.
**Evidence:** `spike/age-65-slice3-approval/findings-2026-08-24.jsonl` (records A1–A3, B, C, D).

**Verdict: `PARTIAL`** — DSH native approval satisfies all five hard-gate
conditions (so a `REPLACE` verdict is *eligible*), but it differs from the
GovernLoop token on two semantics — **no content-level (command/args)
binding** and **no expiry** — and — the decisive difference — **it cannot
express "PO once, retry the same command without re-PO"** (every retry is a
new ask = new PO). GovernLoop token is therefore **not deleted**; dropping it
would require a separate PO decision accepting the retry-semantics change.

---

## 1. The two artifacts being compared

**GovernLoop token** (`governloop-dsh/lib/token.js`): minted **after** explicit
human PO (never from a ChatGPT review). Fields: `sessionId`, `checkpointId`,
`callId` (audit only), `fingerprint = JSON.stringify([cwd, name, args])`,
`exactCommand`, `mintedAt`, `expiresAt` (ttlMs), `used:false`.
`checkToken` denies on: no-token / wrong-session / expired / already-used /
fingerprint-mismatch / command-mismatch. `consumeToken` marks one-shot.

**DSH native approval** (`dsh-user-approval`): `ctx.approval.request(req)` where
`req = { agent, toolName, callId?, reason?, signal? }`; outcome vocabulary
`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`; audit pair
`approval/asked` + `approval/decided` appended to the requesting session's log;
policy per-session (`'ask' | 'never'`).

## 2. Six-axis comparison (source evidence)

| Axis | GovernLoop token | DSH native approval | Evidence |
|---|---|---|---|
| 1. exact action/command binding | **content-level**: `fingerprint(cwd,name,args)` + `exactCommand` | **call-instance-level**: `toolName` + `callId`; **no arguments in the request** | `ApprovalRequest` type: "arguments are not duplicated here"; probe `argsInRequest:false` (A1–A3) |
| 2. one-shot | `used` flag, second use denied | `'allowed-once'` is the only grant; one fresh `ApprovalRequestId` (UUID) per ask, consumed once by the asking call | `types.d.ts` L23; impl `randomUUID()` per request; probe B (3 asks / 3 decided, distinct ids) |
| 3. not reusable across session / params | wrong-session / fingerprint-mismatch deny | grant consumed in the asking agent's pipeline; **any later call re-asks (fresh UUID + new PO)** — same tool, same args still re-ask | probe: c1 `allowed-once` did **not** carry to c2 (c2 asked and was allowed again) |
| 4. expiry | `expiresAt`, expired denies | **no TTL concept anywhere** in the approval seam | full `dsh-user-approval` source scan |
| 5. PO timing | minted after explicit PO; consumed at retry | ask happens in `tools/pre-execute` **before execution**; per attempt | `dsh-tools` `serviceAsk` (pre-execute waterfall → ask → allow/deny) |
| 6. audit persistence | token fields + checkpoint records | durable `approval/asked`/`approval/decided` session events, turn-enclosed, replayable | probe B (live) + C (reload after turn close: 3+3 pairs intact) |
| — fail-closed | no-token/already-used/mismatch/expired → deny | missing/throwing answerer → `'unavailable'`; policy `'never'` → `'rejected'`; rogue outcome normalized to `'unavailable'`; all non-grants map to deny | impl `decide()`; probe D (throw → `unavailable` → deny, `resultIsError:true`) |

## 3. Hard-gate verdict (per issue directive)

> Only judge `REPLACE` if DSH native approval simultaneously proves: binds the
> specific execution call + single-use + not reusable across session/params +
> replay-still-auditable + no-answer fail-closed.

| Gate condition | Result | Evidence |
|---|---|---|
| binds the specific execution call | **PASS** (call-instance binding via `callId` + `toolName`; "grants apply only to the requested action") | source + probe A1–A3 |
| single-use | **PASS** | probe B (fresh UUID per ask; `allowed-once` consumed once) |
| not reusable across session/params | **PASS** (any later call re-asks; a grant never carries over) | probe: c1→c2 independence |
| replay-still-auditable | **PASS** | probe C (`pairIntact:true` after persistence reload) |
| no-answer fail-closed | **PASS** | probe D + source |

All five pass ⇒ **a `REPLACE` verdict is eligible** under the directive's terms.

## 4. Why the verdict is `PARTIAL`, not `REPLACE`

The directive also states: *if only non-core semantics like `expiry` are missing
→ `PARTIAL`; if exact-call binding is missing or a grant can be reused by later
calls → do not delete the GovernLoop token.*

- **Not `NOT_REPLACE`**: DSH does have exact-**call** binding (instance-level),
  and reuse by later calls is empirically impossible (probe). The
  "cannot-delete" triggers are not met.
- **Not plain `REPLACE`** for two reasons:
  1. **No content-level binding.** The approval decision records `toolName` +
     `callId` + `reason` but **no arguments/command**. Auditing "what exactly was
     allowed" requires correlating `callId` → the separate `tool/call` event
     (which carries the arguments). The GovernLoop token carries
     `fingerprint` + `exactCommand` itself.
  2. **No expiry** (non-core on its own, but real: DSH grants are never time-bound).
- **Decisive semantic difference (needs a PO decision, not a code change):**
  the token exists to grant **"PO once, retry the exact same command once"**
  (retry-after-transient-failure without re-asking). DSH approval **cannot
  express that**: a retry is a new call → a new ask → a **new PO**. DSH is
  strictly *narrower* (safer), not weaker — but it changes the product
  semantics GovernLoop's retry token was designed for.

## 5. Runtime probe evidence (keyless)

| Record | Meaning |
|---|---|
| A1–A3 `A-ask-received` | 3 independent `approval/request` calls (callIds s3-call-1/2/3), each with `argsInRequest:false`, `hasSignal:true`, `hasAgent:true` |
| B `B-audit-live` | 3 `approval/asked` + 3 `approval/decided`, all ids distinct, correct pairing; c1/c2 `allowed-once`, c3 `unavailable` |
| C `C-audit-replay` | after the turn closes, persistence reload shows 3+3 pairs intact (`pairIntact:true`) — replay keeps the audit. (Mid-turn load is refused by the "live turn open" guard — itself a durability guarantee) |
| D `D-c3-failclosed` | answerer throw normalized to `unavailable` → call denied (`resultIsError:true`, "no approval channel is available") |

## 6. Implications for GovernLoop

- **Keep the GovernLoop token.** The verification does not authorize deleting
  `governloop-dsh/lib/token.js`; removing it would require a separate PO
  decision accepting: retry = re-PO, audit without content-level binding, no
  expiry.
- **DSH native approval is the single native pre-execution authorization
  channel** and is fully adequate for the *execution-gate* role (per-call,
  one-shot, fail-closed, auditable). It complements, not duplicates, the token's
  *retry-grant* role.
- Supports the boundary register (G7): GovernLoop provides **rules** (checkpoint
  semantics, retry-grant policy), DSH provides the **mechanism**
  (`ctx.approval`); the two are not the same layer.
- Research only: no runtime/plugin code was modified; no alternative was
  implemented.

## Repro

```bash
DSH_BIN=<pinned dsh binary> bash spike/age-65-slice3-approval/run.sh
# findings at <scratch>/findings.jsonl; DSH pinned 0.1.1-rc.2
```

---

## Final report

- **Six-axis comparison:** binding (instance-level vs content-level), one-shot
  (both), non-reuse (both), expiry (token only), PO timing (both pre-execution;
  token supports retry-without-re-PO, approval does not), audit persistence
  (both), fail-closed (both)
- **Hard gate:** all five conditions PASS on DSH native approval (source +
  keyless runtime evidence)
- **Verdict:** PARTIAL — REPLACE eligible, but content-level binding and
  retry-without-re-PO semantics are missing; token retained
- **GovernLoop impact:** token not deleted; PO decision required for any change;
  DSH `ctx.approval` remains the native pre-execution gate

STATUS: RESEARCH_VERIFICATION_COMPLETE
ARCHITECTURE_ADOPTION: NOT_AUTHORIZED
VERDICT: PARTIAL

Related architecture boundary: see `docs/research/DSH-native-capability-boundary.md` for the Native-Gap Proof Gate. This Slice does not adopt or implement that policy.
