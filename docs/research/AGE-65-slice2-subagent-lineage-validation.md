# AGE-65 — Real Subagent Delegation Identity / Lineage Validation (second slice)

**Status:** research/verification spike complete — keyless, no runtime modification
**Date:** 2026-08-24
**Target:** `@deepseek-ai/dsh@0.1.1-rc.2` (verified baseline: `origin/main @ 1c6b650`)
**Method:** keyless headless probe (`spike/age-65-slice2/`): mock LLM adapter
(provider `mock`, deterministic scripted output), scratch DSH_HOME, zero model
calls, zero credentials. The probe runs inside the root agent's first
`agent/pre-step` (root principal `P`), then rejects that step so `P` itself
never makes a model call; every child/grandchild runs through the **real**
subagent pipeline (`ctx.subagents.start` one-shot spawn for the child; the real
model-facing `subagent` tool — `dsh-tool-subagent`, `backgroundMode:
continuable`, provider `spawn` — for the grandchild).
**Evidence:** `spike/age-65-slice2/findings-plain.jsonl` (single level) and
`spike/age-65-slice2/findings-nested.jsonl` (root→child→grandchild).

Completes the AGE-65 follow-up flagged by Slice 1 (S5: "delegationDepth monotone
check … needs a real delegated child / scripted model").

---

## Issue mapping (Slice 2 directive)

| # | Directive question | Answer (summary) |
|---|---|---|
| Q1 | Does a real delegated child get a **distinct child SessionId**? | Yes — new system-minted id, `agent.id === session.id` |
| Q2 | Is `parentSession` **live and persisted** on the child? | Yes — identical in the live header and the reloaded persisted header |
| Q3 | Is `delegationDepth` **root / child / grandchild** monotone? | Yes — root absent (0) → child 1 → grandchild 2 |
| Q4 | How do **fork vs spawn** differ in lineage metadata? | Fork: `parentSession` + `seedLength`, no `delegationDepth`. Spawn: `parentSession` + `delegationDepth`, no `seedLength`, `origin:'subagent'` |
| Q5 | Does **child resume** keep the same identity and lineage? | Yes — same SessionId; persisted `parentSession`/`delegationDepth` preserved |
| Q6 | Does **nested root→child→grandchild** delegation persist with correct lineage? | Yes — grandchild `parentSession=child`, depth 2, completed turn persisted |

---

## Results — required output table

Classifications: **VERIFIED** / **PARTIALLY_VERIFIED** / **NOT_VERIFIED** / **CONTRADICTED**

| Q | Hypothesis | Classification | Evidence (record id in `findings-*.jsonl`) |
|---|---|---|---|
| Q1 | Delegated child gets a distinct system-minted `SessionId`; `agent.id === session.id` | **VERIFIED** | `Q1-child-created` — `childSessionId` ≠ `P.session.id` (`distinctFromParent:true`), `childAgentIdEqualsSession:true`; `Q1-child-settled` — child ran a real turn (`stopReason:'completed'`, output `child-done`) |
| Q2 | `parentSession` is present **live and persisted** on the delegated child | **VERIFIED** | `Q2-child-live-header` — `parentSession:<P>`, `delegationDepth:1`; `Q2-child-persisted-header` — identical values after `persistence.load(childId)`, `eventCount:22` (plain) / 32 (nested) |
| Q3 | `delegationDepth` is monotone across root / child / grandchild | **VERIFIED** | `P-root` — `delegationDepth:null` (root = 0); `Q2-child-live-header` / `Q2-child-persisted-header` — 1; `Q6-grandchild` — 2 |
| Q4 | Fork and spawn produce **distinguishable, non-overlapping** lineage metadata | **VERIFIED** | `Q4-session-fork` — `forkId:'session-2'`, `parentSession:'session-1'`, `seedLength:7`, `delegationDepth:null`; child spawn records — `parentSession:<P>`, `delegationDepth:1`, **no `seedLength`**, persisted `origin:'subagent'` |
| Q5 | Resuming a persisted child keeps the **same SessionId** and the **persisted lineage** | **VERIFIED** | `Q5-child-resume` — `sameSessionId:true`, `parentSession:<P>`, `delegationDepth:1`, `agentIdEqualsSession:true` |
| Q6 | Nested root→child→grandchild persists with correct lineage and completes | **VERIFIED** | `Q6-grandchild` — `grandchildSessionId` ≠ child ≠ root (`distinctFromAll:true`), `parentSession:<child>`, `delegationDepth:2`, descriptor `{version:2, mode:'continuable', provider:'spawn', label:'delegate grandchild'}`, `settledCompletedTurn:true`, `persistedEventCount:23`, final output `child-done` |

**Fork vs spawn comparison (Q4 detail)**

| Axis | Session fork (`ctx.sessions.fork`) | Subagent spawn (`ctx.subagents.start('spawn', …)`) |
|---|---|---|
| New identity | Yes — new `SessionId` | Yes — new system-minted `SessionId` |
| `parentSession` | Source session id | Delegating parent session id |
| `seedLength` | Boundary into inherited parent log (`7` in probe) | **absent** (fresh child, zero parent context) |
| `delegationDepth` | **absent** (fork is not delegation) | `parent depth + 1` (child `1`, grandchild `2`) |
| `origin` | absent | `'subagent'` (persisted header) |
| Policy events | n/a (plain session) | `sandbox/mode` + `approval/policy` appended `source:'delegation'` (child and grandchild) |

## Findings mapped to AGE-64

1. **Real delegated children confirm the AGE-64 "fork = new principal" semantics at
   the delegation level** — a spawned child is a distinct principal with a stable
   native `SessionId`, exactly the `runtime_session_id` provenance role AGE-64 §3
   assigns. Q1/Q2 **VERIFIED**.
2. **Resume is identity-continuous for delegated children** — Q5 shows the child's
   session resuming on the **same** SessionId with the **persisted** `parentSession`
   and `delegationDepth` intact (not recomputed from runtime). This confirms the
   AGE-64 §3.2 "resume = same principal" rule and the monotone-depth guarantee in
   `dsh-subagent/depth` ("the persisted session header is authoritative and
   monotone: a resumed child arrives with fresh options, and counting it from zero
   would let it delegate as if it were top-level").
3. **Fork and delegation are two distinguishable lineage kinds, both on the same
   `parentSession` field** — fork adds `seedLength` (history boundary), delegation
   adds `delegationDepth` + `origin:'subagent'` (depth budget). They never collide:
   a forked session carries no `delegationDepth`; a spawned child carries no
   `seedLength`. **Nuance to record in AGE-64:** `ExecutionPrincipal.parent_principal_id`
   alone cannot tell a seed-fork from a delegation; consumers that need the
   distinction read `seedLength` vs `delegationDepth`/`origin` (or the transcript's
   provenance envelope). This is a **documentation-level nuance, not a contract
   change** — both kinds remain "new principal with parent relation".
4. **`delegationDepth` remains optional metadata on the header** — absent on the
   root (0 implied), present on delegated sessions, persisted across resume. This
   reinforces Slice 1's finding: treat `delegation_depth` as **optional
   adapter-reported lineage metadata**, not a required field of every principal.
5. **Per-executing-session enforcement boundaries are preserved under delegation** —
   every delegated session carries its own `sandbox/mode` + `approval/policy`
   events stamped `source:'delegation'` (probe: `workspace-write` / `never` pinned
   at delegation). Combined with AGE-63 S4 (the global `tools/pre-execute` gate
   already observes subagent calls), the AGE-64 invariant "lineage aggregation must
   never replace per-executing-session enforcement" is supported by real evidence.
   **No runtime governance behavior is added by this spike** (research only).
6. **Keyless probe caveats (reproducibility)** — the root step is intentionally
   rejected after the probe runs, so the headless process exits `1` by design; the
   findings are written before the rejection. The grandchild was created through
   the default continuable tool path (`backgroundMode: continuable`); a
   `subagent_fork` (fork-provider) grandchild was not exercised — the ISSUE permits
   stopping after one level, and the fork side of the comparison is already covered
   by Q4. The probe's scripted adapter is order-independent (first request = tool
   call; later requests = plain completion) because the continuable grandchild runs
   concurrently with the child's own continuation.

## Implications for the adoption gate

- The AGE-64 `ExecutionPrincipal` identity contract is now validated on **real
  delegation**, not just session primitives: distinct principals on spawn,
  identity-continuous resume, monotone delegation depth, and distinguishable
  seed-fork vs delegation lineage. The second validation pillar is **green**.
- **ARCHITECTURE_IMPACT: NO_CHANGE** to the AGE-64 field contract
  (`runtime_session_id` REQUIRED as provenance; `parent_principal_id` /
  `root_principal_id` / `delegation_depth` OPTIONAL). The only recorded nuance is
  the fork-vs-spawn lineage-kind distinction, to be captured in AGE-64 prose (or a
  later transcript/provenance-envelope field), never as a new required field.
- Remaining before adoption: AGE-66 items already flagged (e.g., `ignorable` skip
  under older consumers; the exact on-disk vs live-header `delegationDepth`
  contract is now directly evidenced by Q2/Q5).

## Repro

```bash
# single level (Q1–Q5, fork-vs-spawn)
DSH_BIN=<pinned dsh binary> bash spike/age-65-slice2/run.sh
# nested root→child→grandchild (adds Q6)
A65_S2_NESTED=1 DSH_BIN=<pinned dsh binary> bash spike/age-65-slice2/run.sh
# findings at <scratch>/findings.jsonl; DSH pinned 0.1.1-rc.2
```

---

## Final report

- **Q1 distinct child SessionId:** VERIFIED
- **Q2 parentSession live + persisted:** VERIFIED
- **Q3 delegationDepth root/child/grandchild monotone:** VERIFIED
- **Q4 fork vs spawn lineage metadata:** VERIFIED
- **Q5 child resume identity + lineage:** VERIFIED
- **Q6 nested root→child→grandchild:** VERIFIED
- **Fork-vs-spawn comparison:** distinct, non-overlapping lineage fields
  (`seedLength` vs `delegationDepth`/`origin`), both on `parentSession`
- **AGE-64 impact:** NO_CHANGE to the ExecutionPrincipal field contract;
  recorded nuance: lineage kind (seed-fork vs delegation) is not expressible by
  `parent_principal_id` alone and belongs in AGE-64 prose / provenance envelope
- **Governance invariant:** lineage aggregation must never replace
  per-executing-session enforcement — supported by per-child delegation-pinned
  policy events and AGE-63 S4; no runtime behavior added (research only)

STATUS: RESEARCH_VERIFICATION_COMPLETE
ARCHITECTURE_ADOPTION: NOT_AUTHORIZED
