// Manager-level tests for the IMPLEMENTATION GUARDS (PR #4 review):
//   G1 token bypass — the ONLY retry path is checkToken (session + fingerprint +
//      command + expiry + one-shot); a review APPROVE envelope alone never unlocks.
//   G2 latch lifecycle — every release path is safe: approve→retry, decline/fail/
//      invalid→blocked, session dispose→cancel, active→reject.
//   G3 provider ownership — the plugin never replaces an existing userQuestions
//      provider (Web/ACP provider wins; headless gets the plugin's own).
// Run: node --test governloop-dsh/tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import { CheckpointManager } from '../lib/checkpoint.js'
import { mintToken } from '../lib/token.js'

function fakeCtx(overrides = {}) {
  return {
    userQuestions: { provider: undefined },
    jobs: { attachController: () => () => {}, start: () => { throw new Error('jobs.start not expected in these tests') }, onJobDone: () => () => {} },
    timeout: (fn) => fn(),
    ...overrides,
  }
}

function makeExec(command, overrides = {}) {
  return {
    name: 'bash',
    arguments: { command, description: 'probe' },
    callId: 'call-1',
    agent: { id: 's1', session: { id: 's1', header: { cwd: '/w' } } },
    ...overrides,
  }
}

// ---------- G1: token bypass ----------
test('G1: first destructive call is denied (no capability without PO)', () => {
  const mgr = new CheckpointManager(fakeCtx(), {})
  const decision = mgr.gate(makeExec('git push --force'))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /git-push-force/)
})

test('G1: a review APPROVE envelope alone does NOT unlock the gate', () => {
  const mgr = new CheckpointManager(fakeCtx(), {})
  mgr.gate(makeExec('git push --force'))
  const record = mgr.bySession.get('s1')
  // simulate: the review came back APPROVE but the human did NOT authorize (no token)
  record.envelope = { verdict: 'APPROVE', confidence: 'high', rationale: 'ok', required_fixes: [] }
  record.status = 'CHECKPOINT_PENDING'
  const decision = mgr.gate(makeExec('git push --force'))
  assert.equal(decision.kind, 'deny') // review APPROVE != execution permission
})

test('G1: a valid one-shot token allows the EXACT call once, then the gate re-locks', () => {
  const mgr = new CheckpointManager(fakeCtx(), {})
  const exec = makeExec('git push --force')
  mgr.gate(exec)
  const record = mgr.bySession.get('s1')
  record.token = mintToken({
    sessionId: 's1', checkpointId: record.id, callId: 'call-1', cwd: '/w',
    name: 'bash', args: exec.arguments, exactCommand: 'git push --force', ttlMs: 600000,
  })
  record.status = 'RETRY_ARMED'

  // exact retry -> allowed (consume + record removed)
  assert.equal(mgr.gate(exec), undefined)
  assert.equal(record.token.used, true)
  assert.equal(mgr.bySession.get('s1'), undefined)

  // immediate identical re-attempt -> NEW checkpoint deny (single use, no shortcut)
  const again = mgr.gate(makeExec('git push --force'))
  assert.equal(again.kind, 'deny')
})

test('G1: token binding rejects wrong session / modified args / expired / consumed', () => {
  const mgr = new CheckpointManager(fakeCtx(), {})
  const exec = makeExec('git push --force')
  mgr.gate(exec)
  const record = mgr.bySession.get('s1')
  const mint = () => mintToken({
    sessionId: 's1', checkpointId: record.id, callId: 'call-1', cwd: '/w',
    name: 'bash', args: exec.arguments, exactCommand: 'git push --force', ttlMs: 600000,
  })

  record.token = mint(); record.status = 'RETRY_ARMED'
  assert.equal(mgr.gate(makeExec('git push --force', { agent: { id: 's2', session: { id: 's2', header: { cwd: '/w' } } } })).kind, 'deny') // wrong session

  record.token = mint(); record.status = 'RETRY_ARMED'
  assert.equal(mgr.gate(makeExec('git push --force origin main')).kind, 'deny') // modified command/args

  record.token = mint(); record.status = 'RETRY_ARMED'
  record.token.expiresAt = Date.now() - 1
  assert.equal(mgr.gate(makeExec('git push --force')).kind, 'deny') // expired

  record.token = mint(); record.status = 'RETRY_ARMED'
  record.token.used = true
  assert.equal(mgr.gate(makeExec('git push --force')).kind, 'deny') // consumed
})

test('G1: a safe command is never gated (no false trip)', () => {
  const mgr = new CheckpointManager(fakeCtx(), {})
  assert.equal(mgr.gate(makeExec('git status')), undefined)
})

