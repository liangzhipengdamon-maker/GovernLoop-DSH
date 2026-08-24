# DSH-GPTLoop Quick Start

This is the shortest verified path for the current public release.

## Verified compatibility

- `governloop-dsh` `0.1.0`
- `@deepseek-ai/dsh@0.1.1-rc.2`
- GovernLoop Core installed locally
- Chrome started with CDP on port `9233`
- an existing GPT Web conversation

DeepSeek Harness is still a developer preview. Re-verify compatibility after DSH upgrades.

## 1. Install GovernLoop Core

```bash
git clone https://github.com/liangzhipengdamon-maker/GovernLoop.git
cd GovernLoop
./scripts/install.sh
```

GovernLoop Core provides the session manager and the Chrome/CDP Neutral Relay used by the DSH adapter.

## 2. Start Chrome with CDP

Start Chrome with:

```text
--remote-debugging-port=9233
```

Then open the GPT Web conversation you want to use as the persistent outer loop.

## 3. Bind that GPT Web conversation

From the project you want GovernLoop to track:

```bash
/governloop
```

Bind the current GPT Web conversation URL when prompted.

You can check the active binding with:

```bash
/governloop status
```

## 4. Install the DeepSeek Harness adapter

Use the DSH profile you actually run:

```bash
dsh plugin --profile <name> add governloop-dsh
```

For local development, the adapter can also be mounted with `governloop-dsh/cordis.patch.yml`; see [`../governloop-dsh/README.md`](../governloop-dsh/README.md).

## 5. Verify one real checkpoint

Run a DSH workflow that reaches a GovernLoop checkpoint. The verified loop is:

```text
DeepSeek Harness
      ↓
critical checkpoint + evidence
      ↓
GovernLoop bridge
      ↓
existing GPT Web conversation
      ↓
independent review + read-back
      ↓
human authority when required
      ↓
DeepSeek Harness resumes
```

Expected behavior:

- ordinary work remains local;
- only critical checkpoints leave the local execution loop;
- GPT review is advisory evidence, not execution authority;
- transport or malformed-response failures stay blocked;
- no automatic resend occurs.

## Troubleshooting

### Chrome / CDP is unavailable

**Symptom:** the checkpoint cannot reach GPT Web.

Check that Chrome was started with `--remote-debugging-port=9233` and that the browser is still running.

### No GPT Web conversation is bound

**Symptom:** GovernLoop has no destination conversation for the review request.

Run:

```bash
/governloop status
```

If no conversation is bound, run `/governloop` again and bind the intended `https://chatgpt.com/c/...` conversation.

### The DSH plugin is not loaded

**Symptom:** the expected GovernLoop checkpoint behavior never appears in the DSH workflow.

Verify that the plugin was installed into the same profile you are running:

```bash
dsh plugin --profile <name> add governloop-dsh
```

Also verify the DSH version is the currently tested `0.1.1-rc.2` before treating behavior on another preview build as a plugin regression.

### The adapter cannot find the session manager

For local/dev mounting, ensure `GOVERLOOP_SESSION_MANAGER_PATH` (or `sessionManagerPath` in the Cordis patch config) points to `governloop_session.py` from the installed GovernLoop Core.

Do not use `GOVERLOOP_RELAY_PATH` as a session-manager fallback; that name belongs to GovernLoop Core's Neutral Relay.

### A review is blocked or times out

This is expected fail-closed behavior when delivery, response completion, review parsing, or required human authorization cannot be confirmed.

Do not repeatedly resend the same checkpoint by hand. Fix the underlying binding/CDP/session problem first, then retry through the normal DSH workflow.

## More detail

- Technical adapter guide: [`../governloop-dsh/README.md`](../governloop-dsh/README.md)
- Product model: [`product/DSH-GPTLoop-outer-loop.md`](product/DSH-GPTLoop-outer-loop.md)
- Product Closure evidence: [`verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md`](verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md)
