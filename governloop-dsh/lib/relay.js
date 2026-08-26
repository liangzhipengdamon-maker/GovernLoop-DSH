// GovernLoop session-manager CLI client (the stable plugin<->core seam, AGE-61 §6.2).
// The plugin talks to core ONLY through governloop_session.py; it never
// re-implements checkpoint semantics, relay mechanics, or delivery confirmation.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const CHECKPOINT_TYPES = ['NEW_BLOCKER', 'UNEXPECTED_STATE', 'BEFORE_DESTRUCTIVE_ACTION', 'REVIEW_REQUIRED', 'FINAL_VERIFICATION']

/**
 * Resolve the session-manager executable (config > env > PATH).
 * P1 path-contract fix (AGE-65 Product Closure E2E, review round 2): the
 * session-manager path and the Neutral-Relay path MUST NOT share
 * GOVERLOOP_RELAY_PATH — that variable belongs exclusively to the Core session
 * manager's Neutral-Relay resolution. The session manager is resolved ONLY
 * from `sessionManagerPath` / `GOVERLOOP_SESSION_MANAGER_PATH`; `relayPath`
 * remains as a DEPRECATED plugin-config-ONLY alias (never the env var), so
 * legacy deployments keep working while GOVERLOOP_RELAY_PATH can never be
 * misread as the session manager.
 */
export function relayExecutable(config) {
  return (
    config.sessionManagerPath ||
    process.env.GOVERLOOP_SESSION_MANAGER_PATH ||
    config.relayPath || // legacy plugin-config alias only (never GOVERLOOP_RELAY_PATH)
    'governloop_session.py'
  )
}

/** Resolve the GovernLoop session state dir (config > env > /tmp). */
export function sessionStateDir(config) {
  return config.stateDir || process.env.GOVERLOOP_STATE_DIR || '/tmp'
}

/** Environment passed to every session-manager invocation (passed through, never overridden).
 *  The manager path is the spawn target and is NOT written back as an env var:
 *  writing it as GOVERLOOP_RELAY_PATH corrupted the child's Neutral-Relay
 *  lookup (the Core CLI reads that variable for neutral_relay.py) — P1
 *  path-contract collision fix. */
export function managerEnv(config) {
  const env = { ...process.env }
  if (config.stateDir) env.GOVERLOOP_STATE_DIR = config.stateDir
  if (config.cdpPort) env.GOVERLOOP_CDP_PORT = String(config.cdpPort)
  return env
}

/**
 * Run the session manager once. Resolves with exit code and captured output.
 * @param {string[]} args
 * @param {{ config: object, timeoutMs: number, signal?: AbortSignal, cwd?: string }} options
 */
export function runSessionManager(args, options) {
  const { config, timeoutMs = 600000, signal, cwd } = options
  return new Promise((resolve, reject) => {
    const child = spawn(relayExecutable(config), args, {
      env: managerEnv(config),
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`governloop session manager timed out after ${timeoutMs}ms: ${args[0]}`))
    }, timeoutMs)
    const onAbort = () => { clearTimeout(timer); child.kill('SIGKILL'); resolve({ code: null, stdout, stderr, aborted: true }) }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, aborted: false })
    })
  })
}

/**
 * Session-id extraction from the session manager's output.
 * P1 session-id contract fix (AGE-65 Product Closure E2E): accepts the
 * canonical Core CLI formats — `NEW session <id>` (new_session), `REUSE
 * session <id>` (resumed session), `session id: <id>` (status) — AND the
 * legacy uppercase `SESSION: <id>` used by the AGE-63 stub relay, so the
 * adapter parses whatever the real Core CLI emits.
 */
export function extractSessionId(stdout) {
  if (typeof stdout !== 'string') return null
  for (const line of stdout.split('\n')) {
    const m = /^\s*(?:SESSION|session id|NEW session|REUSE session)\s*:?\s+(\S+)/.exec(line)
    if (m) return m[1]
  }
  return null
}

/**
 * Ensure a GovernLoop session exists (status, else new). Returns the session id.
 * @param {object} config
 * @param {{ task?: string, signal?: AbortSignal }} [options]
 */
export async function ensureSession(config, options = {}) {
  const status = await runSessionManager(['status'], { config, timeoutMs: 15000, signal: options.signal, cwd: options.cwd })
  if (status.code === 0 && !status.aborted) {
    const id = extractSessionId(status.stdout)
    if (id) return id
  }
  const args = ['new']
  if (options.task) args.push('--title', options.task)
  const created = await runSessionManager(args, { config, timeoutMs: 30000, signal: options.signal, cwd: options.cwd })
  if (created.aborted) throw new Error('governloop session init cancelled')
  if (created.code === 3) {
    throw new Error('USER_CONVERSATION_SELECTION_REQUIRED: bind a ChatGPT conversation once per session (governloop bind <url>)')
  }
  if (created.code !== 0) {
    throw new Error(`governloop session init failed (exit ${created.code}): ${(created.stderr || created.stdout).slice(0, 400)}`)
  }
  const id = extractSessionId(created.stdout)
  if (!id) throw new Error('governloop session init returned no SESSION id')
  return id
}

export function responseFilePath(stateDir, sessionId, type, seq) {
  return path.join(stateDir, `governloop-response-${sessionId}-${type}-${seq}.md`)
}

/**
 * Send one review checkpoint (the whole GovernLoop review transport:
 * request file, relay, attachments, delivery confirmation, response file).
 * Resolves with the exit result and the response file path. NEVER auto-resends
 * (core forbids re-invocation after refusal/timeout).
 * @param {object} config
 * @param {{ sessionId: string, type: string, messageText: string, seq: number, signal?: AbortSignal }} input
 */
export async function sendCheckpoint(config, input) {
  if (!CHECKPOINT_TYPES.includes(input.type)) {
    throw new Error(`unknown checkpoint type ${input.type}`)
  }
  const stateDir = sessionStateDir(config)
  fs.mkdirSync(stateDir, { recursive: true })
  const requestFile = path.join(stateDir, `governloop-request-${input.sessionId}-${input.type}-${input.seq}.txt`)
  fs.writeFileSync(requestFile, input.messageText)
  const args = ['checkpoint', input.type, '--message-file', requestFile, '--session', input.sessionId]
  for (const a of config.attachPaths || []) args.push('--attach', a)
  const res = await runSessionManager(args, {
    config,
    timeoutMs: config.relayTimeoutMs ?? 600000,
    signal: input.signal,
  })
  return {
    res,
    responseFile: responseFilePath(stateDir, input.sessionId, input.type, input.seq),
  }
}
