# AGE-65 — ExecutionPrincipal Identity Validation (first slice)

**Status:** research/validation spike complete — keyless, no runtime modification
**Date:** 2026-08-24
**Target:** `@deepseek-ai/dsh@0.1.1-rc.2` (verified baseline: `origin/main @ 1c6b650`)
**Method:** keyless headless probe (`spike/age-65-identity-validation/`): mock LLM
fail-loud net, scratch DSH_HOME, zero model calls, zero credentials.
**Evidence:** `spike/age-65-identity-validation/findings-2026-08-24.jsonl`

Validates AGE-64 §3/§4 identity semantics on real DSH before any adoption decision.

---

## Results

| # | Hypothesis (AGE-64 §3.2) | Result | Evidence |
|---|---|---|---|
| S1 | Session id minted by the system; `SessionHeader {version, id, createdAt, cwd}`; live header has **no** `delegationDepth`/`parentSession` for a top-level session | **PASS** | `S1-created` (header: `{version:0, id:'session-1', cwd:<repo>, parentSession:null}`) |
| S2 | Append + flush + reload via `SessionPersistence` → same id, same header version, event log intact | **PASS** | `S2-reload` (sameId:true, headerVersion:0, eventCount:7) |
| S3 | `ctx.sessions.fork` → **new** session id, `parentSession` = source id, `seedLength` = boundary → **fork = new principal** | **PASS** | `S3-fork` (newId:'session-2', parentSession:'session-1', seedLength:7) |
| S4 | `ctx.agents.create` → dispose → `ctx.agents.resume(same id)` → **same** session id, seq continues → **resume = same principal**; `agent.id === session.id` | **PASS** | `S4-resume` (sameSessionId:true, seqBefore:3 → seqAfter:4, agentIdEqualsSessionId:true) |
| S5 | Fork lineage metadata (`parentSession`) recorded | **PASS (partial)** | `S3-fork` parent link; **delegationDepth monotone check flagged** for follow-up (needs a real delegated child / scripted model) |

## Findings mapped to AGE-64

1. **`SessionId` is system-minted and stable across the session's life** — confirms
   AGE-64 F1: the adapter cannot forge identity; `agent.id === session.id`.
2. **Resume is identity-continuous**: the same `SessionId` after dispose→resume,
   with sequence continuing (3→4). Confirms AGE-64 §3.2 "resume = same principal,
   lifecycle_epoch increments".
3. **Fork creates a new principal**: `session-2` with `parentSession=session-1` and
   `seedLength=7` (the boundary). Confirms AGE-64 §3.2 "fork = new principal with
   parent relation + seed boundary".
4. **`delegationDepth` was NOT observed on the live or reloaded header of a
   top-level session** (absent in both `S1-created` and `S2-reload`). Per the
   persistence README it is required on disk for delegated sessions. **This is a
   nuance to record in AGE-64 §3.1:** `delegation_depth` should be treated as
   **optional adapter-reported lineage metadata**, present mainly for delegated
   sessions — not a required field of every principal. (Flag for AGE-66: verify
   the exact on-disk vs live-header contract for delegated sessions.)
5. **Persistence preserves identity and log** (`SessionInspection {meta, events}`
   — note: `persistence.load` returns an *inspection*, not a live `Session`).

## Implications for the adoption gate

- The AGE-64 `ExecutionPrincipal` identity semantics (resume=fork=fresh, native
  id stable as provenance) are **confirmed on real DSH** — the first validation
  pillar for adopting `ExecutionPrincipal` is green for the session-level slice.
- Remaining before adoption: **subagent-delegation identity** (parentSession +
  delegationDepth on a real delegated child, monotone depth) — a focused
  follow-up (AGE-65 second slice or AGE-66) that needs a scripted model or a
  real keyed run.

## Repro

```bash
DSH_BIN=<pinned dsh binary> bash spike/age-65-identity-validation/run.sh
# findings at <scratch>/findings.jsonl; DSH pinned 0.1.1-rc.2
```
