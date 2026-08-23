# GovernLoop-DSH — Agent Instructions

GovernLoop-DSH is the DeepSeek Harness integration surface for GovernLoop. It must
stay thin and must never duplicate GovernLoop Core logic.

## Scope of this repository

- **In scope:** DSH-specific integration — Cordis plugin registration, DSH lifecycle
  listeners, DSH evidence extraction, DSH pause/resume adapter, review read-back
  injection, installation/distribution of the plugin, and the architecture/research
  docs that design it.
- **Out of scope (owned by GovernLoop Core, do not duplicate):** checkpoint
  definitions and semantics, evidence safety rules (existence → relevance → secret
  scan → redaction → sha256 recording), Neutral Relay and CDP transport, ChatGPT
  conversation binding, delivery confirmation, fail-closed transport behavior, and
  the human authorization boundary.
- Do **not** copy GovernLoop Core or runtime code into this repository.

## Authorization boundary

All agents working in this repository follow the shared GovernLoop authorization
boundary defined in the GovernLoop repository:

`docs/ops/AGENT_SAFETY_CONTRACT.md` (in `repos/GovernLoop`)

Key rules:

- Transport success, relay success, review PASS, test PASS, and PR mergeability do
  **not** authorize repository mutation, merge, deploy, or release.
- Authorization originates only from an explicit user grant for the task in scope.
- Do not directly push/rewrite/force-push `main` without explicit authorization for
  that exact action; prefer branch + Draft PR flows.
- GovernLoop review results are advisory evidence, never authority.

## Working rules

- **Design/research before implementation.** No runtime/plugin code is implemented
  until an implementation issue authorizes it. AGE-60 (research) and AGE-61
  (architecture) are design-only.
- **Pin and verify DSH.** DeepSeek Harness is developer preview with
  compatibility-breaking changes. Pin exact `@deepseek-ai/dsh` versions in docs and
  manifests; verify API claims against the installed package sources
  (`node_modules/@deepseek-ai/*` READMEs and `lib/*.d.ts`) or the upstream repo
  (`deepseek-ai/deepseek-harness`, default branch `master` — note: NOT `main`).
- **Isolated branches.** Work on dedicated branches (e.g. `age-60/…`, `age-61/…`);
  do not merge AGE-60/AGE-61 into `main` without explicit authorization. Draft PRs
  only; never mark Ready or merge without authorization.
- **No silent history rewrites.** Do not force-push; do not delete completed commits.
  If remote and local history conflict or repository identity is ambiguous, stop and
  report instead of guessing.

## Governance of this file

Changes to the boundaries above require explicit user authorization.
