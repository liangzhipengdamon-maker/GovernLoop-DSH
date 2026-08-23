// E2E test driver plugin — keyless: a scripted mock LLM adapter makes the REAL
// agent loop emit the destructive tool call, plus a synchronous findings
// recorder. The PO authorization provider is registered by the plugin itself
// (ADR-13 headless provider); this driver only scripts the model side.
//
// Script (per E2E scenario):
//   request 1 -> assistant message with ONE tool call: bash "git push --force"
//   request 2 -> same tool call again (the one-shot retry; only expected in the
//                approve scenario) — in block scenarios a 2nd request FAILS loudly
//   request 3 -> assistant text "E2E-COMPLETE"
//   beyond   -> throw (fail loud)
import fs from 'node:fs'

const OUT = process.env.E2E_OUT || '/tmp/dsh-e2e/e2e.jsonl'
function rec(obj) {
  const line = JSON.stringify(obj) + '\n'
  try { fs.appendFileSync(OUT, line) } catch { /* best-effort */ }
  console.log('[e2e-driver]', JSON.stringify(obj))
}

const BASH_COMMAND = 'git push --force'

const toolCallStream = async function* (callId) {
  const argumentsJson = JSON.stringify({ command: BASH_COMMAND, description: 'e2e destructive probe' })
  const block = { type: 'tool-call', id: callId, name: 'bash', arguments: argumentsJson }
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: callId, name: 'bash', argumentsDelta: argumentsJson }
  yield { type: 'block-end', index: 0, block }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: 'stop' }
}

const textStream = async function* (text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: 'stop' }
}

class ScriptedAdapter {
  constructor() {
    this.requestCount = 0
    this.expectRetry = process.env.E2E_EXPECT_RETRY === '1'
  }
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
    this.requestCount++
    const n = this.requestCount
    rec({ id: 'adapter-request', n })

    if (n === 1) return toolCallStream('call_destructive_1')
    if (n === 2) {
      if (!this.expectRetry) {
        throw new Error('UNEXPECTED SECOND MODEL REQUEST — the action should have stayed blocked (no retry)')
      }
      return toolCallStream('call_destructive_2')
    }
    if (n === 3) return textStream('E2E-COMPLETE')
    throw new Error('scripted adapter exhausted after 3 requests')
  }
}

export const name = 'e2e-driver'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter())
  // PO provider is registered by the plugin itself (ADR-13 headless provider).
  rec({ id: 'driver-active', poAnswer: process.env.E2E_PO_ANSWER || 'approve', expectRetry: process.env.E2E_EXPECT_RETRY === '1' })
}
