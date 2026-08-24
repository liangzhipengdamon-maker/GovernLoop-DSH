// AGE-65 Product Closure E2E — real-environment bridge closure (S1/S2/S3).
// Uses main's governloop-dsh AS-IS (no code changes) with the REAL Neutral
// Relay (session CLI -> neutral_relay.py -> CDP -> ChatGPT Web), a REAL bound
// ChatGPT conversation (the GovernLoop GPT discussion), and a REAL attachment.
//
// Scenarios (GPT-finalized scope, docs/verification report):
//   bridge-closure   (S1+S2) — deny -> real review send -> real read-back ->
//                     valid envelope -> PO approve -> token -> exact retry once
//   po-decline-real  (S3b)   — review sent, PO declines -> BLOCKED, no retry
//   relay-fail-real  (S3a)   — session-manager relay exits 1 -> FAILED, no retry
//   attach-missing-real (S3c) — refused attachment -> FAILED, no send
//
// Env: DSH_BIN (pinned dsh), GOVERLOOP_SESSION_CLI (governloop_session.py path),
//      GOVERLOOP_CONVERSATION_URL (bound GPT conversation URL)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '../..')
const DSH_BIN = process.env.DSH_BIN
if (!DSH_BIN) { console.error('DSH_BIN required'); process.exit(2) }
const SESSION_CLI = process.env.GOVERLOOP_SESSION_CLI
if (!SESSION_CLI) { console.error('GOVERLOOP_SESSION_CLI required'); process.exit(2) }
const CONV_URL = process.env.GOVERLOOP_CONVERSATION_URL
if (!CONV_URL) { console.error('GOVERLOOP_CONVERSATION_URL required'); process.exit(2) }

const HARNESS = path.join(REPO, 'governloop-dsh/tests/harness')
const DRIVER = path.join(HARNESS, 'scripted-adapter.mjs')
const RUNNER = path.join(HARNESS, 'e2e-runner.mjs')
const PLUGIN = path.join(REPO, 'governloop-dsh/lib/index.js')
const BROKEN_RELAY = path.join(__dirname, 'broken-relay.sh')
const SESSION_WRAPPER = path.join(__dirname, 'session-manager-wrapper.sh')

const GOSSIP = path.join(__dirname, 'e2e-summary.jsonl')

function say(obj) {
  const line = JSON.stringify(obj) + '\n'
  fs.appendFileSync(GOSSIP, line)
  console.log('[pce]', JSON.stringify(obj).slice(0, 500))
}

/** Pre-bind the GovernLoop session for cwd: `new` via the REAL CLI, then set
 *  the conversation URL in temp state (bypasses `bind`'s /c/-only URL guard —
 *  a CLI input-validation limitation, not bridge semantics; documented). */
function prebind(ws, stateDir) {
  const env = { ...process.env, GOVERLOOP_STATE_DIR: stateDir, GOVERLOOP_CDP_PORT: '9233' }
  const r = spawnSync('python3', [SESSION_CLI, 'new', '--title', 'a65 product closure e2e'], { cwd: ws, env, encoding: 'utf8' })
  // `new` creates the session and then exits 3 (USER_CONVERSATION_SELECTION_REQUIRED)
  // when no conversation URL is bound yet — the session state IS written.
  const out = (r.stdout || '') + (r.stderr || '')
  if (!(r.status === 0 || r.status === 3) || !out.includes('NEW session')) {
    throw new Error(`session new failed (exit ${r.status}): ${out}`)
  }
  const states = fs.readdirSync(stateDir).filter((f) => f.startsWith('governloop-session-') && f.endsWith('.json'))
  if (states.length !== 1) throw new Error(`expected 1 session state, got ${states.length}`)
  const p = path.join(stateDir, states[0])
  const s = JSON.parse(fs.readFileSync(p, 'utf8'))
  s.conversation_url = CONV_URL
  s.cdp_port = 9233
  fs.writeFileSync(p, JSON.stringify(s, null, 2))
  say({ id: 'prebind', sessionId: s.session_id, repo: s.repo })
  return s
}

