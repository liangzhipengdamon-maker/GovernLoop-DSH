// GovernLoop session-manager CLI client (the stable plugin<->core seam, AGE-61 §6.2).
// The plugin talks to core ONLY through governloop_session.py; it never
// re-implements checkpoint semantics, relay mechanics, or delivery confirmation.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const CHECKPOINT_TYPES = ['NEW_BLOCKER', 'UNEXPECTED_STATE', 'BEFORE_DESTRUCTIVE_ACTION', 'REVIEW_REQUIRED', 'FINAL_VERIFICATION']

/** Resolve the session-manager executable (config > env > PATH). */
export function relayExecutable(config) {
  return config.relayPath || process.env.GOVERLOOP_RELAY_PATH || 'governloop_session.py'
}

/** Resolve the GovernLoop session state dir (config > env > /tmp). */
export function sessionStateDir(config) {
  return config.stateDir || process.env.GOVERLOOP_STATE_DIR || '/tmp'
}

/** Environment passed to every session-manager invocation (passed through, never overridden). */
export function managerEnv(config) {
  const env = { ...process.env }
  if (config.relayPath) env.GOVERLOOP_RELAY_PATH = config.relayPath
  if (config.stateDir) env.GOVERLOOP_STATE_DIR = config.stateDir
  if (config.cdpPort) env.GOVERLOOP_CDP_PORT = String(config.cdpPort)
  return env
}

/**
 * Run the session manager once. Resolves with exit code and captured output.
 * @param {string[]} args
 * @param {{ config: object, timeoutMs: number, signal?: AbortSignal }} options
 */
export function runSessionManager(args, options) {
  const { config, timeoutMs = 600000, signal } = options
  return new Promise((resolve, reject) => {
    const child = spawn(relayExecutable(config), args, {
      env: managerEnv(config),
      stdio: ['ignore', 'pipe', 'pipe'],
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

export function extractSessionId(stdout) {
  const m = /SESSION:\s*(\S+)/.exec(stdout || '')
  return m ? m[1] : null
}

/**
 * Ensure a GovernLoop session exists (status, else new). Returns the session id.
 * @param {object} config
 * @param {{ task?: string, signal?: AbortSignal }} [options]
 */
export async function ensureSession(config, options = {}) {
  const status = await runSessionManager(['status'], { config, timeoutMs: 15000, signal: options.signal })
  if (status.code === 0 && !status.aborted) {
    const id = extractSessionId(status.stdout)
    if (id) return id
  }
  const args = ['new']
  if (options.task) args.push('--title', options.task)
  const created = await runSessionManager(args, { config, timeoutMs: 30000, signal: options.signal })
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
