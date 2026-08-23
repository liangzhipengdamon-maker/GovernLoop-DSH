# AGE-64 — Universal Agent Identity / Lineage / Governance Transcript Research

**Status:** RESEARCH_COMPLETE — research only, no implementation
**Date:** 2026-08-24
**Baseline:** `origin/main @ 1c6b650e71179cc4f3f4d359e6347c014f3813c7` (AGE-63 merged + verified:
thin adapter on main, DSH pinned `0.1.1-rc.2`, unit 21/21, E2E 5/5, clean tree)
**Reference runtime:** DeepSeek Harness `@deepseek-ai/dsh 0.1.1-rc.2` (source facts cited where load-bearing)
**Evidence conventions:** `[DSH fact]` = verified source/API behavior; `[AGE-63 fact]` = current merged implementation; `[Inference]` = reasoning; `[Proposal]` = candidate universal model. DSH is the **first reference runtime, not the assumed final protocol.**

---

## 1. Executive Summary

The central question: **how should GovernLoop identify, relate, audit, and share provenance-bound context across execution principals from different Agent runtimes, while preserving per-runtime enforcement boundaries and avoiding coupling to DSH-specific session semantics?**

Proposal: a three-tier, runtime-neutral model layered over any adapter:

1. **ExecutionPrincipal** — the runtime-neutral identity: GovernLoop-minted `principal_id` is canonical; the runtime-native `runtime_session_id` (e.g. DSH `SessionId`) is always preserved **as provenance** but never becomes the cross-runtime protocol.
2. **GovernanceEpisode** — the correlation unit: groups related principals (root + children) for review/PO presentation without merging enforcement identity.
3. **GovernanceTranscript** — append-only governance facts (`checkpoint-opened … checkpoint-closed`) as small authoritative events, with large payloads as **artifact references** and current state as **projection-derived**.

Principles: enforcement stays **per-principal at the execution seam** (`tools/pre-execute`); aggregation may simplify presentation but **never erases who actually attempted the action**; audit visibility **≠ model-context visibility**; context sharing is **minimum sufficient trusted context with provenance**, never a memory dump.

DSH 0.1.1-rc.2 maps cleanly onto this model (Section 7); the AGE-63 adapter already satisfies the per-session enforcement and fail-closed requirements, so AGE-64 changes **no runtime behavior**.

---

## 2. Verified DSH facts

| # | [DSH fact] @0.1.1-rc.2 | Source |
|---|---|---|
| F1 | `Session` identity = `SessionId`; an Agent's `id` equals its `session.id`; created by the system, not settable by plugins at runtime (the store mints them) | `dsh-session`, `dsh-agent` (agent registry "id: SessionId"), `dsh-agent-loop` |
| F2 | `SessionHeader = { version, id, createdAt, cwd?, parentSession?, seedLength?, delegationDepth?, origin?, agentPreset? }`; `delegationDepth` is durable, monotone, authoritative | `dsh-session` types + persistence README |
| F3 | Fork: `ctx.sessions.fork(source, boundary?, childSessionId?)` selects a completed-turn prefix, creates a **new** session with lineage metadata; subagent children record `parentSession` in their header | `dsh-session` README |
| F4 | Resume: `ctx.agents.resume({resumeSessionId})` loads the persisted session under the **same** `SessionId`; turn numbering and history continue | `dsh-agent-loop` README |
| F5 | Subagents (spawn/fork/ACP/Codex/Claude providers) each get their own `SessionId`; children pass through the same global tool pipeline; delegated children are pinned to approval `'never'` and inherit only the parent's sandbox override | `dsh-subagent` README + `dsh-tools` (global listeners verified in AGE-63 S4) |
| F6 | `tools/pre-execute` is the execution gate: `PreToolDecision = allow \| deny \| ask`; receives **parsed, deep-frozen** arguments (`unknown`), cannot rewrite arguments; `ask` routes to `ctx.approval` and fails closed without an answerer | `dsh-tools` README + `lib/types/index.d.ts` |
| F7 | `tools/result` (live) observes the immutable outcome; the durable `tool/result` is appended by the loop; `tool/result.meta` is tool-private JSON surviving replay | `dsh-tools` README, `dsh-session` types |
| F8 | Session log is append-only; `SessionEventMap` is **merge-extensible**; unknown event types refuse reconstruction unless `ignorable: true`; `KNOWN_SESSION_EVENT_TYPES` is a generated whitelist | `dsh-session` README + `known-event-types` |
| F9 | `session-projection`: synchronous fold units over committed events, persisted cache, `stateVersion` invalidation | `dsh-session-projection` README |
| F10 | `ctx.apiProxy` = Host↔Client API gateway (`session.prompt/history/cancel/updateQueue/export`); control/transport plane, not execution | `dsh-host-apiproxy` README |
| F11 | `userQuestions`: one provider per context; no provider → `NO_PROVIDER` (fail closed) | `dsh-user-questions` README |
| F12 | Approval: one-shot `allowed-once \| rejected \| cancelled \| unavailable`; `ask`/`never` per-session policy; paired `approval/asked`+`approval/decided` **log-only audit** events | `dsh-user-approval` README |
| F13 | Workspace binds a canonical path; a session belongs to a workspace only if `SessionHeader.cwd` matches; one session ≤ one workspace | `dsh-workspace`, `dsh-session` |
| F14 | Message source is merge-extensible (`MessageSourceMap`); AGE-63 uses kind `'governloop-review'` for verdict read-back | `dsh-llm` message types |

