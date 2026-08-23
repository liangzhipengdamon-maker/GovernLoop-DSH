# AGE-60 — Research: DeepSeek Harness Architecture and the GovernLoop-DSH Plugin Model

**Status:** research only — no implementation, no product code
**Date:** 2026-08-23
**Inspected artifact:** `@deepseek-ai/dsh` **0.1.1-rc.2** (published 2026-08-21), installed at
`~/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/` (npm registry: `deepseek-ai/deepseek-harness` monorepo)
**Sources:** (a) DSH npm package sources — READMEs, `lib/*.d.ts`, `lib/*.js`, `cordis.patch.yml` manifests — installed at the path above; (b) Cordis 4.0.1 sources (vendored, `@deepseek-ai/cordis`); (c) npm registry metadata (`registry.npmjs.org`); (d) the upstream repo `deepseek-ai/deepseek-harness` (default branch **`master`**) — `docs/architecture.md`, `docs/subsystems/{approval,core,tools,session,subagent,workflow,goal,sandbox,permission-presets}.md`, `docs/tool-execution-pipeline.md`, `docs/user/develop/*`, `packages/hooks/README.md`, `apps/cli/reference/README.md`, `CONTRIBUTING.md`; (e) GovernLoop core docs and sources (`repos/GovernLoop`: `AGENT_SAFETY_CONTRACT.md`, `neutral-relay-checkpoint-delivery.md`, `governloop_session.py`, `neutral_relay.py`).

---

## 0. Positioning

**GovernLoop-DSH automatically connects DeepSeek Harness agents to independent ChatGPT review with checkpoints and evidence.**

The integration must stay thin:

```text
DeepSeek Harness
    ↓
GovernLoop-DSH plugin          ← new, thin, lives in DSH
    ↓
GovernLoop core                ← unchanged: session manager + Neutral Relay + evidence rules
    ↓
session / checkpoints / evidence / Neutral Relay
    ↓
independent ChatGPT review
    ↓
review read-back
    ↓
DeepSeek Harness resumes
```

Everything in this report is grounded in the inspected sources. Where a statement is an
inference (marked *inference*), it is labeled as such.

---

## 1. DSH Runtime Architecture Map

### 1.1 Product shape

- `dsh` is a **profile launcher** (`@deepseek-ai/dsh`): `dsh --profile <name>`, `dsh web`, `dsh --profile headless "job"`, `dsh plugin --profile <name> <pnpm args>`.
- A **profile** is a directory under `$DSH_HOME/profiles/<name>` (`$DSH_HOME`, else `~/.dsh`) holding:
  - `package.json` — out-of-tree plugin dependencies;
  - the profile manifest `dsh.profile` with an **ordered `bundles` list**;
  - the user's own `cordis.patch.yml`.
