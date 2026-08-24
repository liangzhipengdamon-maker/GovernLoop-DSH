// AGE-65 Slice 2 — deterministic scripted LLM adapter (keyless).
// plain  mode: every model request returns text "child-done".
// nested mode: ordered queue so a delegated child emits a `subagent` tool call
// (creating a grandchild), then the grandchild and the child complete:
//   call 1 = child req1  -> tool call subagent (delegate grandchild)
//   call 2 = grandchild  -> text "grandchild-done"
//   call 3 = child req2  -> text "child-done"
// Deterministic because the child's tool call awaits the grandchild run
// synchronously (foreground subagent tool).
export class ScriptedAdapter {
  constructor() {
    this.calls = 0
    this.nested = process.env.A65_S2_NESTED === '1'
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
    this.calls++
    const n = this.calls
    if (this.nested) {
      // First model request (the child's) emits the delegation tool call; every
      // later request — child's follow-up OR the async grandchild's turn —
      // completes with plain text. Order-independent because the continuable
      // grandchild runs concurrently with the child's own continuation.
      if (n === 1) return toolCallStream('s2-subagent-1', 'subagent', { description: 'delegate grandchild', prompt: 'grandchild task' })()
      return textStream('child-done')()
    }
    return textStream('child-done')()
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