[AGE-63 facts] merged adapter: gate at `tools/pre-execute` (classifier deny + per-session latch at `agent/pre-step`); evidence via `tools/result` + rolling `session/event` buffer; relay via `governloop_session.py` CLI; structured review envelope (unknown/malformed → BLOCKED); PO via `ctx.userQuestions` (ADR-13 headless file provider: installs only when none active, no auto-approve, fail-closed, dispose restores); one-shot retry token minted in-connector after explicit PO (session + fingerprint + exact command + expiry + single-use); verdict injected via `followup` with `governloop-review` source; per-session state map; global pre-execute listener gates subagents; never calls `setSandboxMode`/`setApprovalPolicy`.

---

## 3. Universal Execution Identity findings

### 3.1 Candidate contract v0

```text
ExecutionPrincipal
├── principal_id            # REQUIRED — GovernLoop-minted, canonical cross-runtime id
├── adapter_id              # REQUIRED — e.g. 'dsh' | 'codex' | 'claude-code'
├── runtime_type            # REQUIRED — stable adapter-declared enum
├── runtime_session_id      # REQUIRED — adapter-native session id (DSH SessionId today)
├── workspace_id?           # OPTIONAL — stable workspace/root reference (canonical path, not identity)
├── parent_principal_id?    # OPTIONAL — set when created via delegation/fork
├── root_principal_id?      # OPTIONAL — root of the delegation tree
├── delegation_depth?       # OPTIONAL — mirrored from runtime (DSH delegationDepth), monotone
├── lifecycle_epoch?        # OPTIONAL — resume/fork/retry counter (identity continuity metadata)
└── provenance              # REQUIRED — the mapping record: adapter_id + runtime_session_id
                            #           + workspace ref + creation/continuation facts
```

### 3.2 Findings per question

1. **Minimum stable identity GovernLoop needs**: `principal_id` (canonical) + `adapter_id` + `runtime_session_id` (provenance) + a workspace/root reference for correlation. Everything else is metadata.
2. **Canonical inside GovernLoop**: `principal_id`. The adapter is the only component that maps `runtime_session_id → principal_id`; Core never interprets native ids.
3. **Runtime-native IDs remain provenance**: DSH `SessionId` stays in every evidence/event as `runtime_session_id` — [Proposal] "visible, but not the protocol."
4. **Resume / fork / retry / reconnect**:
   - *Resume* (F4): same `SessionId`, continuation → **[Proposal] same principal**, `lifecycle_epoch` increments (identity continuity is a fact to record, not a new principal).
   - *Fork* (F3): new `SessionId`, seeded prefix → **[Proposal] new principal** with `parent_principal_id` + seed boundary metadata (a fork is a new execution identity by DSH semantics).
   - *Retry/reconnect*: same principal (adapter re-registers the same mapping).
   - *External runtimes without a DSH-style session*: `runtime_session_id` may be a thread/task/run id; adapter must still mint a stable `runtime_session_id` from what exists (or a stable surrogate) — the canonical id is never the native one.
