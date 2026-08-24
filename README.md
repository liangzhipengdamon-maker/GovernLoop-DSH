# DSH-GPTLoop

**English** | [简体中文](README.zh-CN.md)

**The outer loop for DeepSeek Harness.**

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) to your existing GPT Web conversation for project context, independent review, and human authority.

**Fast inner loop. Persistent outer loop. One project.**

https://github.com/user-attachments/assets/60ece667-3e4c-46cd-8b83-1dea15ec7e08

*Click ▶ to play the 45-second real workflow: DSH checkpoint → GPT Web review → read-back → human approval when required → DSH resumes.*

> **Not using DeepSeek Harness?** Use [GovernLoop Core](https://github.com/liangzhipengdamon-maker/GovernLoop) directly for WorkBuddy, OpenCode, Claude Code, Codex, or other agents.

## Why GovernLoop

Local coding agents are fast at execution, but the wider project context often lives elsewhere. GovernLoop bridges the critical checkpoints instead of making the human copy context back and forth.

- **No clipboard relay.** Review requests and relevant evidence can move to GPT Web and the result can return to the same DSH workflow.
- **Keep the outer loop persistent.** GPT Web can retain project reasoning and independent review while DSH stays focused on local execution.
- **Native first.** DSH remains authoritative for execution, sandboxing, permissions, sessions, subagents, and native approval. DSH-GPTLoop only fills the missing bridge gap.
- **Verified in the real loop.** Product Closure was verified end-to-end with real DSH, GovernLoop Core, Chrome/CDP, and a bound GPT Web conversation.

Detailed GPT Web / Linear / GitHub / Docs / Drive outer-loop positioning lives in [`docs/product/DSH-GPTLoop-outer-loop.md`](docs/product/DSH-GPTLoop-outer-loop.md), not on this homepage.

## How it works

```text
DeepSeek Harness
      ↓
critical checkpoint + evidence
      ↓
DSH-GPTLoop / GovernLoop Core
      ↓
existing GPT Web conversation
      ↓
independent review + read-back
      ↓
human authority when required
      ↓
DSH resumes
```

Only critical checkpoints leave the local execution loop. Ordinary work stays local.

## Fast install

Prerequisites:

- pinned `@deepseek-ai/dsh@0.1.1-rc.2`;
- [GovernLoop Core](https://github.com/liangzhipengdamon-maker/GovernLoop) installed first with `./scripts/install.sh`;
- Chrome running with CDP (`--remote-debugging-port=9233`);
- an open GPT Web conversation bound to the GovernLoop session.

Install the DSH plugin:

```text
dsh plugin --profile <name> add governloop-dsh
```

Or mount locally with `governloop-dsh/cordis.patch.yml` and set `GOVERLOOP_SESSION_MANAGER_PATH` to `governloop_session.py`.

Full package guide: [`governloop-dsh/README.md`](governloop-dsh/README.md).

## Safety

- GPT review is advisory evidence, never execution authority.
- Explicit human authorization is required where the current DSH integration requires it.
- Failures stay blocked; no automatic resend.
- DSH native sandbox, permission, session, and approval behavior remains authoritative.
- Connected project tools retain their own authority.

## Verified compatibility

| Technical package | @deepseek-ai/dsh | Status |
|---|---|---|
| `governloop-dsh` 0.1.0 | 0.1.1-rc.2 | Product Closure VERIFIED |

DSH is developer preview, so upgrades should be re-verified before use.

## Learn more

- Product model: [`docs/product/DSH-GPTLoop-outer-loop.md`](docs/product/DSH-GPTLoop-outer-loop.md)
- Verification evidence: [`docs/verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md`](docs/verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md)
- Technical package: [`governloop-dsh/README.md`](governloop-dsh/README.md)
- Repository rules: [`AGENTS.md`](AGENTS.md)

## License

[Apache-2.0](LICENSE).
