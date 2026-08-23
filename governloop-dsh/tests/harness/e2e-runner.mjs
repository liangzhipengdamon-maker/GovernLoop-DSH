// E2E test runner — replaces the stock headless-runner for the AGE-63 E2E.
// The stock runner waits for a single quiescence and exits; the governloop
// review is asynchronous, so the approve path (deny → latch → review → PO →
// token → followup → retry → complete) needs a runner that keeps polling the
// session until completion (or a settled block / timeout).
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The DSH packages live in the pinned npx install (see run-e2e DSH_PKG_ROOT).
const PKG_ROOT = process.env.DSH_PKG_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../node_modules/@deepseek-ai')

function summarize(events, firstSeq) {
  let started = false
  let text = ''
  let reason
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') { started = true; continue }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

async function run(ctx, task, io) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === void 0 || defaultModel === void 0 || sessions === void 0) return
  const { installModelSelection } = await import(path.join(PKG_ROOT, 'dsh-agent/lib/index.js'))
  const selection = defaultModel.currentSelection()
  const { agent } = await agents.create({
    sessionId: `session-${randomUUID()}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: void 0 })
    },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup({
    id: `task-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  })
  // Poll for completion or timeout; the review + retry turn may wake after the
  // first quiescence (the review pipeline is asynchronous).
  const deadline = Date.now() + Number(process.env.E2E_RUNNER_TIMEOUT_MS || 20000)
  let done = false
  while (Date.now() < deadline) {
    await agent.whenIdle()
    const outcome = summarize(agent.session.events, firstSeq)
    if (outcome.text.includes('E2E-COMPLETE')) { done = true; break }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await sessions.flush(agent.session)
  const outcome = summarize(agent.session.events, firstSeq)
  io.stdout.write(outcome.text + '\n')
  if (outcome.reason?.kind === 'error') io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  io.exit(done ? 0 : 1)
}

export const name = 'e2e-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessions']

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === void 0) throw new Error('e2e-runner: launcher must provide ctx.appExit')
  const io = { stdout: process.stdout, stderr: process.stderr, exit: (code) => { exit(code) } }
  const task = config.task
  if (typeof task !== 'string' || task.length === 0) throw new Error('e2e-runner: task is required')
  void run(ctx, task, io)
}