5. **Resumed session = same principal**: yes (F4 continuation). The principal's *lineage* is unchanged; only `lifecycle_epoch` changes.
6. **Fork creates a new principal**: yes (F3). The child inherits a *lineage* relation, not the identity.
7. **Externally hosted runtimes**: covered in (4); the adapter owns translation and must not leak unstable native handles into Core.
8. **Required vs optional**: REQUIRED = principal_id, adapter_id, runtime_type, runtime_session_id, provenance. OPTIONAL = the rest.
9. **Core vs adapter-local**: Core owns `principal_id` + mapping index + episode correlation. Adapter owns runtime-native session metadata, resume/fork translation, and any runtime-local caching. `delegation_depth`/`parentSession` are *runtime facts* the adapter reports; Core consumes them as lineage metadata.

**Required principle upheld:** runtime-native identity remains visible as provenance; it never becomes the cross-runtime protocol.

---

## 4. Multi-Agent Lineage findings

### 4.1 Model v0

```text
GovernanceEpisode G1                        (correlation / presentation layer)
   ├── Principal P1 / root  (runtime_session = main)
   ├── Principal P2 / child (runtime_session = child A; parent = P1)
   └── Principal P3 / child (runtime_session = child B; parent = P1)
```

Four distinct layers, never conflated:

| Layer | What it is | Where it lives |
|---|---|---|
| **Enforcement identity** | the exact principal that attempted the action | per-principal gate state (AGE-63 already per-session) |
| **Lineage identity** | parent/root/delegation relation | adapter-reported `parent_principal_id`/`root_principal_id`/`delegation_depth` (DSH `parentSession`/`delegationDepth`, F2/F3) |
| **Governance correlation** | a GovernLoop `GovernanceEpisode` grouping related principals | Core-side correlation (candidate: `episode_id`) |
| **Presentation aggregation** | a PO-facing review timeline that may group children | adapter/Core presentation; **never rewrites provenance** |

### 4.2 Findings per question

1. **Every child execution → independent checkpoint**: **yes** — enforcement is per-session by AGE-63 design and DSH F5 (children share the global pipeline but the latch is per-session). [Proposal] preserved: aggregation happens above enforcement, never at it.
2. **Aggregation without weakening per-session enforcement**: yes — correlate at the episode/presentation layer; the gate decision is always the executing principal's own.
3. **Parent/child representation**: `parent_principal_id` + `root_principal_id` + `delegation_depth` (mirrored from F2/F3). DSH's tree is traceable (`traceSession`), so the adapter can report it; Core stores only the principal relations.
4. **Nested delegation**: the parent chain extends; `delegation_depth` stays monotone (F2). A grandchild's enforcement is its own; its episode correlates to the root.
5. **Child outlives root**: DSH allows an orphaned live child (F5); [Proposal] the child stays an independently governed principal; its episode may be re-rooted or flagged `orphaned` — enforcement never depends on the root's liveness.
6. **Concurrent child checkpoints to the PO**: presented per-principal under one episode; each carries its own `checkpoint_id` + evidence owner.
7. **Multiple children share one ChatGPT review conversation**: **safe at transport level** (AGE-63 already tags evidence per checkpoint), but [Proposal] review correlation must not merge verdicts across principals — each principal's decision is its own; sharing a conversation is a presentation/transport convenience, never a decision merge.
8. **IDs retained in every evidence object**: `principal_id` + `runtime_session_id` + `checkpoint_id` (+ `episode_id` when assigned). Required by the provenance rule.
9. **Lineage across resume/fork**: resume preserves lineage (same principal); fork creates a new principal with parent link; `lifecycle_epoch`/seed boundary records the continuity.
10. **Non-DSH runtimes**: adapter reports the same four layers; where a runtime has no native parent/child concept, the adapter declares flat lineage (every principal is a root until proven otherwise).

**Required principle upheld:** aggregation may simplify presentation; it never erases who actually attempted the action.

---

## 5. Governance Transcript findings

### 5.1 Three responsibilities (never conflated)

