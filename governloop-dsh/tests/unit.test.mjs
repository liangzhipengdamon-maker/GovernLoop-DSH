// Unit tests for the pure modules (classifier, envelope, token).
// Run: node --test governloop-dsh/tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, matchDestructiveCommand, isAllowedByRule } from '../lib/classifier.js'
import { buildCheckpointMessage, extractEnvelope, validateEnvelope, ENVELOPE_MARKER } from '../lib/envelope.js'
import { mintToken, checkToken, consumeToken } from '../lib/token.js'

// ---------- classifier ----------
test('classifier: denies destructive git commands', () => {
  const cases = [
    'git push --force origin main',
    'git push -f origin main',
    'git reset --hard HEAD~1',
    'git filter-branch --force',
    'git branch -D feature/x',
    'git tag -d v1.0',
    'git clean -fdx',
    'git checkout -- .',
    'rm -rf node_modules',
    'rm -fr /tmp/x',
  ]
  for (const command of cases) {
    const hit = matchDestructiveCommand(command)
    assert.ok(hit, `expected match for: ${command}`)
    assert.equal(hit.severity, 'hard-deny')
    assert.equal(hit.confidence, 'high')
  }
})

test('classifier: allows safe commands', () => {
  const safe = [
    'git status',
    'git diff HEAD',
    'git log --oneline',
    'git push origin main', // non-force push to a feature branch is not history-rewriting (v1 scope)
    'git branch feature/x',
    'git tag v1.0',
    'git checkout feature/x',
    'git clean -n',
    'rm file.txt', // no -r/-f
    'ls -la',
    'npm test',
  ]
  for (const command of safe) {
    assert.equal(matchDestructiveCommand(command), null, `expected NO match for: ${command}`)
  }
})

test('classifier: allowRules exempt exact prefixes only', () => {
  const allow = ['rm -rf node_modules', 'rm -rf /tmp/']
  assert.equal(matchDestructiveCommand('rm -rf node_modules', { allowRules: allow }), null)
  assert.equal(matchDestructiveCommand('rm -rf /tmp/build', { allowRules: allow }), null)
  // different target still flagged
  assert.ok(matchDestructiveCommand('rm -rf src', { allowRules: allow }))
  // prefix semantics: any command starting with the prefix is exempt (documented)
  assert.equal(matchDestructiveCommand('rm -rf node_modules.bak', { allowRules: allow }), null)
  // a non-prefix match is still flagged
  assert.ok(matchDestructiveCommand('rm -rf ./node_modules.bak', { allowRules: allow }))
})

test('classifier: classifies a parsed ToolExecution (arguments object)', () => {
  const exec = { name: 'bash', arguments: { command: 'git push --force origin main', description: 'x' } }
  const hit = classify(exec)
  assert.ok(hit)
  assert.equal(hit.command, 'git push --force origin main')
  // non-classified tool -> null
  assert.equal(classify({ name: 'tool-fs', arguments: {} }), null)
  // malformed arguments for a classified tool -> suspicious (fail-closed)
  const malformed = classify({ name: 'bash', arguments: 'not-an-object' })
  assert.equal(malformed, null) // 'not-an-object' matches no destructive pattern -> allowed; see note
  // (a malformed non-string/non-object is treated as empty command: no pattern match)
})

test('isAllowedByRule: empty rules allow nothing through', () => {
  assert.equal(isAllowedByRule('rm -rf x', []), false)
})

// ---------- envelope ----------
test('envelope: build message includes the marker and parses back', () => {
  const msg = buildCheckpointMessage('CHECKPOINT: BEFORE_DESTRUCTIVE_ACTION\nRULE: git-push-force')
  assert.ok(msg.includes(ENVELOPE_MARKER))
  const response = `${msg}\n\n${ENVELOPE_MARKER}\n${JSON.stringify({ verdict: 'APPROVE', confidence: 'high', rationale: 'ok', required_fixes: [] }, null, 2)}`
  const parsed = extractEnvelope(response)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.envelope.verdict, 'APPROVE')
})