const scenarios = [
  { name: 'bridge-closure',   po: 'approve', expectRetry: true,  attach: 'evidence.txt',        expectEvent: 'token-allowed',   expectZero: true,  runnerTimeoutMs: 300000 },
  { name: 'po-decline-real',  po: 'decline', expectRetry: false, attach: 'evidence.txt',        expectEvent: 'po-not-approved', expectZero: false, runnerTimeoutMs: 20000 },
  { name: 'relay-fail-real',  po: 'approve', expectRetry: false, attach: null,  brokenRelay: true, expectEvent: 'failed',       expectZero: false, runnerTimeoutMs: 20000 },
  { name: 'attach-missing-real', po: 'approve', expectRetry: false, attach: 'missing.txt',      expectEvent: 'failed',          expectZero: false, runnerTimeoutMs: 20000 },
]

let failures = 0

for (const scenario of scenarios) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pce-'))
  const ws = path.join(scratch, 'ws')
  const home = path.join(scratch, 'home')
  const stateDir = path.join(scratch, 'state')
  const pluginLog = path.join(scratch, 'plugin.log')
  const poAnswerFile = path.join(scratch, 'po-answer.txt')
  const e2eOut = path.join(scratch, 'e2e.jsonl')
  fs.mkdirSync(ws); fs.mkdirSync(home); fs.mkdirSync(stateDir)
  spawnSync('git', ['init', '-q'], { cwd: ws }) // no remote -> allowed retry fails fast, harmless
  fs.writeFileSync(poAnswerFile, scenario.po)
  if (scenario.attach === 'evidence.txt') {
    fs.writeFileSync(path.join(ws, 'evidence.txt'),
      'E2E evidence: commit plan for the scratch governance test repo (no real changes; no secrets).\n')
  }

  let sessionId = null
  if (!scenario.brokenRelay) sessionId = prebind(ws, stateDir).sessionId

  const overlay = path.join(scratch, 'overlay.yml')
  const attachCfg = scenario.attach
    ? `        attachPaths: ['${path.join(ws, scenario.attach)}']`
    : ''
  const relayCfg = scenario.brokenRelay
    ? `        sessionManagerPath: '${BROKEN_RELAY}'`
    : ''
  fs.writeFileSync(overlay, [
    '- id: agent-default-model',
    '  config:',
    '    provider: mock',
    '    model: mock-1',
    '',
    '- insert:',
    '    - id: governloop-dsh',
    `      name: '${PLUGIN}'`,
    '      config:',
    `        stateDir: '${stateDir}'`,
    `        debugOut: '${pluginLog}'`,
    `        poAnswerFile: '${poAnswerFile}'`,
    '        tokenTtlMs: 600000',
    ...(attachCfg ? [attachCfg] : []),
    ...(relayCfg ? [relayCfg] : []),
    '',
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: !!js dshHomePath('sessions')",
    '    compression: none',
    '',
    '- id: session-title-llm',
    '  disabled: true',
    '',
    '- id: headless-runner',
    '  disabled: true',
    '',
    '- insert:',
    '    - id: e2e-runner',
    `      name: '${RUNNER}'`,
    '      config:',
    "        task: 'run e2e'",
    '',
    '- insert:',
    '    - id: e2e-driver',
    `      name: '${DRIVER}'`,
    '',
  ].join('\n'))

  const env = {
    ...process.env,
    DSH_HOME: home,
    GOVERLOOP_STATE_DIR: stateDir,
    GOVERLOOP_CDP_PORT: '9233',
    // plugin resolves the session manager via GOVERLOOP_SESSION_MANAGER_PATH
    // (new contract) unless the overlay config sessionManagerPath overrides it
    // (brokenRelay scenario); the wrapper execs the real CLI via python3 (the
    // CLI script lacks the execute bit). GOVERLOOP_RELAY_PATH is intentionally
    // NOT set — it belongs to Core's Neutral-Relay resolution (RELAY_DEFAULT).
    ...(scenario.brokenRelay ? {} : { GOVERLOOP_SESSION_MANAGER_PATH: SESSION_WRAPPER, GOVERLOOP_SESSION_CLI: SESSION_CLI }),
    E2E_OUT: e2eOut,
    DSH_PKG_ROOT: path.resolve(path.dirname(DSH_BIN), '../../node_modules/@deepseek-ai'),
    E2E_RUNNER_TIMEOUT_MS: String(scenario.runnerTimeoutMs),
    ...(scenario.expectRetry ? { E2E_EXPECT_RETRY: '1' } : {}),
  }

  const t0 = Date.now()
  const run = spawnSync(DSH_BIN, ['--profile', 'headless', '--patch', overlay, 'run e2e'], {
    cwd: ws, env, encoding: 'utf8', timeout: 900000,
  })
  const dt = Date.now() - t0

  const stdout = (run.stdout || '') + (run.stderr || '')
  const pluginLogText = fs.existsSync(pluginLog) ? fs.readFileSync(pluginLog, 'utf8') : ''
  const e2eText = fs.existsSync(e2eOut) ? fs.readFileSync(e2eOut, 'utf8') : ''
  const e2e = e2eText.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const plugin = pluginLogText.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const pluginEvents = plugin.map((p) => p.event)
  const adapterRequests = e2e.filter((e) => e.id === 'adapter-request').length

  // session-manager / relay delivery evidence (real scenarios only)
  let mgrOut = ''
  if (!scenario.brokenRelay && sessionId) {
    const p = path.join(stateDir, `governloop-session-${sessionId}.json`)
    if (fs.existsSync(p)) {
      try {
        const s = JSON.parse(fs.readFileSync(p, 'utf8'))
        mgrOut = (s.checkpoints || []).map((c) => c.type).join(',')
      } catch { /* ignore */ }
    }
  }
  const stateFiles = fs.readdirSync(stateDir) // response file is .md, not .json

  function assert(cond, label, detail) {
    if (cond) { console.log(`  ✔ ${label}`) } else {
      failures++
      console.log(`  ✖ ${label}${detail ? ' — ' + detail : ''}`)
    }
  }
  const event = (name) => pluginEvents.includes(name)

  console.log(`\n== scenario ${scenario.name} (exit ${run.status}, ${Math.round(dt / 1000)}s) ==`)
  say({ id: 'scenario', name: scenario.name, exit: run.status, ms: dt, events: pluginEvents, adapterRequests })

  assert(run.status !== null, 'dsh process ran (no spawn crash)')
  if (scenario.expectZero) {
    assert(run.status === 0, `exit 0 (got ${run.status})`)
    assert(stdout.includes('E2E-COMPLETE'), 'runner printed E2E-COMPLETE')
    assert(adapterRequests === 3, `adapter requests == 3 (got ${adapterRequests}) — full loop ran`)
    for (const ev of ['gate-deny', 'review-started', 'review-received', 'po-approved', 'token-minted', 'verdict-injected', 'token-allowed']) {
      assert(event(ev), `plugin lifecycle: ${ev}`, JSON.stringify(pluginEvents))
    }
    const allowed = plugin.find((p) => p.event === 'token-allowed')
    assert(!!allowed, 'token consumed on the exact retry')
    const respFiles = stateFiles.filter((f) => f.includes('-response-'))
    const respPath = stateFiles.map((f) => path.join(stateDir, f)).find((p) => p.includes('-response-'))
    if (respPath) {
      const text = fs.readFileSync(respPath, 'utf8')
      assert(/"verdict":\s*"(APPROVE|BLOCK|ADVISE)"/.test(text), 'response file contains a review envelope', text.slice(0, 300))
      say({ id: 'response-head', file: path.basename(respPath), head: text.slice(0, 500) })
    } else {
      assert(false, 'response file exists', JSON.stringify(stateFiles))
    }
  } else {
    assert(run.status !== 0, `exit != 0 (got ${run.status}) — no completed run`)
    assert(!stdout.includes('E2E-COMPLETE'), 'no E2E-COMPLETE')
    assert(adapterRequests === 1, `adapter requests == 1 (got ${adapterRequests}) — NO retry (action stayed blocked)`)
    assert(event('gate-deny'), 'plugin lifecycle: gate-deny', JSON.stringify(pluginEvents))
    if (scenario.name === 'po-decline-real') {
      // GPT reply quality varies (truncated generation observed): either the
      // envelope parsed and PO declined (po-not-approved) or the reply was
      // truncated/malformed and failed fail-closed ('failed'). Both keep the
      // action blocked with no retry, which is the scenario's intent.
      assert(event('po-not-approved') || event('failed'), 'plugin lifecycle: po-not-approved OR failed (fail-closed)', JSON.stringify(pluginEvents))
    } else {
      assert(event(scenario.expectEvent), `plugin lifecycle: ${scenario.expectEvent}`, JSON.stringify(pluginEvents))
    }
  }
  console.log(`  artifacts: ${scratch}`)
}

console.log(`\n${failures === 0 ? 'ALL PRODUCT CLOSURE E2E SCENARIOS PASS' : `${failures} E2E ASSERTION(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
