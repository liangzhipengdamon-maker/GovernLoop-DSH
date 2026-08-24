# AGE-65 — governloop-dsh runtime surface audit (fourth slice)

**Status:** research/audit — per-file judgment on `governloop-dsh/` (main @ 1c6b650),
no file modified, no runtime change
**Date:** 2026-08-24
**Target:** `@deepseek-ai/dsh@0.1.1-rc.2` (baseline `origin/main @ 1c6b650`)
**Lens:** Native-Gap Proof Gate (`docs/research/DSH-native-capability-boundary.md`)
+ thin-adapter rule (AGENTS.md: never duplicate GovernLoop Core semantics) +
AGE-65 slice 3 verdict (token TRIAL-KEEP under `PARTIAL`).

**Verdict vocabulary:** `KEEP` / `SIMPLIFY` / `REMOVE-CANDIDATE` /
`TRIAL-KEEP(token)`. Research only — nothing is changed here; `SIMPLIFY` /
`REMOVE-CANDIDATE` become implementation issues only after a separate PO
adoption decision.

---

## 1. Per-file judgment

| # | File | Lines | Role | Verdict | Rationale |
|---|---|---|---|---|---|
| 1 | `lib/index.js` | 61 | Plugin wiring: gates (pre-execute / pre-step), evidence taps, dispose, provider registration | **KEEP** | Pure DSH-side wiring of the in-scope adapter surface (AGENTS.md: lifecycle listeners, pause, evidence extraction, review read-back). No Core semantics authored. |
| 2 | `lib/checkpoint.js` | 413 | DSH-side governor: state machine, latch, review pipeline orchestration, PO ask, evidence buffer | **SIMPLIFY** | The *mechanics* are in-scope (gate→deny, latch, evidence tap, PO transport, token consume, verdict inject). The *state machine* (statuses, merge rules, which statuses latch) encodes **checkpoint semantics — Core-owned**; should be driven by Core's checkpoint model, not authored here. Largest shrink target. |
| 3 | `lib/classifier.js` | 91 | Destructive-command trigger rules (bash only) at `tools/pre-execute` | **KEEP** | No DSH-native equivalent (sandbox is file-effect, approval is policy-driven — neither classifies command content); thin detection, not capability. Optional SIMPLIFY: move rule table to `cordis.patch.yml` config. |
| 4 | `lib/envelope.js` | 114 | Review envelope protocol: template (buildCheckpointMessage) + extract/validate | **SIMPLIFY** | Keep the thin **consuming** half (extract/validate of Core's response file — needed for fail-closed read-back). The **authoring** half (envelope constants, `REVIEW_ENVELOPE:` template, verdict vocabulary) is review-protocol definition — belongs in Core; the plugin should consume Core's schema. |
| 5 | `lib/relay.js` | 122 | Core CLI seam: spawn `governloop_session.py`, request file, checkpoint send, response file path, no auto-resend | **KEEP** | The ChatGPT Web Bridge is the one proven native gap (boundary register G1–G3); the plugin only spawns Core's session manager — transport, delivery confirmation, fail-closed stay Core-owned. Correct thin placement. |
| 6 | `lib/token.js` | 63 | One-shot retry token: fingerprint+exactCommand+expiry+single-use, minted only after PO | **TRIAL-KEEP(token)** | AGE-65 slice 3: `PARTIAL` — DSH `ctx.approval` satisfies the hard gate but cannot express "PO once, retry same command without re-PO" and lacks content-level binding/expiry. Token retained; deletion requires a separate PO decision. |
| 7 | `types/governloop-review.d.ts` | 27 | Merge-extensible `MessageSourceMap` kind `governloop-review` | **KEEP** | Thin, in-scope provenance for review read-back (AGE-61 §5.2); no Core semantics. |
| 8 | `cordis.patch.yml` | 19 | Bundle patch mounting the plugin row | **KEEP** | Mount/config only. |
| 9 | `package.json` | 26 | Packaging, pinned peer dep `@deepseek-ai/dsh@0.1.1-rc.2` | **KEEP** | Pin-and-verify rule. |
| 10 | `README.md` | 124 | Usage/docs (incl. test instructions, closure confirmations) | **KEEP** | Docs; trim only if it drifts from the runtime (not now). |
| 11 | `tests/unit.test.mjs` | 126 | Pure tests: classifier, envelope, token | **KEEP** | Pins retained logic; envelope tests follow the envelope protocol decision (SIMPLIFY #4) if it moves to Core. |
| 12 | `tests/unit-gate.test.mjs` | 191 | Manager guards G1–G3 (token bypass, latch lifecycle, provider ownership) | **KEEP** | G1 (token is the ONLY retry path; APPROVE envelope alone never unlocks) is the load-bearing invariant under slice 3's `PARTIAL` verdict. |
| 13 | `tests/harness/` (4 files) | — | Keyless E2E harness: e2e-runner, run-e2e, scripted-adapter, stub-relay (5 scenarios) | **KEEP** | Keyless verification infrastructure (same pattern as AGE-65 slices); `DSH_BIN` env-required, no absolute paths. |

**Counts:** 13 rows → 9 KEEP, 2 SIMPLIFY, 0 REMOVE-CANDIDATE (envelope authoring
is a SIMPLIFY split, not a whole-file removal), 1 TRIAL-KEEP(token), 1 (harness)
kept as a group.

## 2. Minimal runtime closure boundary (最小收口边)

After the audit, the runtime must contain **only**:

1. **DSH-specific wiring** — `lib/index.js` + the mechanics inside
   `lib/checkpoint.js`: pre-execute trigger→deny, per-session latch,
   evidence tap, PO ask transport (`ctx.userQuestions`), token consume at the
   exact retry, verdict injection (`followup` + `governloop-review` source).
2. **Core CLI seam** — `lib/relay.js` (spawn Core's session manager; never CDP).
3. **Trial artifact** — `lib/token.js` (until the PO decision from slice 3).
4. **Trigger rules** — `lib/classifier.js` (optionally moved to config).
5. **Types / config / packaging / docs / tests** — rows 7–13.

**Explicitly OUTSIDE the boundary** (must live in Core, consumed — never
authored — by the plugin):

- Checkpoint state-machine **semantics** (statuses, merge rules, latch
  definition) — Core-owned; plugin maps events, Core decides meaning.
- Review **envelope protocol** (template, verdict/confidence vocabulary) —
  Core-owned; plugin validates and injects.
- Evidence **safety rules** (existence → relevance → secret scan → redaction →
  sha256) — Core-owned; plugin selects candidates only.
- Neutral Relay / CDP transport, delivery confirmation, fail-closed behavior,
  conversation binding — Core-owned (`relay.js` only spawns the CLI).
- Human authorization **policy** (review PASS ≠ authorization) — Core-owned.
- Any capability DSH native provides (per the Native-Gap Proof Gate) — e.g.,
  `ctx.approval` is the native pre-execution gate; GovernLoop adds only the
  retry-grant role the token covers.

**One-line boundary:** *the runtime keeps the wiring, the Core seam, the
trial token and the trigger rules; every piece of GovernLoop *semantics* moves
to Core and is consumed, never re-implemented.*

## 3. Notes

- Nothing in this audit modifies `governloop-dsh/`; `SIMPLIFY` /
  `REMOVE-CANDIDATE` are decision inputs for future implementation issues
  (after PO adoption, per AGE-64 §10 and AGENTS.md).
- This audit is consistent with the boundary register (G1–G7) and with
  AGE-65 slice 3 (`PARTIAL`): the token stays; DSH approval remains the native
  execution gate.
- Related architecture boundary: see `docs/research/DSH-native-capability-boundary.md`
  for the Native-Gap Proof Gate. This Slice does not adopt or implement that policy.

---

## Final report

- Per-file: 9 KEEP / 2 SIMPLIFY (`checkpoint.js`, `envelope.js`) /
  0 REMOVE-CANDIDATE / 1 TRIAL-KEEP(token) / harness group KEEP
- Minimal runtime boundary: wiring + Core CLI seam + trial token + trigger
  rules + types/config/docs/tests; all GovernLoop semantics move to Core
- No file changed, no runtime modified

STATUS: RESEARCH_VERIFICATION_COMPLETE
ARCHITECTURE_ADOPTION: NOT_AUTHORIZED
VERDICT: AUDIT-ONLY (no change applied)