| Responsibility | Shape | Example |
|---|---|---|
| **Event** | small authoritative append-only governance fact | `governloop/review-received {checkpoint_id, principal_id, review_id, verdict, artifact_ref, content_hash, provenance}` |
| **Artifact Reference** | hash/id pointer to large evidence (GPT response, evidence bundle, exported report) | `artifact_ref {id, sha256, kind, url?}` — content stored externally |
| **Projection** | derived current state folded from events | `GovernanceProjection {current_checkpoint, review_status, po_status, retry_grant_status, related_principals, latest_evidence_refs}` |

### 5.2 Event taxonomy candidate v0

```
governloop/checkpoint-opened      {checkpoint_id, principal_id, kind, action_fingerprint, triggered_at, provenance}
governloop/review-requested       {checkpoint_id, principal_id, review_id, artifact_ref, requested_at}
governloop/review-received        {checkpoint_id, principal_id, review_id, verdict, confidence, artifact_ref, content_hash, received_at}
governloop/po-decision            {checkpoint_id, principal_id, decision: approve|decline|unavailable, decided_at}
governloop/retry-grant-issued     {checkpoint_id, principal_id, grant_id, fingerprint, expires_at, issued_at}
governloop/execution-resumed      {checkpoint_id, principal_id, grant_id?, resumed_at}
governloop/checkpoint-closed      {checkpoint_id, principal_id, outcome: allowed|blocked|failed|superseded, closed_at}
```

Event schema principles: immutable, append-only, lossless JSON, every event carries `principal_id` + `runtime_session_id` + `checkpoint_id` + provenance; schema versioned (additive evolution).

### 5.3 Findings per question

1. **Which facts must be append-only events**: the authoritative decision/state transitions above (opened/requested/received/po-decision/grant-issued/resumed/closed). These are the replayable facts.
2. **Which payloads are reference-only**: full GPT review text, evidence bundles, exported reports — artifact refs with content hash; never duplicated into every runtime log.
3. **Which state is projection-derived**: `current_checkpoint`, `review_status`, `po_status`, `retry_grant_status` — folded from events, never separately mutable (mirrors `dsh-session-projection` F9 semantics).
4. **Model-visible vs audit-only**: the verdict **read-back** is model-visible (AGE-63 already injects a `governloop-review` user/message — a summary). The raw governance events are **audit-only** (precedent: `approval/asked`+`approval/decided` are log-only, F12). Principle: *audit visibility ≠ model-context visibility*.
5. **`ignorable: true` fits DSH's extension contract**: yes — F8: unknown event types refuse reconstruction **unless** `ignorable`. New governance events MUST be `ignorable` until the out-of-repo registration surface lands (this is the AGE-61 ADR-4 finding, now formalized).
6. **Older DSH consumers safely ignore new events**: yes, when `ignorable: true` (F8) — a consumer that doesn't know the type skips it during reconstruction.
7. **Replay reconstructs governance state**: fold the governance events in order into the projection; crash recovery reproduces the checkpoint state (latch/blocked/armed) from events, so a restart does **not** resurrect a half-authorized action.
8. **Schema evolution**: versioned event types; additive fields only; old readers ignore unknown fields (log preserves lossless JSON verbatim, F8).
9. **External review artifact unavailable during replay**: the event facts (verdict, decision) reconstruct state; the projection flags a broken/absent artifact ref (hash mismatch or missing) as `artifact_unavailable` — state is still reconstructable, only the payload is gone.
10. **No ChatGPT-thread dumping**: raw review conversations are artifact refs only; the transcript stores decisions + hashes.

**Required principle upheld:** audit visibility does not automatically imply model-context visibility; complete ChatGPT threads are never dumped into runtime logs.

---

## 6. Cross-Agent Durable Context findings

### 6.1 Boundary v0

- **Explicit non-goal**: reproduce ChatGPT product memory, or assume `Codex session == chatgpt.com conversation == ChatGPT memory`. These are separate systems [AGE-63 verified: DSH has no chatgpt.com channel; only GovernLoop relay reads/writes a conversation].
- **Target**: *provenance-aware task context sharing* — a receiving principal gets the minimum sufficient trusted context, each item tagged with provenance.

### 6.2 Findings per question