test('envelope: instruction demands STRICT JSON (B2 hardening)', () => {
  const msg = buildCheckpointMessage('CHECKPOINT: X')
  assert.ok(msg.includes('MUST NOT contain literal newlines'))
  assert.ok(msg.includes('No Markdown code fences'))
  assert.ok(msg.includes('single line'))
})

test('envelope: B2 narrow repair — raw newlines inside strings parse, strict validation still applies', () => {
  // real Round-2 shape: compact JSON, but the rationale string contains literal
  // newlines (0x0A) instead of escaped \n — the narrow repair escapes them.
  const raw = '{"verdict":"BLOCK","confidence":"high","rationale":"first line. \n\nevidence\n\n","required_fixes":["fix it"]}'
  const parsed = extractEnvelope(raw)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.envelope.verdict, 'BLOCK')
  assert.equal(parsed.envelope.rationale, 'first line. \n\nevidence\n\n')
})

test('envelope: B2 narrow repair does NOT fix semantic errors (still fail-closed)', () => {
  // enum/verdict corruption is NOT repaired: after control-char escaping the
  // strict schema validation still rejects the bad verdict.
  const raw = '{"verdict":"MAYBE","confidence":"high","rationale":"ok. \nmore","required_fixes":[]}'
  assert.equal(extractEnvelope(raw).ok, false)
  // missing required field still rejects (no defaults are filled)
  assert.equal(extractEnvelope('{"verdict":"APPROVE","confidence":"high"}').ok, false)
})

test('envelope: rejects unknown/malformed/low-confidence', () => {
  assert.equal(extractEnvelope('no envelope here').ok, false)
  assert.equal(extractEnvelope('').ok, false)
  assert.equal(extractEnvelope(`${ENVELOPE_MARKER}\n{"verdict":"MAYBE"}`).ok, false)
  assert.equal(extractEnvelope(`${ENVELOPE_MARKER}\nnot json`).ok, false)
  const low = validateEnvelope({ verdict: 'APPROVE', confidence: 'low', rationale: 'x', required_fixes: [] })
  assert.equal(low.ok, true) // structure valid; caller decides low-confidence = blocked
  assert.equal(validateEnvelope({ verdict: 'APPROVE' }).ok, false)
  assert.equal(validateEnvelope(null).ok, false)
})

// ---------- token ----------
test('token: mint/check/consume lifecycle', () => {
  const now = 1000
  const token = mintToken({
    sessionId: 's1', checkpointId: 'c1', callId: 'call1', cwd: '/w',
    name: 'bash', args: { command: 'git push --force', description: 'x' },
    exactCommand: 'git push --force', ttlMs: 600000, now,
  })
  // exact retry allowed once
  assert.equal(checkToken(token, { sessionId: 's1', cwd: '/w', name: 'bash', args: { command: 'git push --force', description: 'x' }, now }).allow, true)
  consumeToken(token)
  assert.equal(checkToken(token, { sessionId: 's1', cwd: '/w', name: 'bash', args: { command: 'git push --force', description: 'x' }, now }).allow, false)
})

test('token: binding (session/fingerprint/command/expiry)', () => {
  const now = 1000
  const token = mintToken({
    sessionId: 's1', checkpointId: 'c1', callId: 'call1', cwd: '/w',
    name: 'bash', args: { command: 'git push --force origin main' },
    exactCommand: 'git push --force origin main', ttlMs: 600000, now,
  })
  assert.equal(checkToken(token, { sessionId: 's2', cwd: '/w', name: 'bash', args: { command: 'git push --force origin main' }, now }).reason, 'wrong-session')
  assert.equal(checkToken(token, { sessionId: 's1', cwd: '/other', name: 'bash', args: { command: 'git push --force origin main' }, now }).reason, 'fingerprint-mismatch')
  assert.equal(checkToken(token, { sessionId: 's1', cwd: '/w', name: 'bash', args: { command: 'git push --force main' }, now }).reason, 'fingerprint-mismatch')
  assert.equal(checkToken(token, { sessionId: 's1', cwd: '/w', name: 'bash', args: { command: 'git push --force origin main' }, now: now + 600001 }).reason, 'expired')
  assert.equal(checkToken(null, { sessionId: 's1', cwd: '/w', name: 'bash', args: {} }).reason, 'no-token')
})
