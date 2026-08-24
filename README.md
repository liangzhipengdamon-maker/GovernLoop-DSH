# GovernLoop-DSH

> **Not using DeepSeek Harness?** This repository is the DSH adapter. For
> WorkBuddy, OpenCode, Claude Code, Codex, or any other agent, use
> [GovernLoop Core](https://github.com/liangzhipengdamon-maker/GovernLoop) directly.

A thin native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin that automatically connects DSH agents to GovernLoop's independent ChatGPT
review — with checkpoints and evidence.

```text
DeepSeek Harness
        ↓
GovernLoop-DSH          thin native Cordis plugin (this repo)
        ↓
GovernLoop Core         unchanged, agent-agnostic
        ↓
session / checkpoints / evidence / Neutral Relay
        ↓
independent ChatGPT review
        ↓
review read-back
        ↓
DeepSeek Harness resumes
```

## Status

**Product Closure: VERIFIED (2026-08-24).**

The thin adapter is implemented and verified end-to-end in a real environment
(real Chrome/CDP + bound ChatGPT Web conversation + real Neutral Relay):
S1 bridge closure (deny → review → read-back → envelope → PO → one-shot token →
exact retry), S2 authorization, and S3 fail-closed scenarios (relay failure, PO
decline, missing attachment) all pass. Evidence:
`docs/verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md`.

Research history: AGE-60 (research), AGE-61 (architecture), AGE-65 (validation
slices) — see `docs/research/` and `docs/architecture/`. These are **historical
records, not the current runtime authority**.

## Install

The plugin package lives in [`governloop-dsh/`](governloop-dsh/); its README has
the full install, config, and test instructions.

Minimal prerequisites:

- Pinned `@deepseek-ai/dsh@0.1.1-rc.2` (developer preview — verify before upgrades).
- [GovernLoop Core](https://github.com/liangzhipengdamon-maker/GovernLoop) — install it
  first (`./scripts/install.sh`); it provides the session manager
  (`governloop_session.py`) and the Neutral Relay.
- Chrome running with CDP (`--remote-debugging-port=9233`) and an open, bound
  ChatGPT conversation.

Mount the plugin row via the bundle patch (`governloop-dsh/cordis.patch.yml`) or
`dsh plugin --profile <name> add governloop-dsh`, with
`GOVERLOOP_SESSION_MANAGER_PATH` pointing at `governloop_session.py`.

## Principles

- **Thin integration.** The plugin translates DSH lifecycle events into GovernLoop
  checkpoint triggers and carries evidence + review read-back. It never re-implements
  GovernLoop checkpoint definitions, evidence safety rules, Neutral Relay mechanics,
  or authorization boundaries.
- **GovernLoop Core stays independent.** Core remains agent-agnostic (WorkBuddy,
  OpenCode, Claude Code, Codex, DSH, …). This repository holds only the DSH-side
  integration.
- **DSH is developer preview.** Versions are pinned and claims are verified against
  DeepSeek Harness source/docs before use.

## License

[Apache-2.0](LICENSE).

See `AGENTS.md` for the working rules in this repository.