1. **What context is necessary to continue safely**: the governed task facts — what was decided (PO), what was reviewed (verdict), what changed (evidence/diff summary), what is still blocked (checkpoint state). Not the raw transcript.
2. **Context selection**: adapter/Core selects per checkpoint kind (send decisions, not logs — AGE-63 evidence contract); a "continue" bundle = current projection + approved evidence refs.
3. **Provenance attachment**: every context item carries a provenance envelope: `{kind: source-evidence | prior-agent-output | po-decision | independent-review | derived-summary, principal_id, runtime_session_id, checkpoint_id, content_hash, at}`. The receiving agent can distinguish the five kinds (required).
4. **Stale context**: identified by `lifecycle_epoch`/revision + supersession (a later checkpoint/closed event for the same action supersedes earlier); receivers verify hash before use.
5. **Content vs references in Core**: Core stores **references/hashes** by default; content storage only for explicitly approved context bundles (artifact-storage placement is an open question, Section 11).
6. **Runtime session vs external archive**: runtime session keeps the model-visible summary + audit events; full artifacts (review text, evidence) live in the archive referenced by hash.
7. **Sensitive minimization**: reuse GovernLoop core evidence rules (existence → relevance → secret scan → redaction → sha256); never forward raw logs.
8. **Receiver distinguishes the five kinds**: via the provenance envelope above.
9. **Survives runtime boundaries**: the envelope is runtime-neutral (no DSH-only fields required); adapters translate their native context into the envelope.
10. **Integrity verification**: content_hash on every artifact; events carry hashes of referenced payloads.

**Required principle upheld:** share the minimum sufficient trusted context, not an uncontrolled memory dump.

---

## 7. DSH Reference Adapter Mapping v0

| DSH concept @0.1.1-rc.2 | GovernLoop candidate | Stays DSH-specific | Becomes runtime-neutral | Never enters Core | Adapter translates |
|---|---|---|---|---|---|
| `SessionId` (agent.id === session.id) [F1] | `runtime_session_id` | ✓ (native) | — | — | native → principal_id mapping |
| `SessionHeader.cwd` [F13] | `workspace_id` reference (canonical path) | ✓ | ✓ (as a stable ref) | — | path → workspace ref |
| `parentSession` [F3] | `parent_principal_id` | ✓ | ✓ (relation) | — | native parent → principal parent |
| `delegationDepth` [F2] | `delegation_depth` (lineage metadata) | ✓ | ✓ | — | report as metadata |
| `tools/pre-execute` [F6] | execution governance seam | ✓ (the gate) | ✓ (seam concept) | — | event → checkpoint request |
| `tools/result` [F7] | execution evidence seam | ✓ | ✓ | — | result → evidence item |
| `session/event` [F8] | candidate transcript source (ignorable events) | ✓ | ✓ (append-only principle) | — | governance facts appended |
| session projection [F9] | candidate derived governance view | ✓ | ✓ (projection concept) | — | fold events → projection |
| `ctx.apiProxy` [F10] | transport/control-plane input | ✓ | ✓ (transport concept) | ✓ (not governance) | N/A (out of governance scope) |
| `userQuestions` [F11] | human interaction transport | ✓ | ✓ (transport concept) | — | question → PO channel |

**Never enters Core:** native session ids as the protocol, apiProxy semantics, runtime sandbox internals, raw chatgpt.com threads. **Adapter must translate:** identity mapping, lineage reporting, event append (with `ignorable`), evidence selection, question transport.

---

## 8. Core / Adapter Responsibility Matrix

Decision criteria applied: authority ownership, security boundary, replay requirements, multi-runtime portability, failure recovery, provenance.

