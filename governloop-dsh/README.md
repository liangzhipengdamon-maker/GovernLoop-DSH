# governloop-dsh

Thin native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin that connects DSH agents to **GovernLoop**'s independent ChatGPT review with
checkpoints and evidence.

**Version 0.1.0 — minimal vertical slice:** `BEFORE_DESTRUCTIVE_ACTION` on
destructive `bash` commands (git history-rewriting + `rm -rf` class). Design
contract: `docs/architecture/AGE-61-governloop-dsh-integration-architecture.md`
(Rev 2). Verified runtime assumptions: `docs/spikes/AGE-63-dsh-runtime-verification.md`.

```text
DSH tool action (git push --force)
→ tools/pre-execute classifier deny + latch
→ agent/pre-step rejects while latch set (pause)
→ evidence → governloop_session.py → ChatGPT review (structured envelope)
→ explicit human (PO) authorization via userQuestions
→ one-shot retry token (exact call, expiring)
→ verdict injected + followup (resume)
```

## Authority model (non-negotiable)

- The ChatGPT review is **advisory evidence only**. It never authorizes execution.
- A destructive action may only run after **explicit human (Product Owner)
  authorization** mints a **one-shot retry token** bound to
  `session + call fingerprint + exact command/args + expiry` (default 10 min).
- **Fail closed:** an unknown/malformed/low-confidence review, a declined PO, a
  relay failure, or a timeout keeps the action blocked (session latch held).
  **No automatic resend.**
- GovernLoop core is unchanged and agent-agnostic; this plugin only translates DSH
  events and carries evidence/verdicts through the `governloop_session.py` CLI seam.

## Install

```text
dsh plugin --profile <name> add governloop-dsh
```

Or mount locally (dev): `dsh --profile <name> --patch <repo>/governloop-dsh/cordis.patch.yml "…"`
with `GOVERLOOP_RELAY_PATH` pointing at `governloop_session.py`.

### Config (`cordis.patch.yml` row)

| Key | Default | Meaning |
|---|---|---|
| `relayPath` | env `GOVERLOOP_RELAY_PATH` | session-manager executable |
| `stateDir` | env `GOVERLOOP_STATE_DIR` | GovernLoop session state dir |
| `cdpPort` | env `GOVERLOOP_CDP_PORT` | CDP port passthrough |
| `tokenTtlMs` | 600000 | one-shot retry token expiry |
| `evidenceMaxEvents` | 20 | rolling evidence buffer size |
| `relayTimeoutMs` | 600000 | relay wait bound |
| `attachPaths` | `[]` | evidence attachments (core validates/redacts) |
| `allowRules` | `[]` | exact command prefixes exempt from review (noise reduction only) |
| `debugOut` | `''` | lifecycle JSONL log (tests/ops) |

## Tested compatibility

| governloop-dsh | @deepseek-ai/dsh | Status |
|---|---|---|
| 0.1.0 | 0.1.1-rc.2 | tested (unit + headless E2E) |
| — | other rcs | verify before upgrade (developer preview, breaking changes) |

## Layout

- `lib/index.js` — plugin wiring
- `lib/checkpoint.js` — latch + state machine (AGE-61 §4)
- `lib/classifier.js` — destructive action classifier (AGE-61 §2)
- `lib/envelope.js` — structured review envelope (AGE-61 §3.4)
- `lib/token.js` — one-shot retry token (AGE-61 §4.3)
- `lib/relay.js` — `governloop_session.py` CLI client (AGE-61 §6.2)
- `tests/` — unit tests + keyless headless E2E harness (stub relay)
