// New-session URL binding (issue #27) — manager-level tests:
//   B1 ask once on an unbound session, bind via the session CLI
//   B2 already-bound session → no ask
//   B3 declined (Skip) → no bind; no re-ask on a second session-start
//   B4 sessionStartBind:false → no ask
//   B5 ask throws → no bind, no crash
// The session manager is a stub executable emulating the real CLI's status /
// new / bind output contract (status: `session id:` + `conversation: bound:
// yes|no`; new: `NEW session <id>` + exit 3 USER_CONVERSATION_SELECTION_REQUIRED;
// bind: exit 0). Run: node --test governloop-dsh/tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CheckpointManager } from '../lib/checkpoint.js'

const STUB = `#!/bin/sh
set -eu
STUB_LOG="\${STUB_LOG:-}"
log() { [ -n "$STUB_LOG" ] && printf '%s\\n' "$*" >> "$STUB_LOG"; }
case "\${1:-}" in
  status)
    log "status"
    if [ -n "\${STUB_SID:-}" ]; then
      printf 'session id:      %s\\n' "$STUB_SID"
      printf 'conversation:    bound: %s\\n' "\${STUB_BOUND:-no}"
    else
      printf 'no active session\\n'
    fi
    exit 0
    ;;
  new)
    log "new"
    printf 'NEW session SID-NEW-1 (repo=stub task=stub src=title)\\n'
    printf 'USER_CONVERSATION_SELECTION_REQUIRED\\n'
    exit 3
    ;;
  bind)
    log "bind $2"
    printf 'BOUND %s\\n' "$2"
    exit 0
    ;;
  *)
    log "unknown $*"
    exit 2
    ;;
esac
`

function makeStub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-bind-stub-'))
  const stub = path.join(dir, 'session-manager-stub.sh')
  const log = path.join(dir, 'calls.log')
  fs.writeFileSync(stub, STUB, { mode: 0o755 })
  // The stub reads STUB_LOG from its environment (managerEnv passes process.env).
  process.env.STUB_LOG = log
  return { stub, log, dir }
}

function makeAgent(cwd) {
  return { id: 's1', session: { id: 's1', header: { cwd } } }
}

function makeCtx(askImpl) {
  const asks = []
  return {
    asks,
    userQuestions: {
      provider: { /* native provider present */ },
      async ask(input) {
        asks.push(input)
        return typeof askImpl === 'function' ? askImpl(input) : { answers: [] }
      },
    },
  }
}

function makeManager(stub, ctx, extra = {}) {
  return new CheckpointManager(ctx, {
    sessionManagerPath: stub.stub,
    debugOut: '',
    ...extra,
  })
}

function readCalls(stub) {
  if (!fs.existsSync(stub.log)) return []
  const text = fs.readFileSync(stub.log, 'utf8').trim()
  return text === '' ? [] : text.split('\n')
}

test('B1: unbound session → ask once → custom URL → session CLI binds it', async () => {
  const stub = makeStub()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-bind-cwd-'))
  const ctx = makeCtx(() => ({
    answers: [{ id: 'governloop-bind-url', selected: [], custom: 'https://chatgpt.com/g/g-x/c/conv-1' }],
  }))
  const mgr = makeManager(stub, ctx)
  await mgr.onSessionStart(makeAgent(cwd))
  assert.equal(ctx.asks.length, 1, 'asked exactly once')
  assert.equal(ctx.asks[0].questions[0].id, 'governloop-bind-url')
  assert.deepEqual(readCalls(stub), ['status', 'new', 'bind https://chatgpt.com/g/g-x/c/conv-1'])
})

test('B2: already-bound session → no ask, no bind', async () => {
  const stub = makeStub()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-bind-cwd-'))
  const ctx = makeCtx(() => { throw new Error('ask must not be called') })
  const mgr = makeManager(stub, ctx, {})
  process.env.STUB_SID = 'SID-BOUND'
  process.env.STUB_BOUND = 'yes'
  try {
    await mgr.onSessionStart(makeAgent(cwd))
  } finally {
    delete process.env.STUB_SID
    delete process.env.STUB_BOUND
  }
  assert.equal(ctx.asks.length, 0, 'no ask for a bound session')
  assert.deepEqual(readCalls(stub), ['status'])
})

test('B3: declined (Skip) → no bind; second session-start → no re-ask', async () => {
  const stub = makeStub()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-bind-cwd-'))
  const ctx = makeCtx(() => ({ answers: [{ id: 'governloop-bind-url', selected: ['Skip (stay unbound)'], custom: '' }] }))
  const mgr = makeManager(stub, ctx)
  await mgr.onSessionStart(makeAgent(cwd))
  await mgr.onSessionStart(makeAgent(cwd))
  assert.equal(ctx.asks.length, 1, 'asked once despite two session-starts')
  assert.deepEqual(readCalls(stub), ['status'], 'no bind after decline')
})

test('B4: sessionStartBind:false → no ask', async () => {
  const stub = makeStub()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-bind-cwd-'))
  const ctx = makeCtx(() => { throw new Error('ask must not be called') })
  const mgr = makeManager(stub, ctx, { sessionStartBind: false })
  await mgr.onSessionStart(makeAgent(cwd))
  assert.equal(ctx.asks.length, 0)
  assert.deepEqual(readCalls(stub), [], 'disabled: no probe, no bind')
})

test('B5: ask throws → no bind, no crash', async () => {
  const stub = makeStub()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-bind-cwd-'))
  const ctx = makeCtx(() => { throw new Error('NO_PROVIDER') })
  const mgr = makeManager(stub, ctx)
  await mgr.onSessionStart(makeAgent(cwd)) // must not reject
  assert.deepEqual(readCalls(stub), ['status'], 'no bind when the ask fails')
})
