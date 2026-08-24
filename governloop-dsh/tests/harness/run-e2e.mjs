// Keyless headless E2E for the BEFORE_DESTRUCTIVE_ACTION vertical slice
// (AGE-61 §8 + §9 test plan). Three scenarios:
//   approve    — review APPROVE + PO approve → one-shot token → exact retry once → E2E-COMPLETE
//   po-decline — review APPROVE + PO decline → blocked, no retry, latch held
//   relay-fail — stub relay exits 1 → FAILED, no auto-resend, latch held
//
// The REAL agent loop runs against a scripted mock adapter (no model, no keys),
// the REAL plugin under test, a scratch workspace (git init, NO remote — the
// allowed retry runs `git push --force` here and fails fast, harmlessly).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '../../..')
// No machine-specific default: the harness requires the pinned dsh binary via
// env (see README "Tests"). Keeps the repo free of absolute local paths.
const DSH_BIN = process.env.DSH_BIN
if (!DSH_BIN) {
  console.error('DSH_BIN is required: point it at the pinned @deepseek-ai/dsh binary (see governloop-dsh/README.md "Tests")')
  process.exit(2)
}
const STUB_RELAY = path.join(__dirname, 'stub-relay.mjs')
const DRIVER = path.join(__dirname, 'scripted-adapter.mjs')
const RUNNER = path.join(__dirname, 'e2e-runner.mjs')
const PLUGIN = path.join(REPO, 'governloop-dsh/lib/index.js')

function scenarioName(s) { return s.name.padEnd(11) }

const scenarios = [
  { name: 'approve', env: { STUB_VERDICT: 'APPROVE', STUB_CONFIDENCE: 'high', PO_ANSWER: 'approve', E2E_EXPECT_RETRY: '1' }, expectEvent: 'token-allowed' },
  { name: 'po-decline', env: { STUB_VERDICT: 'APPROVE', PO_ANSWER: 'decline' }, expectEvent: 'po-not-approved' },
  { name: 'relay-fail', env: { STUB_RELAY_EXIT: '1' }, expectEvent: 'failed' },
  { name: 'envelope-invalid', env: { STUB_ENVELOPE_MALFORMED: '1', PO_ANSWER: 'approve' }, expectEvent: 'failed' },
  { name: 'po-malformed', env: { STUB_VERDICT: 'APPROVE', PO_ANSWER: 'garbage-not-approve' }, expectEvent: 'po-not-approved' },
]

let failures = 0

