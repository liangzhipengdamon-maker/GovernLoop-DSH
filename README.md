# GovernLoop-DSH

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

- **AGE-60** — research: DSH architecture and plugin model
  (`docs/research/AGE-60-dsh-plugin-research.md`, branch `age-60/research-dsh-plugin`).
- **AGE-61** — architecture/design only: integration contract
  (`docs/architecture/AGE-61-governloop-dsh-integration-architecture.md`, branch
  `age-61/dsh-integration-architecture`).
- **No implementation yet.** No runtime/plugin code exists in this repository.

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

See `AGENTS.md` for the working rules in this repository.
