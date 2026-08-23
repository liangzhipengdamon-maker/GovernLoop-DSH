#!/usr/bin/env node
// Stub governloop_session.py — validates the plugin<->core CLI contract and
// writes a canned review envelope response file. NEVER talks to ChatGPT/CDP.
// Env knobs:
//   STUB_LOG         JSONL invocation log (assertions)
//   GOVERLOOP_STATE_DIR  response file location
//   STUB_SESSION     session id to echo (default 'e2e-session')
//   STUB_VERDICT     APPROVE | BLOCK | ADVISE (default APPROVE)
//   STUB_CONFIDENCE  high | medium | low (default high)
//   STUB_RELAY_EXIT  non-zero => 'checkpoint' fails (relay-failure scenario)
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const logFile = process.env.STUB_LOG || '/tmp/dsh-e2e/stub.log'
const stateDir = process.env.GOVERLOOP_STATE_DIR || '/tmp'
const session = process.env.STUB_SESSION || 'e2e-session'

function log(obj) {
  try { fs.appendFileSync(logFile, JSON.stringify(obj) + '\n') } catch { /* best-effort */ }
}

log({ cmd: args[0], args })

const cmd = args[0]

if (cmd === 'new') {
  console.log(`SESSION: ${session}`)
  process.exit(0)
}
if (cmd === 'status') {
  // no session yet -> non-zero tells the plugin to run `new`
  process.exit(0)
}
if (cmd === 'checkpoint') {
  const type = args[1]
  const mi = args.indexOf('--message-file')
  const mf = mi >= 0 ? args[mi + 1] : null
  const si = args.indexOf('--session')
  const sid = si >= 0 ? args[si + 1] : session
  const seq = process.env.STUB_SEQ || '1'
  const out = path.join(stateDir, `governloop-response-${sid}-${type}-${seq}.md`)
  const msg = mf && fs.existsSync(mf) ? fs.readFileSync(mf, 'utf8') : ''
  log({ responseFile: out, messageHead: msg.slice(0, 200), messageHasEnvelopeMarker: msg.includes('REVIEW_ENVELOPE:') })
  if (process.env.STUB_RELAY_EXIT && process.env.STUB_RELAY_EXIT !== '0') {
    console.error('stub relay failure (STUB_RELAY_EXIT)')
    process.exit(Number(process.env.STUB_RELAY_EXIT))
  }
  const verdict = process.env.STUB_VERDICT || 'APPROVE'
  const confidence = process.env.STUB_CONFIDENCE || 'high'
  const envelope = {
    verdict,
    confidence,
    rationale: 'stub rationale: reviewed the destructive action',
    required_fixes: verdict === 'BLOCK' ? ['do not run the destructive action'] : [],
  }
  fs.writeFileSync(out, `# GovernLoop review response\n\nREVIEW_ENVELOPE:\n${JSON.stringify(envelope, null, 2)}\n`)
  console.log(`CHECKPOINT: ${type}`)
  console.log(`SESSION: ${sid}`)
  console.log('RESPONSE (head): ' + JSON.stringify({ verdict }).slice(0, 80))
  process.exit(0)
}
if (cmd === 'end') {
  process.exit(0)
}

console.error(`stub: unknown command ${cmd}`)
process.exit(1)