- A **bundle** is an npm package whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; it contributes a patch layer. Bundles resolve from the dsh installation first (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless`), then from the profile's own `node_modules` (pnpm-installed out-of-tree plugins).
- **Patch layering** (root = empty): bundle patches in `dsh.profile.bundles` order → profile `cordis.patch.yml` → home `$DSH_HOME/cordis.patch.yml` → `--patch` overlays. A patch **replaces a targeted row's whole `config`** (no deep merge). Rows are plugin instances keyed by `id`; `insert` adds rows, `config` overrides. `!!js` expressions may reference `process.env`, `ctx.*` injected services, and `dshHomePath(...)`.
- `dsh-base/cordis.patch.yml` is the shared core of every profile (see §1.2). `dsh-web-app` and `dsh-headless` specialize it.

### 1.2 The core row set (`dsh-base` bundle)

Every profile mounts the base rows (ids → packages):

| Layer | Rows |
|---|---|
| Runtime plumbing | `timer`, `hmr`, `settings` (`dsh-settings-file`), `credentials` (`dsh-credentials-local`), `subprocess`, `shell-env` |
| Model | `llm` (`dsh-llm`), `llm-retry`, `llm-deepseek`, `llm-pi-ai`, `agent-default-model`, `token-meter` |
| Session | `session` (`dsh-session`), `session-persistence-jsonl`, `session-checkpoint-policy`, `attachment-local`, `session-query-sqlite` (opt-in), `session-projection`, `session-title*`, `session-telemetry-otel` (opt-out) |
| Agent | `agent` (`dsh-agent`), `agent-loop` (`dsh-agent-loop`, concrete loop), `agent-instructions`, `system-prompt`, `plan-mode` |
| Tools | `tools` (`dsh-tools` registry + pipeline), 18 tool plugins (`tool-bash`, `tool-fs`, `tool-fs-search`, `tool-skill`, `tool-todo`, `tool-subagent*`, `tool-workflow`, `tool-goal`, `tool-ralph`, `tool-jobs`, `tool-web`, `tool-str-replace-editor`, `tool-pwsh`, …), `tool-call-timeout-policy`, `tool-result-pruner`, `repeat-tool-reminder` |
| Policy / sandbox | `sandbox` (`dsh-sandbox-local`), `sandbox-policy`, `bash-sandbox`/`pwsh-sandbox`, `approval` (`dsh-user-approval`), `permission` (`dsh-permission-presets`), `fs-observation-policy`, `fs-sandbox` |
| Delegation | `subagent` + `subagent-spawn-in-process` + `subagent-fork-in-process`, `workflow-worker-thread`, `goal`, `goal-round-driver`, `jobs-local` |
| Plugins/ext | `typert-registry`, `typert-loader`, `api-gateway`, `commands`, `command-feedback`, `command-goal`, `skill`, `skill-filesystem`, `compaction-basic`, `command-compact`, `spill-local`, `spill-policy`, `web` (search), `web-search-deepseek` |

### 1.3 Cordis plugin framework (the plugin model)

Cordis 4.0.1 (`@deepseek-ai/cordis`, vendored in the DSH monorepo) is the DI/lifecycle core:

- `new Context()` = root dependency container; `ctx.plugin(plugin)` starts a plugin and returns a `Fiber`; a plugin is a function `(ctx) => void` or an object `{ name, inject, apply(ctx) }`.
- **`inject`** declares required services; the plugin stays *waiting* until they exist (activation is service-availability driven, not row-order driven).
- **Effect disposal**: listeners, services, and registrations are removed when the owning fiber is disposed; every registration returns an exact disposer.
- **Events** dispatch in five modes: `emit` (parallel, fire-and-forget), `parallel`, `serial` (in order until one bails), `bail`, `waterfall` (listeners compose `next()` — the return value of one listener feeds the next). `agent/pre-step`, `tools/pre-execute`, `tools/execute`, `tools/post-execute`, `agent/request`, `agent/request-error`, `llm/stream`, `approval/request` are all **waterfall** events; `agent/turn-stopping` is **serial**; the rest are emit.
- **Services** are registered via `ctx.provide(key, service)` / `Service` subclasses and typed by declaration merging (`declare module 'cordis' { interface Context { … } }`).
- **Scoped contexts** (`dsh-scope`): `createScope(ctx, key)` mints an agent-scoped context; registrations through `agent.ctx` are visible to that agent only and disposed with it. Scope parent chains implement preset → agent → global visibility. Scopes are *not* security boundaries ("security and authority are non-goals").
- **Loader** (`cordis-plugin-loader`): runtime plugin tree; entries have phases `pending / loading / active / failed / unloading`. `ctx.loader.entries()` is the discovery surface (`dsh-host-plugin-inventory` projects it as `pluginInventory/list`).
- **HMR** (`cordis-plugin-hmr`): hot-reloads loader-managed plugins; user patch files (`cordis.patch.yml`) are watched and recomposed transactionally (`watchUserPatches`).
- **Typert** (`dsh-typert-*`): a codegen-based Host↔Client RPC system. Host services mark methods `@Remote`; generated client remotes call through `ctx.remote` over the `/api` FetchHandler. The web UI (Client) and Host communicate through it; a Host plugin can expose its own Remote methods and forwarded events.
- **Dynamic in-session plugins** (`dsh-cordis-host-runner` + `dsh-tool-cordis`): the model can `define`/`run` Cordis packages live inside a session (host half in a `node:vm`, optional browser half answered by a page). Trust stance: "treat a dynamic package like bash access."

### 1.4 The two-layer event model (critical distinction)

DSH has **two separate event planes** — a GovernLoop plugin must use the right one for each job:

1. **Live Cordis events** (`ctx.on('agent/*' | 'tools/*' | 'session/*' | …)`) — process-local, synchronous-or-promise listeners, five dispatch modes, scope-filtered. Used for *control*: veto, pause, steer, answer.
2. **Durable session events** (`session.append(type, data)` → `SessionEventMap`, persisted as JSONL) — the append-only, event-sourced, replayable transcript. `assistant/chunk`, `tool/result`, `approval/asked`, `sandbox/mode`, etc. are *log-only* (never surface in model history). Used for *evidence*.

The session log is the single source of truth: **LLM message history is derived** from it (`session.deriveMessages()`), never stored separately. The live `tools/result` notification and the durable `tool/result` session event are distinct (same vocabulary, different planes).

---

## 2. Relevant Extension Points (when each fires)

### 2.1 Agent lifecycle — `agent/*` (declared in `dsh-agent`, emitted by `dsh-agent-loop`)

| Event | Mode | Payload | When it fires | GovernLoop relevance |
|---|---|---|---|---|
| `agent/created` | emit | `{agent}` | after scoped setup, session+registry entry exist | session open; bind GovernLoop session |
| `agent/session-start` | emit | `{agent, source}` — `SessionStartSource` = `startup` \| `resume` \| `clear` \| `compact` (full vocabulary per `dsh-agent/lib/types/runtime-types.d.ts` and upstream `docs/subsystems/core.md`; `clear`/`compact` are reserved — shipped code emits only `startup`/`resume`) | once, before first turn; "first supported startup injection point" | inject review/context into a resumed session |
| `agent/status` | emit | `{agent, status}` (`idle`⇄`running`) | every transition | observe pause/resume externally |
| `agent/pre-step` | **waterfall** | `{agent, messages, turn, step, signal}` → `PreStepDecision` = `reject` \| `enter(messages)` | before each proposed model step | **hard gate**: reject a step; add/remove messages entering the step |
| `agent/request` | waterfall | `{agent, turn, step, signal}` → `LlmCallConfig` | before each model request | swap model/provider/call config (e.g. route a step to the reviewer model — *not recommended*) |
| `agent/request-error` | waterfall | `{agent, turn, step, provider, failure, retryPolicy, signal}` → `{kind:'retry'}` or next | on failed model-request attempt | recovery/retry policy hooks |
| `agent/turn-stopping` | **serial** | `{agent, turn, signal}` | "the turn is about to close… Awaited before the boundary commits" | **gate before turn close**; a listener that steers re-reads the inbox and runs another step |
| `agent/error` | emit | `{agent, turn, step, error}` | step/turn error | NEW_BLOCKER / UNEXPECTED_STATE detection |
| `agent/inbox/inserted \| claimed \| discarded` | emit | `{agent, message, turn?}` | per inbox mutation | observe review-message delivery |

**Agent handle controls** (the pause/resume primitives — `agent.ts` / `dsh-agent` README):
`agent.followup(msg)` — queue next-turn message **and wake**; `agent.steer(msg)` — queue next-step input **and wake**; `agent.inject(msg)` — queue non-waking next-step context; `agent.cancel(cause, {keepInbox})` — cancel driver (+ inbox unless kept); `agent.whenIdle()` — whole-agent quiescence. `agent.inbox` is the durable projected queue (`agent/inbox/spliced` events).

### 2.2 Tool pipeline — `tools/*` (declared in `dsh-tools`, executed by the registry)

Order: **`tools/pre-execute`** → monotonic `ctx.tools.guard()`s → **`tools/execute`** → **`tools/post-execute`** → definition-owned `finalizeContent` → **`tools/result`** (observe-only) → loop appends durable **`tool/result`**.

| Event | Mode | Signature | Fires | GovernLoop relevance |
|---|---|---|---|---|
| `tools/pre-execute` | waterfall | `(exec, next) → Promise<PreToolDecision>`; `PreToolDecision` = `{kind:'allow'}` \| `{kind:'deny',reason}` \| `{kind:'ask',reason?}` | before every tool dispatch, **after** `run_code`-mode resolution, **before** approval/guards | **the per-tool gate**: classify destructive calls (`git push --force`, `rm -rf`, `git merge` on main, …) and deny/ask |
| `ctx.tools.guard(guard)` | (monotonic fn) | `(execution) → string \| undefined` | after pre-execute, cannot be overturned by later waterfall listeners | plugin-owned owner policy (e.g. "no writes outside workspace") |
| `tools/execute` | waterfall | `(exec, next) → Promise<ToolExecutionResult>` | wraps normalized dispatch; may replace `signal` only | timeout/retry/metrics wrappers |
| `tools/post-execute` | waterfall | `(exec, result, next) → Promise<PostToolDecision>`; accept (replace `content` **or** `value`, attach contexts) \| block (valueless failure + feedback) | after dispatch, before finalize | attach review context to a result; block a result pending review |
| `tools/result` | emit | `(exec, result)` | observe-only final outcome, live plane | evidence tap (result is immutable at this point) |
| durable `tool/result` | session event | `{turn, step, message, error?, meta?}` | appended by the loop after `tools/result` | **evidence**: persisted, replayable, `meta` is tool-private JSON that survives replay |

Notes: `tools/pre-execute` **cannot rewrite `exec.arguments`** (logged args would desync). **Policy receives parsed arguments, not the raw wire string** — `ToolExecutionInput.arguments: unknown` is "Losslessly JSON-serializable parsed arguments (tools validate their own schema)"; the registry "materializes its parsed JSON arguments once into a pipeline-owned `ToolExecution`" and deep-freezes them before `tools/pre-execute` (verified in `dsh-tools/lib/types/index.d.ts` @ 0.1.1-rc.2 and upstream `docs/subsystems/tools.md`). The raw model argument string (`ToolCallBlock.arguments: string`) belongs to the durable `tool/call` record, not the gate. `ask` is serviced by `ctx.approval` when mounted, **fails closed to `deny`/`unavailable` otherwise**. There is no identifier named `tool/before-execute` or `tool/after-execute` anywhere in the shipped code — the vocabulary is exactly the four events above plus `tools/code-dispatch-log` and `tools/change`.

### 2.2b File-observation gates (`dsh-fs-observation-policy`)

Separate from the tool pipeline, filesystem writes are gated by a policy with **no service** — pure `fs/*` event listeners:
- `fs/write-intent` → `{ kind: 'createIfAbsent' } | { kind: 'replaceIfVersion', version }`
- `fs/edit-intent` → `{ version }` basis, or `FS_NOT_OBSERVED` / `FS_NOT_FOUND`
- `fs/observed` — records `{ kind: 'present', version } | { kind: 'absent' }`

Single-slot first-wins decider; explicitly **not** a composable authorization chain ("layered permission/audit/sandbox interception belongs on `tools/execute`"). Useful to GovernLoop for **diff evidence** (versioned file states) and for observing what the agent actually changed.

### 2.3 Session durability & replay

- `session/event` (emit) — every append, post-commit; persistence backends subscribe (write-behind).
- `session/flush` — awaited durability barrier; `dsh-session-checkpoint-policy` calls it **before a model request, before a top-level side-effecting tool body, and at each `agent/pre-step`** (fail-closed).
- `session/created` / `session/disposed` — paired lifecycle edges.
- `ctx.sessions.fork(source, boundary, childId)` — lineage (subagent/fork prefix).
- **`SessionEventMap` is merge-extensible** — a plugin can add its own durable event types via `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'governloop/…': … } }` and append them through `session.append`. The plugin owns the relational invariant for merged events. (This is how `approval/asked`, `sandbox/mode`, `subagent/descriptor`, `todo/write`, `compaction/*` enter the log.)
- **`ignorable` envelope flag**: unknown event types refuse session reconstruction unless marked `ignorable` — evidence/replay compatibility risk for out-of-repo plugin events.
- Session log export: `GET /api/session.export?sessionId=<id>&includeDescendants=true` (web profile) streams a ZIP of raw JSONL/zstd artifacts + descendant sessions + referenced images. Also `ctx.sessionQuery` (`readSession`, `readSurface`, `traceSession`, `listEvents`, `filterEvents`) for exact reads without resuming.

### 2.4 Approval seam

- `ctx.approval.request(req)` → `allowed-once | rejected | cancelled | unavailable`; must be called inside an open agent turn; missing answerers fail closed.
- Durable audit: paired `approval/asked` + `approval/decided` events, **log-only** (never in model history).
- Answerers: `approval/request` **waterfall** listeners; "compose one terminal answerer per deployment"; agent-scoped listeners see only their agent's requests.
- `ApprovalPolicy` = `'ask' | 'never'`; effective = last durable `approval/policy` event, else config; `setApprovalPolicy()` is the write path.
- One-shot grants only; request carries `{agent, toolName, callId?, reason?, signal}` — **no tool arguments**.
- `dsh-authorization` (`ctx.authorization`) is a *different* concept: OAuth-style credential-acquisition flows (`registerFlow`, `begin`, prompts). Not action authorization.

### 2.5 Subagents / workflows / goals

- `ctx.subagents` — provider seam; durable `subagent/descriptor` events; `subagent/start`/`subagent/end` run pairs; continuable children (durable session + process-local Activation) with `followup`/`interrupt`/`reportFrom`; delegated children are pinned to approval `'never'` and inherit only the parent's sandbox override (policy fixed at delegation).
- `ctx.workflowEngine` — model-written orchestration scripts fanning out subagents; `workflow/start|end`, `workflow/phase|log`, `workflow/agent-start|end`; **no journaling/resume**; foreground collection only.
- `ctx.goals` + `goal-round-driver` — same-session continuation rounds (`<goal_round>` prompts); explicit deferred work: **"No independent evaluator — the model-facing goal policy decides when evidence is sufficient … evaluator-backed certification remains deferred."**

---

## 3. Stable / Usable Surfaces (first-prototype candidates)

Rated by (a) documented in README/d.ts, (b) exercised by shipped packages, (c) no "deferred/preview" caveats. Pre-release caveat applies to everything (see §4).

1. **`agent/pre-step` waterfall (reject / enter-messages)** — shipped extension point ("Compaction: pressure on `agent/pre-step`"; "Sandbox, permission, plan mode: `tools/pre-execute` …"), veto semantics documented precisely. The primary **checkpoint gate**.
2. **`agent/turn-stopping` serial** — documented as the awaited "about to close" hook; the loop's own docs name it as the place to bound runaway turns. The **review-gate / FINAL_VERIFICATION point**.
3. **`tools/pre-execute` + `ctx.tools.guard()`** — the documented allow/deny/ask gate; `dsh-sandbox-policy`, `dsh-tool-bash` escalate through it today. **BEFORE_DESTRUCTIVE_ACTION enforcement point**.
4. **`tools/post-execute`** — result replacement/blocking with feedback; used by sandbox/permission stack.
5. **`ctx.approval.request()` + `approval/request` answerer** — stable one-shot seam with durable audit records; the web UI already answers via the ACP bridge pattern.
6. **`session.append()` + merge-extensible `SessionEventMap`** — the sanctioned way for plugins to write durable evidence events (`approval/*`, `sandbox/mode`, `subagent/descriptor` set the precedent).
7. **`ctx.sessions.flush()` / `session-checkpoint-policy`** — durability barriers; evidence is durable before external side effects.
8. **`session/event` + `tools/result` + durable `tool/result`** — evidence taps on both planes.
9. **`ctx.sessionQuery.readSession/readSurface/traceSession`** — exact log reads for evidence assembly.
10. **`agent.followup / steer / inject / whenIdle / cancel`** — documented pause/resume/inject controls.
11. **`ctx.commands.register()`** — plugin slash commands (`command/run`/`command/done` durable, results outside model history) → a native `/governloop` command family.
12. **`ctx.jobs`** — background jobs with owner isolation → wrap the long-running relay wait.
13. **Profile bundle packaging** — `dsh.bundle.patch` manifest + `dsh plugin --profile <name> add <pkg>` is the documented install path.
14. **`ctx.sessionProjections.register()`** — pure synchronous fold units with persisted cache + change feed → per-session checkpoint state visible to UI.
15. **`ctx.llm.stream` waterfall** — wrapping model calls (logging/observability) — less critical for v1.

---

## 4. Experimental / Risky Surfaces

1. **Everything is pre-release.** `@deepseek-ai/dsh` has only rc versions (first publish 2026-08-10; latest 0.1.1-rc.2, 2026-08-21). No stable release, no compatibility promise; `SESSION_FORMAT_VERSION` pinned at `0` "pre-release, no broad compatibility implied" — logs refuse newer/older versions (no migration path).
2. **`dsh-cordis-host-runner` / `dsh-tool-cordis`** — dynamic in-session plugins: explicitly "not a security boundary", vm sandbox only isolates globals; suspended run requests have no timeout. Do NOT use as the governance mechanism.
3. **Typert codegen / `@Remote`** — the Host↔Client RPC system is generated-artifact based; "SRC mode" is a weaker dev fallback; schema identity/versioning is young. Only touch it if the plugin needs web-UI wiring.
4. **`hook/*` session events** — `hook/invoked`, `hook/result` are in the reserved vocabulary (`KNOWN_SESSION_EVENT_TYPES`) but **no shipped base package emits them**; do not depend on a `hook/*` event emitter. (Separately, DSH *does* ship external-hook **bridges** — `dsh-hooks-claude-code`/`dsh-hooks-codex` — which translate Claude Code/Codex `hooks.json` shell hooks onto the native interception points; a native "hook" is just a plugin on `agent/*`/`tools/*`, which is what GovernLoop writes.)
5. **`session-query-sqlite` full-text search** — opt-in (`openAt: never` default), in-memory by default in web; content search requires deployment override.
6. **`subagent` continuable children & `workflow`** — actively evolving (continuable children added 2026-08-10); workflow has "no journaling or resume".
7. **Plugin-authored session events** — merge-extensible in type-land, but the *persistence read path* (`KNOWN_SESSION_EVENT_TYPES`) refuses unknown types unless `ignorable`; out-of-repo plugin events are explicitly "outside this list by construction" with "a registration surface for them is deferred". Evidence events written by GovernLoop may make logs unreadable by other DSH builds unless marked `ignorable` — verify against the version mechanism before relying on it.
8. **`ctx.approval` out-of-turn calls throw**; approval "carries no tool arguments"; one-shot grants only — any govern-loop answerer must cope with these limits.
9. **Patch semantics** — a patch *replaces* whole row configs; a profile that must restate base rows risks drift on DSH upgrades.
10. **`tools/pre-execute` cannot rewrite arguments** — input sanitization is not possible at that seam.

---

## 5. Existing Overlapping Capabilities (DSH-native vs GovernLoop)

| Capability | DSH-native | GovernLoop value / difference |
|---|---|---|
| Human approval of actions | `ctx.approval` (`ask`/`never`), web UI answerers, ACP machine policy; sandbox escalation | GovernLoop is **not** a human-approval UI; it is an **independent ChatGPT reviewer**. The human authorization boundary stays in GovernLoop core (`AGENT_SAFETY_CONTRACT`): transport/review success is not authorization. |
| Sandbox / file-effect policy | `sandbox` modes `read-only`/`workspace-write`/`danger-full-access`, per-session `sandbox/mode` events, `fs-observation-policy` | Complementary: DSH confines *file effects*; GovernLoop checkpoints review *intent and work products* against an external model. |
| Session logging / replay | Event-sourced JSONL + `/export` ZIP + `sessionQuery` | GovernLoop consumes this as **evidence**, without reimplementing a log format. |
| Goals with continuation | `goal-round-driver` (same-session rounds, model-judged) | Explicit DSH gap: **"No independent evaluator … evaluator-backed certification remains deferred."** GovernLoop supplies the independent reviewer. |
| Subagents as reviewers | Subagent providers (spawn/fork, in-process/out-of-process) | A *governed* reviewer (external ChatGPT) is out of DSH scope; subagents are DSH-managed children, not external LLM conversations. |
| Checkpoints (durability) | `session-checkpoint-policy` — durability barriers before model request / side-effect / next step | Different meaning: DSH "checkpoint" = **durability barrier**; GovernLoop "checkpoint" = **review gate** (`NEW_BLOCKER`, `UNEXPECTED_STATE`, `BEFORE_DESTRUCTIVE_ACTION`, `REVIEW_REQUIRED`, `FINAL_VERIFICATION`). Complementary, not duplicative. |
| Plan mode / step veto | `agent/pre-step` reject, `plan-mode` prompt section | General veto; GovernLoop specializes the veto into checkpoint semantics + external review. |
| External-agent hook bridges | `dsh-hooks-claude-code` / `dsh-hooks-codex` translate `hooks.json` shell hooks onto the interception points | Compatibility bridges for Claude Code/Codex workflows — not review gates; a native GovernLoop plugin covers the same surface natively. |
| Community governance/reviewer plugins | `dsh-approval-llm`, `dsh-auto-review`, `dsh-advisor`, `dsh-verification`, `@tappass/dsh-governance`, `dsh-gov`, `dsh-write-gate`, `dsh-plugin-vajraclaw`, `dsh-trajectory-governance`, … (verified on npm, §9.2) | In-process gating/auditing/LLM-judges; **none** does external ChatGPT review over CDP with evidence attachments and read-back. GovernLoop-DSH should differentiate explicitly. |

No **official** DSH governance/approval/reviewer plugin exists (the shipped set contains only the mechanisms: `ctx.approval`, `permission-presets`, `plan-mode`, `fs-observation-policy`). The community market is live and growing — see §9.2 for verified candidates.

---

## 6. GovernLoop Unique Value (mapped onto DSH mechanics)

1. **Automatic external review loop** — DSH has no path to an *external* reviewer; `agent/pre-step`/`agent/turn-stopping` gates + GovernLoop relay create one.
2. **Checkpoints** — five named review checkpoints (core-owned definitions, NOT re-implemented in the plugin).
3. **Evidence delivery** — evidence = DSH's own durable session log + tool results + diffs (from `tool/result` `meta`/content), packaged by GovernLoop rules (exists → relevant → secret scan → record sha256; `.redacted` copies; attachments must reach the same conversation).
4. **Independent ChatGPT reviewer** — Neutral Relay over CDP to ChatGPT Web; agent-agnostic; no DSH dependency inside GovernLoop core.
5. **Review read-back** — relay writes the response file; plugin injects it into the agent (`agent.inject`/`followup`).
6. **Human authorization boundary** — unchanged, core-owned: review PASS / relay success / test PASS never authorize mutation; the plugin must not weaken or duplicate it.

---

## 7. Recommended Minimal GovernLoop-DSH Plugin Surface

**One npm package** (e.g. `@governloop/dsh-plugin`), a plain Cordis plugin row mounted via a bundle patch (`dsh.bundle.patch`), with a tiny profile-side config (GovernLoop session manager path, relay path, checkpoint mapping). No new service in the base; no web-UI wiring in v1.

**V1 scope (thin translation layer only):**

1. **Session binding** — on `agent/created`/`agent/session-start`: resolve repo/task/session (reuse GovernLoop's `governloop_session.py new` / `status`); if no conversation bound, surface `USER_CONVERSATION_SELECTION_REQUIRED` to the human (via `ctx.userQuestions`/`agent.inject`), never persist the URL in DSH config.
2. **Checkpoint mapping (events → core-owned checkpoint types):**
   - `agent/error` → `NEW_BLOCKER` / `UNEXPECTED_STATE` (plugin classifies *event*, core defines *semantics*).
   - `tools/pre-execute` classify destructive/risky calls → `BEFORE_DESTRUCTIVE_ACTION` (enforced at runtime — see §8 Q2).
   - `agent/pre-step` / `agent/turn-stopping` policy → `REVIEW_REQUIRED` (before major continuations) and `FINAL_VERIFICATION` (on `end`/completion).
3. **Evidence capture** — from DSH-native sources only: durable `tool/result` + `session/event` listeners; `ctx.sessionQuery.readSession` for the transcript; `tool-fs` result `meta` diffs; attachments via `ctx.attachments`/attachment store when needed. No GovernLoop core logic reimplemented.
4. **Relay invocation** — shell out to `governloop_session.py checkpoint <TYPE> --message … --attach …` (or the Neutral Relay directly with session-level conversation URL); enforce exit codes (`0` ok, `1` `CHECKPOINT_DELIVERY_INCOMPLETE`, `3` `USER_CONVERSATION_SELECTION_REQUIRED`). Run as a `ctx.jobs` background job for long waits.
5. **Pause/resume around review** — pause: `agent/pre-step` reject (step gate) or withhold steering at `agent/turn-stopping`; resume: read relay response file, `agent.inject()` the review verdict (source-tagged `user/message`), then `agent.steer()`/`followup()` to wake.
6. **Durable plugin event types** — extend `SessionEventMap` with e.g. `governloop/checkpoint` and `governloop/review` records (marked `ignorable` until the out-of-repo event registration surface exists) so checkpoint/review history is part of the session log.

**Explicitly NOT in the plugin:** checkpoint definitions, evidence/secret policy, relay/CDP mechanics, authorization rules, session-id scheme. All remain in GovernLoop core.

---

## 8. Open Questions / Risks

### Architecture
- **Q1 — exact gate mapping:** which lifecycle event is the *canonical* trigger for each checkpoint type, given that `agent/pre-step` vetoes a *step* (model request) while `tools/pre-execute` vetoes a *tool call*, and `agent/turn-stopping` vetoes *turn close*? Recommend: pre-step for REVIEW_REQUIRED, pre-execute for BEFORE_DESTRUCTIVE_ACTION, turn-stopping for FINAL_VERIFICATION; validate against the generated docs (`docs/subsystems/core.md`, `tools.md` — not shipped in npm, verify from the GitHub repo).
- **Q2 — pause semantics:** a long external review cannot block the tool pipeline (turn-bound `approval` request, no timeout guarantees). Recommend: reject at the next boundary (pre-step/turn-stopping) and let the agent settle to `idle` (`agent.whenIdle`), rather than in-flight blocking. Verify behavior of `agent/cancel` with `keepInbox` vs step-level withholding for the "paused but resumable" state.
- **Q3 — review read-back provenance:** inject via `agent.inject()` (next-step, non-waking context) vs `agent.followup()` (new turn). Recommend followup for a verdict the agent must act on; inject for advisory notes. Verify the `MessageSource` requirement (one source per message).

### Security / supply chain
- **Q4 — plugin trust & integrity:** out-of-tree npm packages are `dsh plugin` pnpm-installed; git-hosted plugin builds are blocked until `allowBuilds` in `pnpm-workspace.yaml` (good default). GovernLoop plugin distribution (npm vs git vs local path) must be decided; verify provenance expectations.
- **Q5 — evidence confidentiality:** session export includes descendants + attachments; the *ChatGPT conversation* is an external third party — evidence secret-scan/redaction rules (core-owned) MUST gate everything the plugin forwards. DSH's `tool/result.meta` may contain secrets the model saw; never forward raw logs.
- **Q6 — review prompt injection:** ChatGPT review output is injected back into the agent's inbox as a user message; the plugin must tag provenance (`MessageSource`) and treat review text as untrusted input (same class as user input, not as system policy).

### Compatibility
- **Q7 — session-format stability:** plugin-authored durable events + the pinned `SESSION_FORMAT_VERSION` v0 + `KNOWN_SESSION_EVENT_TYPES` refusal of unknown non-`ignorable` types. Decide: append `ignorable` events now, or keep checkpoint/review state out of the session log until the out-of-repo registration surface lands.
- **Q8 — patch drift:** profile `cordis.patch.yml` must restate whole base-row configs when overriding; a GovernLoop row must be additive (insert) so upgrades don't break.
- **Q9 — DSH velocity:** 10+ rc releases in 11 days; pin the exact `@deepseek-ai/dsh` version in the plugin's peer/dev deps and re-validate against each rc before release.

### Distribution / ops
- **Q10 — headless vs web:** `dsh --profile headless` has no UI/HTTP; the plugin must work in both (headless is the natural first target for automated GovernLoop review; web adds UI affordances later). Approval `'ask'` fails closed (`unavailable`) without an answerer — verify headless behavior.
- **Q11 — who answers `approval/request`:** if the plugin routes `ask` decisions to GovernLoop, it competes with the "one terminal answerer per deployment" rule; the ACP bridge already answers for owned sessions. Decide the answerer composition contract early.
- **Q12 — session lifecycle:** GovernLoop session (repo→task→session) vs DSH session (per-conversation log) are different units; define the mapping (one GovernLoop session ↔ one DSH session? one per task across resumes?).

---

## 9. External Research Findings (community / GitHub / registry)

Verified 2026-08-23 against the GitHub API, `raw.githubusercontent.com`, and `registry.npmjs.org`.

> **Scope note (evidence-scoped, date-scoped):** everything in §9 — especially §9.2
> (community plugins) and §9.4 (community security signal) — is **ecosystem
> reconnaissance, dated 2026-08-23, and is NOT architecture authority**. Third-party
> package/version/star/security claims change quickly and none of them is endorsed by
> DeepSeek. The **DeepSeek Harness official source and generated docs remain the
> authority** for integration behavior (AGE-61's contract relies only on verified DSH
> source claims; see AGE-61 Appendix A).

### 9.1 The upstream repo

- Repository: `deepseek-ai/deepseek-harness`, **default branch `master`** (not `main`; README URLs must use `/master/`). ~186k stars. **Zero open GitHub issues** — feedback flows through GitHub Discussions; `CONTRIBUTING.md` states external PRs are not accepted (contributions go through DeepSeek's own process). Implication for GovernLoop-DSH: plan for a **separate distribution channel** (own npm scope / git repo), not upstream contribution.
- The full generated documentation lives in the repo (not shipped in npm packages): `docs/architecture.md`, `docs/agent-lifecycle.md`, `docs/persistence-catalog.md`, `docs/tool-catalog.md`, `docs/tool-execution-pipeline.md`, `docs/subsystems/{approval,core,tools,session,subagent,workflow,goal,sandbox,permission-presets,session-query,session-reference,commands,jobs,extensions,typert}.md`, and plugin-authoring guides under `docs/user/develop/{basic,framework,practice}/` (e.g. `basic/tool.md`, `basic/config.md`, `basic/publish.md`). These are the authoritative "cordis surface" references the npm READMEs point to; AGE-61 should read `docs/subsystems/core.md`, `tools.md`, `approval.md` and `docs/tool-execution-pipeline.md` from `master` before implementing.
- Release/versioning: `@deepseek-ai/dsh` has **10 published versions, all `-rc`**, first publish 2026-08-10, latest 0.1.1-rc.2 (2026-08-21); `latest == next == 0.1.1-rc.2`. **No stable release exists.** Release-publish is a manual `workflow_dispatch` from `dsh-v*` tags; maintainers `imccyu` + `tianyicui-deepseek`; MIT license; Cordis vendored into the `@deepseek-ai` npm scope.

### 9.2 Community ecosystem (no official governance plugin, but a live third-party market)

There is **no official** DSH governance/approval/reviewer plugin. The community, however, already ships several overlapping packages (all verified on npm, 2026-08-23):

| Package | Latest | What it does | Relation to GovernLoop |
|---|---|---|---|
| `@tappass/dsh-governance` | 0.2.1 | "Authority layer… governs every tool call against your business rules via the TapPass /v1/govern policy" | server/rule-based tool gating; external policy API — no independent ChatGPT reviewer |
| `dsh-gov` | 0.1.0 | policy-based tool gating (allow/deny/ask) + structured JSONL audit trail | gating + audit, not external review |
| `dsh-plugin-vajraclaw` | 1.2.0 | "Deterministic Runtime Execution Governance & Security Circuit-Breaker for DSH Agents" | runtime circuit-breaker, not review |
| `dsh-approval-llm` | 0.1.4 | `approval/request` **answerer backed by a separate reviewer model** ("approve-for-me") | **closest analog**: a machine answerer on the approval seam — but an LLM route in-process, not an external ChatGPT conversation with evidence attachments |
| `@llangtop/dsh-approval-ai` | 0.1.0-rc.5 | AI approval answerer using the unified `ctx.llm` route, fail-closed local policy | same category as above |
| `dsh-approval-guardian` | 0.1.1 | routes sandbox escalation prompts through a dedicated approval path | approval UX/answerer, not external review |
| `dsh-write-gate` | 0.1.1 | two-tier (deterministic + LLM judge) pre-execution write gate | LLM judge for writes, in-process |
| `dsh-verification` (bpc-oss) | — | "every acceptance criterion must be backed by server-stamped real tool evidence before the completion gate lets a goal through" | **closest analog on evidence-gated completion** — but evidence is DSH tool evidence, not an external ChatGPT review |
| `dsh-advisor` (omdsh-dev) | — | per-session independent reviewer model observing the primary transcript; injects severity-ranked advice (nit / concern / blocker) | independent *in-process* reviewer model — external ChatGPT + evidence attachments remain unique to GovernLoop |
| `dsh-auto-review` (PerryLink) | — | read-only reviewer subagent decides allow/deny on the approval chain, fail-closed | same category as approval-llm |
| `dsh-trajectory-governance` | — | trajectory/anomaly governance: loop-deadlock, invalid-retry, goal-drift detection, cost attribution, one-click interrupt & breakpoint fork | monitoring + fork, not external review |
| `dshmarket` | 1.19.0 | visual plugin market inside DSH | distribution channel — GovernLoop-DSH could list here |
| `awesome-dsh-plugin/awesome-dsh-plugin` | — | curated plugin list, ~11.6k stars | discovery; several mirror lists exist (e.g. `Anil-matcha/awesome-dsh-plugin`, `bruc3van/awesome-dsh-plugin`) |

**Differentiation:** every community package found gates/audits/answers *inside* the DSH process (tool policies, approval answerers, LLM judges, circuit breakers, in-process reviewer models, evidence-stamped completion). None implements the GovernLoop loop: **external independent ChatGPT review over CDP with checkpoint-gated evidence delivery and review read-back into the live session**. That remains unique value. The existence of `dsh-approval-llm`/`dsh-auto-review`/`dsh-approval-guardian` also confirms the `approval/request` answerer seam is the ecosystem's accepted place to plug a "reviewer" — GovernLoop should plan to answer that seam *and* gate at `agent/pre-step`/`tools/pre-execute` for its checkpoints. None of these is endorsed by DeepSeek (no official governance plugin exists); none is a substitute for the GovernLoop core (relay, checkpoints, evidence policy, authorization).

### 9.3 Official documentation pointers and the prototype path

- Official positioning (repo README, `master`): "**Everything is a Plugin.**" — "DeepSeek Harness (`dsh`) is an open-source agent harness developed by DeepSeek AI… powered by Cordis." Status: "currently in *developer preview* and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**"
- Plugin authoring guide: `docs/user/develop/basic/index.md` ("Your first plugin" — a plugin is a module exporting `apply(ctx)`; local dev via `pnpm dsh web --patch ./scratch-plugin/cordis.yml` with an absolute-path row `- insert: - { id: hello, name: '…/my-plugin.ts' }`), `config.md` (Schemastery schema), `tool.md`, `publish.md` (bundle/profile packaging + git-install trust warning).
- "Hooks": DSH's hooks subsystem (`packages/hooks/README.md`) are **bridges** translating external Claude Code / Codex `hooks.json` shell-hook protocols onto the harness's typed interception points; "a 'native hook' is just an ordinary Cordis plugin on those extension points" (the `interception-extension-points` Agent Note). GovernLoop does not need the bridges — it writes a native plugin on `agent/*` / `tools/*` directly.
- Generated ground truth for AGE-61 (all under `https://github.com/deepseek-ai/deepseek-harness/blob/master/`): `docs/architecture.md`, `docs/agent-lifecycle.md`, `docs/tool-execution-pipeline.md`, `docs/tool-catalog.md`, `docs/persistence-catalog.md`, `docs/subsystems/{core,tools,approval,session,subagent,workflow,goal,sandbox,permission-presets,commands,jobs,extensions,typert}.md`, `docs/cookbook/extension-cookbook.md` (permission-gate example returning `{ kind: 'deny', reason }` from `tools/pre-execute`).
- Repo metadata: default branch `master`; 0 open issues (feedback via GitHub Discussions; **external PRs are not accepted** — CONTRIBUTING.md); maintainers `imccyu` + `tianyicui-deepseek`; MIT; releases are manual `workflow_dispatch` from `dsh-v*` tags (repacked tree, telemetry disabled); Cordis vendored + renamed into the `@deepseek-ai` scope (auditable/pinned framework layer).

### 9.4 Community security signal (relevant to a governance plugin)

From GitHub Discussions (titles verified; treat the "discussion-mining" secondary report with care):
- **#250 — model self-approval via the Web approval loopback channel** ("sandbox 内模型可通过 Web approval 回环通道自批准 danger-full-access") — approval answerers are a trust surface; GovernLoop's answerer must be careful about who can answer and with what authority.
- **#454 — third-party security audit of the plugin model** ("defensive research") — the plugin model is attack-surface-heavy; #451 reports vm-sandbox escape ×2 + **local `/api` RPC without auth (CVSS 8.8)**; #587 notes `dsh plugin add` has no signature/source verification and third-party plugins get boot-time full-config write access; #1337 — community plugins resolving a **second `@deepseek-ai/dsh-tools` copy** crash the tool scheduler (Symbol-key split).
- Official docs warn: `dsh plugin add github:…` executes the package's `prepare` script at install time "**outside any sandbox the agent runs under**"; allow-builds in `pnpm-workspace.yaml` is "permission to execute the package's code on your machine at install time". The awesome list carries the same warning ("Installing a plugin runs third-party code on your machine with your own permissions… Being on this list is not a security review").
- Sandbox vocabulary is **file-effects only** ("Network and process visibility are outside this vocabulary"); `danger-full-access` bypasses confinement; `DSH_PERMISSION_MODE` documented only in the CLI reference.

**Implication for GovernLoop-DSH:** the plugin runs with full harness process privileges (like every DSH plugin — there is no plugin isolation). Distribution must therefore be conservative (pin versions, publish prebuilt `lib/`, document `allowBuilds` guidance, sign/review releases), and the plugin must treat the DSH process as trusted while the *ChatGPT conversation* is external and untrusted.

---

## 10. Answers to the GovernLoop Integration Questions

1. **Best lifecycle events for checkpoints:** `agent/pre-step` (step gate, waterfall veto — REVIEW_REQUIRED), `tools/pre-execute` (per-tool gate — BEFORE_DESTRUCTIVE_ACTION), `agent/turn-stopping` (awaited pre-close — FINAL_VERIFICATION), `agent/error` + `agent/request-error` (NEW_BLOCKER/UNEXPECTED_STATE), `agent/session-start` (resume-time injection). `agent/status` for external pause/resume observation.
2. **Can BEFORE_DESTRUCTIVE_ACTION be enforced at runtime?** **Yes, at the tool boundary.** `tools/pre-execute` returns `deny`/`ask` and is executed by the registry before dispatch; `ctx.tools.guard()` adds monotonic owner policy that later listeners cannot overturn; `ask` routes to `ctx.approval`. The sandbox (`sandbox-policy`, per-session `sandbox/mode`) enforces file effects independently of the model. This is real enforcement, not prompting — BUT the gate receives the registry-materialized **parsed arguments object** (`ToolExecutionInput.arguments: unknown`, deep-frozen; the raw model string lives in the durable `tool/call` record, not at the gate), and `tools/pre-execute` cannot rewrite input; classification quality depends on the plugin's rules over that object. It also cannot block *conceptual* destructive actions that don't go through DSH tools (e.g. actions performed by an external process the agent launched) — sandbox confinement is the backstop for those. **Deny alone is not a pause**: after a deny the tool body is skipped and the loop can continue; pausing requires a latched gate at `agent/pre-step` (see AGE-61 §4).
3. **REVIEW_REQUIRED / FINAL_VERIFICATION mapping:** REVIEW_REQUIRED → step- or tool-boundary gate (`agent/pre-step` reject or `tools/pre-execute` ask) at configured frequencies/triggers; FINAL_VERIFICATION → `agent/turn-stopping` (awaited) or explicit `/governloop end --final`, run after the last work, before the loop reports completion. Both are plugin-side triggers that call core-owned `governloop_session.py checkpoint …` with evidence.
4. **Evidence capture without duplicating core logic:** subscribe to `session/event` (durable append stream) + `tools/result` (live final outcomes); read `ctx.sessionQuery` for exact transcript/lineage; use `tool/result.meta` (tool-private JSON, replay-safe) for diffs; export the session ZIP endpoint when full evidence is needed. The plugin only *selects and formats* evidence; GovernLoop core owns existence/relevance/secret-scan/redaction rules.
5. **Review read-back into the active task:** the relay/session-manager writes the ChatGPT response file (and prints `RESPONSE (head:)`); the plugin watches for it (job completion), reads it, and calls `agent.followup()`/`agent.inject()` with a source-tagged message, then wakes the driver. This is automatic and requires no user action.
6. **Pause/resume around external review:** pause = stop admitting work at the gate (`agent/pre-step` reject → turn closes with no step; or `agent.cancel(cause, {keepInbox:true})`); the agent settles to `idle` (`agent.whenIdle()`). Resume = after the review result is injected, `agent.steer()` (same-turn boundary) or `agent.followup()` (new turn) wakes the driver. Durable `turn/end {kind:'aborted'|...}` records the pause; resumed history continues from the log.
7. **Responsibilities split:** plugin = DSH-lifecycle translation, event classification, evidence selection, relay invocation, pause/resume, review injection, optional durable `governloop/*` events. Core = checkpoint definitions/semantics, evidence policy (secret scan/redaction/attachment rules), Neutral Relay + CDP mechanics, session-id/routing rules, authorization boundary. Do NOT re-implement any of the core side in the plugin.
8. **Stable enough for v1 vs experimental:** v1-safe: `agent/*` events, `tools/*` pipeline (pre-execute/guard/execute/post-execute/result), `ctx.approval`, `session.append`/`session/event`/`session/flush`, `sessionQuery`, `agent.followup/steer/inject/whenIdle`, `ctx.commands`, `ctx.jobs`, profile bundle packaging. Risky/avoid in v1: Typert Remote codegen, dynamic cordis packages, `hook/*` session events (no shipped emitter), plugin-authored non-`ignorable` session events, continuable-subagent internals, SQLite full-text.

---

## 11. Recommended Next Step (AGE-61)

Produce an implementation-ready spike spec for the minimal plugin (§7): exact event→checkpoint mapping table, the destructive-action classifier rule set (shell/fs patterns), evidence selection rules per checkpoint, pause/resume state diagram, and a test plan using `dsh --profile headless` with a stubbed relay. Pin `@deepseek-ai/dsh@0.1.1-rc.2` as the dev baseline and re-validate the mapping against the GitHub-generated subsystem docs (`docs/subsystems/core.md`, `tools.md`, `approval.md`) which are authoritative but not shipped in the npm packages.
