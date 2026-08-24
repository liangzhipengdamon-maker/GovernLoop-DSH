// AGE-65 Slice 3 — DSH native approval vs GovernLoop token/latch (minimal, keyless).
// Exercises the REAL approval seam end-to-end without any GovernLoop code:
//   - a trivial `probe-echo` tool whose pre-execute returns {kind:'ask'}
//   - an 'approval/request' answerer that answers: call1 -> 'allowed-once',
//     call2 -> 'allowed-once' (a FRESH ask must occur per call), call3 -> throw
//     (must normalize to 'unavailable' -> deny, fail-closed)
//   - dump of the durable audit pair (approval/asked + approval/decided) plus a
//     persistence reload to prove replay keeps the audit.
import path from 'node:path'
import fs from 'node:fs'
// resolve the installed dsh-tools through an absolute path (the runner lives
// outside DSH's node_modules chain, so bare specifiers do not resolve)
const { defineTool } = await import(process.env.A65_S3_TOOLS)

const OUT = process.env.A65_S3_OUT || '/tmp/dsh-a65-s3/findings.jsonl'
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, '')

function rec(obj) {
  const line = JSON.stringify(obj) + '\n'
  fs.appendFileSync(OUT, line)
  console.log('[a65s3]', JSON.stringify(obj).slice(0, 600))
}

// ---- deterministic mock LLM adapter (provider 'mock') ----
class ScriptedAdapter {
  constructor() { this.calls = 0 }
  providerInfo(provider) { return { id: provider, name: provider } }
  providerRetryPolicy() { return undefined }
  async listModels() { return [{ id: 'mock-1', name: 'mock-1' }] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, defaultMaxTokens: 128 }
  }
  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (o) => this.stream(o) }
  }
  stream() {
    this.calls++
    const n = this.calls
    if (n === 1) return toolCallStream('s3-call-1', 'probe-echo', { tag: 'c1' })()
    if (n === 2) return toolCallStream('s3-call-2', 'probe-echo', { tag: 'c2' })()
    if (n === 3) return toolCallStream('s3-call-3', 'probe-echo', { tag: 'c3' })()
    return textStream('a65-s3 done')()
  }
}

function textStream(text) {
  return async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: 'stop' }
  }
}

function toolCallStream(callId, name, args) {
  const argumentsJson = JSON.stringify(args)
  const block = { type: 'tool-call', id: callId, name, arguments: argumentsJson }
  return async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson }
    yield { type: 'block-end', index: 0, block: block }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: 'stop' }
  }
}

export const name = 'a65-s3-approval'
export const inject = ['tools', 'llm', 'sessionPersistence']

export function apply(ctx) {
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter())

  // Trivial tool that will be gated by an ask in pre-execute.
  ctx.tools.register(defineTool({
    name: 'probe-echo',
    description: 'Echo the tag back. Used by the AGE-65 slice-3 approval probe.',
    parameters: {
      tag: { type: 'string', required: true, description: 'probe tag' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args) { return Promise.resolve({ echo: args.tag }) },
  }))

  // Gate every probe-echo call with an ask.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'probe-echo') {
      return { kind: 'ask', reason: `a65-s3 probe ask (${exec.arguments?.tag})` }
    }
    return next()
  })

  // Answerer for the approval waterfall. Records what the request carries, then:
  // call1 -> allowed-once, call2 -> allowed-once, call3 -> throw (fail-closed).
  let answered = 0
  ctx.on('approval/request', async (req, next) => {
    answered++
    const n = answered
    rec({
      id: 'A-ask-received',
      n,
      toolName: req.toolName,
      callId: req.callId ?? null,
      reason: req.reason ?? null,
      argsInRequest: Object.hasOwn(req, 'arguments'),
      hasSignal: !!req.signal,
      hasAgent: !!req.agent,
    })
    if (n === 3) throw new Error('a65-s3 answerer failure (must normalize to unavailable)')
    return 'allowed-once'
  })

  // After the third (denied) call settles, dump the live durable audit.
  ctx.on('tools/result', async (exec, result) => {
    if (exec.name !== 'probe-echo' || exec.arguments?.tag !== 'c3') return
    const session = exec.agent.session
    const events = session.events
    const asked = events.filter((e) => e.type === 'approval/asked')
    const decided = events.filter((e) => e.type === 'approval/decided')
    rec({
      id: 'B-audit-live',
      askedCount: asked.length,
      decidedCount: decided.length,
      idsDistinct: new Set(asked.map((e) => e.data.id)).size === asked.length,
      askedPayloads: asked.map((e) => e.data),
      decidedPayloads: decided.map((e) => e.data),
    })
    // Fail-closed evidence: the c3 call was denied with the unavailable reason.
    rec({
      id: 'D-c3-failclosed',
      resultIsError: result.isError === true,
      errorMessage: result.error ? result.error.message : null,
    })
  })

  // Replay proof: once the turn closes, reload from persistence and confirm the
  // approval/asked + approval/decided pair survives (persistence refuses a load
  // while the live turn is open — that guard is itself a durability guarantee).
  let didReplay = false
  ctx.on('session/event', async (session, event) => {
    if (didReplay || event.type !== 'turn/end') return
    didReplay = true
    try {
      const insp = await ctx.sessionPersistence.load(session.id)
      const ra = insp.events.filter((e) => e.type === 'approval/asked')
      const rd = insp.events.filter((e) => e.type === 'approval/decided')
      rec({
        id: 'C-audit-replay',
        reloadedAskedCount: ra.length,
        reloadedDecidedCount: rd.length,
        pairIntact: ra.length === 3 && rd.length === 3,
      })
    } catch (e) {
      rec({ id: 'C-audit-replay-error', error: String(e && (e.message || e)) })
    }
  })
}