| Concern | Human PO | GovernLoop Core | Adapter | Runtime (DSH) |
|---|---|---|---|---|
| authorization authority | **YES — sole authority** | holds policy/semantics; never self-authors | never decides | enforces `never`/sandbox independently |
| checkpoint semantics | ratifies decisions | owns definitions (AGE-61: five types) | translates events → checkpoint requests | exposes execution events |
| execution identity mapping | — | owns `principal_id` canonical index | maps `runtime_session_id → principal_id` | mints native session ids [F1] |
| runtime-native session IDs | — | never interprets as protocol | preserves as provenance | owns native lifecycle (resume/fork) [F3/F4] |
| lineage correlation | — | owns `GovernanceEpisode` correlation | reports parent/delegation facts | owns native parent/child (F2/F5) |
| evidence selection | — | owns safety rules (scan/redact/sha256) | selects/forwards candidates | produces results/logs |
| token / grant mechanics | grants intent | (placement question, §10) | currently mints after PO (AGE-63) | consumes via normal pipeline |
| sandbox enforcement | — | never elevates | never calls sandbox setters | **authoritative** (AGE-63 verified) |
| user-question transport | answers | owns semantics | transports (ADR-13 fallback) | hosts the seam (F11) |
| transcript storage | — | (placement question) | appends `ignorable` events (candidate) | stores session log [F8] |
| artifact storage | — | (placement question) | references by hash | stores tool artifacts/meta [F7] |
| projection state | — | (placement question) | folds events (candidate) | hosts projection seam [F9] |

**MUST live in Core:** principal_id authority, checkpoint semantics, episode correlation, evidence safety rules, authorization policy. **MUST remain runtime-side:** native session semantics, sandbox/permission enforcement, the execution gate. **MAY live in adapter:** identity mapping, lineage reporting, event appending, question transport. **Unresolved placements:** token mint (Core vs adapter — §10), transcript storage location, artifact storage, projection ownership.

---

## 9. Security / provenance risks

| Risk | Analysis | Mitigation |
|---|---|---|
| SessionId becomes the protocol | native ids leak into Core contracts; coupling to DSH | canonical `principal_id`; native ids provenance-only (§3) |
| Lineage spoofing | a child claims a wrong parent; forged `delegationDepth` | adapter is the only reporter; Core never trusts native claims without adapter mapping; DSH invariant checks reject forged `sandbox/mode`-style events (precedent) |
| Aggregation erases provenance | child actions shown under root in UI | presentation layer never rewrites evidence `principal_id` (§4) |
| Transcript pollution | non-`ignorable` unknown events break reconstruction [F8] | all new governance events `ignorable: true` until registration surface lands (§5.3.5) |
| Artifact unavailability | replay loses review payload | events carry facts + hashes; projection flags `artifact_unavailable` (§5.3.9) |
| Stale/untrusted context injected into a new principal | an old review/decision applied to new work | provenance envelope + content hash + supersession (§6) |
| Review-conversation cross-principal merging | one ChatGPT verdict attributed to several principals | per-principal checkpoint correlation; sharing a conversation ≠ merging decisions (§4.2.7) |
| Replay divergence (runtime log vs Core mirror) | two sources disagree | single append-only source per principal; Core mirror is a projection, not a second truth (§5) |
| Context sensitivity | raw logs forwarded | core evidence rules (scan/redact/sha256) reused (§6.2.7) |

---

## 10. Architecture Adoption Candidate v0

```text
PROPOSED
NOT ADOPTED
```

**What should become GovernLoop architecture** (after validation, per §11):
- `ExecutionPrincipal` identity model (canonical `principal_id`, provenance-only native ids) — **P0, adoption candidate**
- `GovernanceEpisode` correlation unit — **P0, adoption candidate**
- Governance transcript event taxonomy + `ignorable` DSH mapping — **P0 candidate; event implementation NOT adopted**
- Context provenance envelope (five kinds) — **P1 candidate**

**What remains experimental:** event/artifact/projection *implementations*, episode storage, cross-principal context bundles, token mint relocation, generic headless provider.

**What must be validated next:** (1) identity lifecycle on real DSH (resume/fork identity continuity); (2) lineage aggregation without provenance loss in a multi-child scenario; (3) `ignorable` governance events replaying under older DSH consumers; (4) a **second reference runtime** to prove runtime-neutrality (recommended: Codex or Claude Code mapping study).

**What implementation is allowed only after a separate PO adoption decision:** any code changes — event appending, projection units, episode store, context bundles, token/core placement, provider consolidation. AGE-64 grants research only.

---

## 11. Unresolved questions

