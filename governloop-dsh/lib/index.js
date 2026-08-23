// governloop-dsh — plugin entry (AGE-63 minimal vertical slice).
// Thin native DeepSeek Harness plugin connecting DSH agents to GovernLoop's
// independent ChatGPT review with checkpoints and evidence.
//   BEFORE_DESTRUCTIVE_ACTION: tools/pre-execute deny → session latch at
//   agent/pre-step → evidence → GovernLoop relay → structured review envelope
//   → explicit PO authorization (userQuestions) → one-shot retry token →
//   verdict injection + followup (AGE-61 §8).
//
// The plugin only translates DSH lifecycle events and carries evidence/verdicts;
// it never re-implements GovernLoop checkpoint semantics, evidence safety rules,
// relay mechanics, or authorization boundaries (AGE-61 §6).
import { CheckpointManager } from './checkpoint.js'

export const name = 'governloop-dsh'
export const inject = ['userQuestions']

export function apply(ctx, config = {}) {
  const manager = new CheckpointManager(ctx, config)
  manager.registerPoProvider()
  // Restore the provider slot on unload only if it is still ours (never clear a
  // provider another plugin installed later).
  ctx.effect(() => () => manager.dispose())

  // Gate 1 — per-tool: classify destructive calls, deny, record pending checkpoint.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = manager.gate(exec)
    if (decision) return decision
    return next()
  })

  // Gate 2 — per-step: the session latch (the pause primitive; deny is not a pause).
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = manager.stepGate(payload)
    if (decision) return decision
    return next()
  })

  // Evidence tap (live) + review kick-off for denied calls. The review pipeline
  // runs as a direct fire-and-forget continuation from this observer (verified
  // end-to-end in the AGE-63 E2E). NOTE vs AGE-61 §4.2: v1 does NOT run the
  // relay as a ctx.jobs job — the direct continuation with captured service
  // references was empirically sufficient, and no half-wired ctx.jobs hook is
  // left behind. Jobs-based ownership/cancellation is a documented follow-up.
  ctx.on('tools/result', (exec, result) => {
    manager.onToolResult(exec, result)
  })

  // Evidence tap (durable): rolling per-session event buffer.
  ctx.on('session/event', (session, event) => {
    manager.observeEvent(session, event)
  })

  // Session teardown: abandon in-flight checkpoints, clear latches.
  ctx.on('agent/disposed', (payload) => manager.onAgentGone(payload.agent))
  ctx.on('session/disposed', (session) => manager.onAgentGone({ id: session.id }))

  // agent/session-start: deliberately nothing in v1 — restart/resume must not
  // auto-resend anything (AGE-61 §4.10). In-flight checkpoints at crash are
  // lost (in-memory state) and the agent starts un-latched; a resumed agent may
  // re-trigger a fresh checkpoint for the same action, which is fail-closed.
}
