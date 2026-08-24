// Unit tests for the adapter↔Core CLI contract (AGE-65 Product Closure fix).
//   P1a — extractSessionId accepts the canonical Core CLI output formats
//         (NEW session / REUSE session / session id:) PLUS the legacy
//         uppercase SESSION: format used by the AGE-63 stub relay.
//   P1c — runSessionManager captures child stderr so failure propagation
//         (checkpoint.js `stderr || stdout`) actually has stderr to show.
// Run: node --test governloop-dsh/tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractSessionId, managerEnv, relayExecutable, runSessionManager } from '../lib/relay.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('relayExecutable: GOVERLOOP_RELAY_PATH is NEVER selected as the session manager (P1)', () => {
  const prev = process.env.GOVERLOOP_RELAY_PATH
  try {
    process.env.GOVERLOOP_RELAY_PATH = '/opt/neutral_relay.py'
    delete process.env.GOVERLOOP_SESSION_MANAGER_PATH
    // the Neutral-Relay-only env var must not be misread as the session manager
    assert.equal(relayExecutable({}), 'governloop_session.py')
  } finally {
    if (prev === undefined) delete process.env.GOVERLOOP_RELAY_PATH
    else process.env.GOVERLOOP_RELAY_PATH = prev
  }
})

test('relayExecutable/managerEnv: legacy config.relayPath fallback never touches GOVERLOOP_RELAY_PATH (P1)', () => {
  const prev = process.env.GOVERLOOP_RELAY_PATH
  try {
    process.env.GOVERLOOP_RELAY_PATH = '/opt/neutral_relay.py' // Core-owned, must pass through untouched
    const config = { relayPath: '/legacy/governloop_session.py' }
    // legacy plugin-config fallback still resolves the session manager...
    assert.equal(relayExecutable(config), '/legacy/governloop_session.py')
    // ...and managerEnv() preserves the existing Core-owned relay variable verbatim
    const env = managerEnv(config)
    assert.equal(env.GOVERLOOP_RELAY_PATH, '/opt/neutral_relay.py')
    assert.equal(Object.hasOwn(env, 'GOVERLOOP_SESSION_MANAGER_PATH'), false)
  } finally {
    if (prev === undefined) delete process.env.GOVERLOOP_RELAY_PATH
    else process.env.GOVERLOOP_RELAY_PATH = prev
  }
})

// Canonical formats taken from GovernLoop core governloop_session.py:
//   new_session:   f"NEW session {sid} (repo=… task=… src=…)"        (line 250)
//   reuse:         f"REUSE session {sid} (repo=… task=… src=…)"      (line 235)
//   status_text:   f"session id:      {sid}"                         (line 519)
test('extractSessionId: canonical Core CLI formats (P1 session-id contract)', () => {
  assert.equal(
    extractSessionId('NEW session WS-A65-PRODUCT-CLOSURE-E2E-2026-08-24 (repo=ws task=A65-PRODUCT-CLOSURE-E2E src=title)'),
    'WS-A65-PRODUCT-CLOSURE-E2E-2026-08-24',
  )
  assert.equal(
    extractSessionId('REUSE session TMP-X-2026-08-24 (repo=x task=y src=z)'),
    'TMP-X-2026-08-24',
  )
  assert.equal(
    extractSessionId('repo:            ws\ntask:            T (src: title)\nsession id:      WS-ABC-2026-08-24\nconversation:    bound: yes'),
    'WS-ABC-2026-08-24',
  )
})

test('extractSessionId: legacy stub SESSION: format still accepted (AGE-63 stub compat)', () => {
  assert.equal(extractSessionId('SESSION: e2e-session'), 'e2e-session')
  assert.equal(extractSessionId('REVIEW_REQUEST_ID: x\nSESSION: e2e-session\n'), 'e2e-session')
})

test('extractSessionId: no session id -> null', () => {
  assert.equal(extractSessionId(''), null)
  assert.equal(extractSessionId('nothing here'), null)
  assert.equal(extractSessionId('CHECKPOINT: BEFORE_DESTRUCTIVE_ACTION\nREVIEW_REQUEST_ID: x'), null)
  assert.equal(extractSessionId(undefined), null)
  assert.equal(extractSessionId(null), null)
})

test('runSessionManager: captures child stderr for failure propagation (P1c)', async () => {
  const stub = path.join(__dirname, 'fixtures', 'stderr-exit1.mjs')
  const res = await runSessionManager([stub], {
    config: { sessionManagerPath: process.execPath },
    timeoutMs: 5000,
  })
  assert.equal(res.code, 1)
  assert.equal(res.aborted, false)
  assert.match(res.stderr, /stub failure on stderr/)
  // checkpoint.js composes relay failures as `stderr || stdout`; the seam must
  // hand back stderr so that composition can surface the real traceback.
  assert.equal((res.stderr || res.stdout).includes('stub failure on stderr'), true)
})