1. Core-side canonical identity store vs adapter-local mapping (start with Core index; store shape TBD).
2. `GovernanceEpisode` placement: Core-owned vs derived from principal relations.
3. Transcript location: runtime session log (adapter-appended `ignorable` events) vs Core store vs both — single-source-of-truth decision.
4. Artifact storage ownership (Core archive vs runtime-adjacent) and retention.
5. PO-facing aggregation UX: how episodes render without provenance loss.
6. Second-runtime validation to freeze the neutral contract (SessionId is not the protocol only if a second runtime actually fits).
7. Token grant: runtime-neutral signed grant format vs runtime-specific tokens (research only).
8. Headless provider: adapter-local vs generic Core interaction provider (research only).

---

## 12. Recommended next Issue(s)

- **AGE-65 (research): Identity & Lineage validation on DSH** — empirically confirm resume/fork identity continuity (F3/F4), child enforcement independence, and lineage reporting against `0.1.1-rc.2`; produce the `ExecutionPrincipal` mapping test matrix (boundary cases 1–15).
- **AGE-66 (research): Governance Transcript replay validation** — prototype-free analysis of `ignorable` event append + projection fold under older-consumer reconstruction rules; event schema versioning.
- **Second-reference-runtime mapping study** (Codex or Claude Code) — validate the runtime-neutral contract before any implementation adoption.

### Boundary analysis (required, 15 scenarios)

| # | Scenario | Identity | Lineage | Checkpoint owner | Evidence owner | Review correlation | Fail-closed |
|---|---|---|---|---|---|---|---|
| 1 | root + one child | P1, P2 | P2.parent=P1 | P1/P2 independent | per principal | episode G1 | per-session latch |
| 2 | root + concurrent children | P2..Pn | siblings of P1 | independent | per principal | one episode, per-principal reviews | independent |
| 3 | nested delegation | P3 child of P2 | chain P1←P2←P3 | P3 own | P3 | episode G1, depth-aware | P3 latch only |
| 4 | child destructive action | P2 | child | P2 | P2 | P2's checkpoint | denied + latch (AGE-63 global gate) |
| 5 | root approved must not authorize child | P1 token bound to P1 | — | token fingerprint/session-scoped | — | no cross-principal grant | token mismatch → deny (AGE-63 unit-tested) |
| 6 | child approval must not authorize sibling | P2 token | sibling P3 | P2 | — | no sibling inheritance | session-bound deny |
| 7 | child crashes before review returns | P2 gone | parent intact | checkpoint abandoned, latch cleared | evidence preserved | review correlation orphaned (flag) | fail-closed, no resume of half-auth |
| 8 | root ends while child active | P1 disposed | orphan P2 | P2 continues | P2 | episode flagged orphaned | P2 enforcement independent of root liveness |
| 9 | runtime resume | same principal, epoch+1 | unchanged | state reconstructed from log | preserved | episode continues | no auto-resend (AGE-63) |
| 10 | runtime fork | new principal P' | parent=P1, seed boundary | fresh | seeded prefix as provenance | new checkpoint in same episode or new episode (TBD) | fresh latch |
| 11 | same project two runtimes | P_a, P_b distinct | flat (both roots) | independent | independent | separate episodes; shared workspace ref only | independent |
| 12 | one review conversation, multiple principals | per principal | per principal | per principal | per principal | shared transport, never merged verdicts | per-principal verdict enforcement |
| 13 | artifact unavailable during replay | — | — | state from events | ref flagged unavailable | review fact retained (verdict event) | projection degrades, no re-grant |
| 14 | stale context into new principal | P' receives bundle | provenance envelope | — | hash+epoch verified | superseded → rejected | stale context denied |
| 15 | adapter reconnects after Core restart | mapping re-registered | reported anew | state re-folded from transcript | hashes re-verified | episode resumes | no auto-resend; fail-closed until mapping confirmed |

---

## Required evidence notes

- All `[DSH fact]` claims cite `@deepseek-ai/dsh@0.1.1-rc.2` source/README (AGE-60/61/63 verification basis). Unverified behavior (e.g. exact `ignorable` skip behavior under all older consumers, fork/resume epoch semantics beyond README wording) is **flagged** and assigned to AGE-65/66 empirical validation.
- Current-implementation facts are AGE-63 merged state (`origin/main @ 1c6b650`); proposed architecture is explicitly separate.

`STATUS: RESEARCH_COMPLETE`
