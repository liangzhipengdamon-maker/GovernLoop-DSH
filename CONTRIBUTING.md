# Contributing

GovernLoop-DSH is a thin native DeepSeek Harness adapter. It intentionally
stays small: it translates DSH lifecycle events and carries evidence/verdicts;
it never re-implements GovernLoop Core semantics (see `AGENTS.md`).

## Scope of changes

- **In scope:** DSH-side integration, tests, docs, spikes.
- **Out of scope (do not duplicate):** checkpoint semantics, evidence safety
  rules, Neutral Relay/CDP transport, delivery confirmation, authorization
  boundary — those live in the GovernLoop Core repository.
- Research/architecture changes follow the Native-Gap Proof Gate: a capability
  is only added here after source-level proof that DSH native cannot provide it.

## Workflow

1. Work on a dedicated branch off `origin/main` (e.g. `fix/…`, `chore/…`).
2. Keep the change narrow; no force-push, no history rewrites.
3. Run the unit tests before opening a PR:

   ```bash
   node --test governloop-dsh/tests/unit.test.mjs governloop-dsh/tests/unit-gate.test.mjs governloop-dsh/tests/unit-relay.test.mjs
   # 30 unit tests
   ```

   The keyless headless E2E harness (stub relay) additionally requires a pinned
   `@deepseek-ai/dsh@0.1.1-rc.2` binary:

   ```bash
   DSH_BIN=<pinned dsh> node governloop-dsh/tests/harness/run-e2e.mjs
   ```

4. Open a Draft PR; do not mark Ready or merge without explicit authorization.
5. Never merge to `main` directly.

## Licensing

By contributing you agree that your contributions are licensed under the
[Apache-2.0](LICENSE) license of this repository.