// ---------- G2: latch lifecycle ----------
test('G2: active checkpoint holds the latch (pre-step reject); RETRY_ARMED releases it', () => {
  const mgr = new CheckpointManager(fakeCtx(), {})
  mgr.gate(makeExec('git push --force'))
  const record = mgr.bySession.get('s1')
  const payload = { agent: { id: 's1' }, turn: 1, step: 1 }

  record.status = 'CHECKPOINT_PENDING'
  assert.deepEqual(mgr.stepGate(payload), { kind: 'reject' })
  for (const s of ['REVIEW_IN_FLIGHT', 'REVIEW_RECEIVED', 'AWAITING_PO_AUTHORIZATION', 'RESUME_PENDING']) {
    record.status = s
    assert.deepEqual(mgr.stepGate(payload), { kind: 'reject' }, `latch held in ${s}`)
  }

  record.status = 'RETRY_ARMED' // latch released; the exact retry may run
  assert.equal(mgr.stepGate(payload), undefined)
})

test('G2: decline / relay failure / invalid envelope keep the latch (fail closed)', () => {
  const mgr = new CheckpointManager(fakeCtx(), {})
  mgr.gate(makeExec('git push --force'))
  const record = mgr.bySession.get('s1')
  const payload = { agent: { id: 's1' }, turn: 1, step: 1 }
  for (const s of ['BLOCKED', 'FAILED']) {
    record.status = s
    record.blockedReason = `test: ${s}`
    assert.deepEqual(mgr.stepGate(payload), { kind: 'reject' }, `latch held in ${s}`)
    // and the action itself stays denied, not re-opened
    assert.equal(mgr.gate(makeExec('git push --force')).kind, 'deny', `blocked-deny in ${s}`)
  }
})

test('G2: session dispose clears the latch (cancel path)', () => {
  const mgr = new CheckpointManager(fakeCtx(), {})
  mgr.gate(makeExec('git push --force'))
  const payload = { agent: { id: 's1' }, turn: 1, step: 1 }
  assert.deepEqual(mgr.stepGate(payload), { kind: 'reject' })
  mgr.onAgentGone({ id: 's1' })
  assert.equal(mgr.stepGate(payload), undefined) // latch cleared
})

test('G2: dedupe — a second identical call while in flight merges (one review), still denied', () => {
  const mgr = new CheckpointManager(fakeCtx(), {})
  mgr.gate(makeExec('git push --force'))
  const record = mgr.bySession.get('s1')
  record.status = 'REVIEW_IN_FLIGHT'
  const second = mgr.gate(makeExec('git push --force'))
  assert.equal(second.kind, 'deny')
  assert.equal(record.mergedCalls, 1)
})

// ---------- G3: provider ownership ----------
test('G3: an existing userQuestions provider is never replaced', () => {
  const webProvider = { id: 'web-provider', ask: async () => ({ answers: [] }) }
  const mgr = new CheckpointManager(fakeCtx({ userQuestions: { provider: webProvider } }), {})
  mgr.registerPoProvider()
  assert.equal(mgr.userQuestions.provider, webProvider) // untouched
})

test('G3: dispose restores the provider slot only if it is still ours', () => {
  // 1) another provider replaces ours later (e.g. Web provider appears) — dispose must NOT clear it
  const uq = { provider: undefined }
  const mgr = new CheckpointManager(fakeCtx({ userQuestions: uq }), {})
  mgr.registerPoProvider()
  assert.equal(typeof uq.provider.ask, 'function')
  const later = { id: 'later-provider', ask: async () => ({ answers: [] }) }
  uq.provider = later
  mgr.dispose()
  assert.equal(uq.provider, later) // untouched

  // 2) dispose restores the slot when it is still ours (plugin unload cleanup)
  const uq2 = { provider: undefined }
  const mgr2 = new CheckpointManager(fakeCtx({ userQuestions: uq2 }), {})
  mgr2.registerPoProvider()
  assert.equal(typeof uq2.provider.ask, 'function')
  mgr2.dispose()
  assert.equal(uq2.provider, undefined) // restored
})

test('G3: with no provider, the plugin installs its own headless provider (file channel)', () => {
  const uq = { provider: undefined }
  const mgr = new CheckpointManager(fakeCtx({ userQuestions: uq }), {})
  mgr.registerPoProvider()
  assert.equal(typeof uq.provider.ask, 'function')
  // missing/unreadable answer file -> no answer (selected []) -> BLOCKED upstream
  return uq.provider.ask().then((answer) => {
    assert.deepEqual(answer.answers[0].selected, [])
  })
})