for (const scenario of scenarios) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-'))
  const ws = path.join(scratch, 'ws')
  const home = path.join(scratch, 'home')
  const stateDir = path.join(scratch, 'state')
  const pluginLog = path.join(scratch, 'plugin.log')
  const poAnswerFile = path.join(scratch, 'po-answer.txt')
  fs.writeFileSync(poAnswerFile, scenario.env.PO_ANSWER || 'approve')
  const stubLog = path.join(scratch, 'stub.log')
  const e2eOut = path.join(scratch, 'e2e.jsonl')
  fs.mkdirSync(ws); fs.mkdirSync(home); fs.mkdirSync(stateDir)
  spawnSync('git', ['init', '-q'], { cwd: ws }) // no remote -> retry fails fast, harmless

  const overlay = path.join(scratch, 'overlay.yml')
  fs.writeFileSync(overlay, [
    '- id: agent-default-model',
    '  config:',
    '    provider: mock',
    '    model: mock-1',
    '',
    '- insert:',
    `    - id: governloop-dsh`,
    `      name: '${PLUGIN}'`,
    '      config:',
    `        sessionManagerPath: '${STUB_RELAY}'`,
    `        stateDir: '${stateDir}'`,
    `        debugOut: '${pluginLog}'`,
    `        poAnswerFile: '${poAnswerFile}'`,
    '        tokenTtlMs: 600000',
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
    `    - id: e2e-runner`,
    `      name: '${RUNNER}'`,
    '      config:',
    "        task: 'run e2e'",
    '',
    '- insert:',
    `    - id: e2e-driver`,
    `      name: '${DRIVER}'`,
    '',
  ].join('\n'))

  const env = {
    ...process.env,
    DSH_HOME: home,
    GOVERLOOP_STATE_DIR: stateDir,
    GOVERLOOP_SESSION_MANAGER_PATH: STUB_RELAY,
    STUB_LOG: stubLog,
    E2E_OUT: e2eOut,
    DSH_PKG_ROOT: path.resolve(path.dirname(DSH_BIN), '../../node_modules/@deepseek-ai'),
    E2E_RUNNER_TIMEOUT_MS: '6000',
    ...scenario.env,
  }

  const run = spawnSync(DSH_BIN, ['--profile', 'headless', '--patch', overlay, 'run e2e'], {
    cwd: ws,
    env,
    encoding: 'utf8',
    timeout: 120000,
  })

  const stdout = (run.stdout || '') + (run.stderr || '')
  const pluginLogText = fs.existsSync(pluginLog) ? fs.readFileSync(pluginLog, 'utf8') : ''
  const stubLogText = fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8') : ''
  const e2eText = fs.existsSync(e2eOut) ? fs.readFileSync(e2eOut, 'utf8') : ''
  const e2e = e2eText.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const stub = stubLogText.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const plugin = pluginLogText.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const pluginEvents = plugin.map((p) => p.event)
  const adapterRequests = e2e.filter((e) => e.id === 'adapter-request').length
  const checkpointCalls = stub.filter((s) => s.cmd === 'checkpoint').length

  function assert(cond, label, detail) {
    if (cond) { console.log(`  ✔ ${label}`) } else {
      failures++
      console.log(`  ✖ ${label}${detail ? ' — ' + detail : ''}`)
    }
  }
  const event = (name) => pluginEvents.includes(name)

  console.log(`\n== scenario ${scenarioName(scenario)} (exit ${run.status}) ==`)
  assert(run.status !== null, 'dsh process ran (no spawn crash)')
  if (scenario.name === 'approve') {
    assert(run.status === 0, `exit 0 (got ${run.status})`)
    assert(stdout.includes('E2E-COMPLETE'), 'runner printed E2E-COMPLETE')
    assert(adapterRequests === 3, `adapter requests == 3 (got ${adapterRequests}) — full loop ran`)
    for (const ev of ['gate-deny', 'review-started', 'review-received', 'po-approved', 'token-minted', 'verdict-injected', 'token-allowed']) {
      assert(event(ev), `plugin lifecycle: ${ev}`, JSON.stringify(pluginEvents))
    }
    assert(checkpointCalls === 1, `relay invoked exactly once (got ${checkpointCalls}) — no resend`)
    const allowed = plugin.find((p) => p.event === 'token-allowed')
    assert(!!allowed, 'token consumed on the exact retry')
  } else {
    assert(run.status !== 0, `exit != 0 (got ${run.status}) — no completed run`)
    assert(!stdout.includes('E2E-COMPLETE'), 'no E2E-COMPLETE')
    assert(adapterRequests === 1, `adapter requests == 1 (got ${adapterRequests}) — NO retry (action stayed blocked)`)
    assert(checkpointCalls === 1, `relay invoked exactly once (got ${checkpointCalls}) — no auto-resend`)
    assert(event('gate-deny'), 'plugin lifecycle: gate-deny', JSON.stringify(pluginEvents))
    const expect = scenario.expectEvent
    assert(event(expect), `plugin lifecycle: ${expect} (best-effort; pipeline may outlive runner exit)`, JSON.stringify(pluginEvents))
  }
  console.log(`  artifacts: ${scratch}`)
}

console.log(`\n${failures === 0 ? 'ALL E2E SCENARIOS PASS' : `${failures} E2E ASSERTION(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
