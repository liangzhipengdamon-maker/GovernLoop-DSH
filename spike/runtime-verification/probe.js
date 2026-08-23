// AGE-63 targeted runtime verification probe (THROWAWAY — NOT the GovernLoop plugin).
//
// Verifies, keyless, the DSH runtime assumptions AGE-61 §10 lists as pre-implementation
// open questions, against @deepseek-ai/dsh@0.1.1-rc.2:
//   S1  agent/pre-step reject + session latch blocks all further steps (pause primitive)
//   S2  tools/pre-execute receives parsed, deep-frozen arguments (unknown), not the raw wire string
//   S3  deny skips the tool body; allow runs it; live tools/result fires for both (pipeline order)
//   S4  a global tools/pre-execute listener observes a child (subagent) agent's calls;
//       a child-scoped listener does not observe parent-context calls
//   S5  ctx.jobs settlement does not implicitly wake the agent (delivery is the consumer's choice)
//   S6  ctx.userQuestions.ask() in headless: no provider -> NO_PROVIDER (does not hang);
//       a plugin-registered provider answers (PO-authorization surface is plugin-pluggable)
//   S7  zero model calls happen during the whole run (mock adapter is a fail-loud net)
//
// The probe registers a fail-loud mock LLM adapter for provider 'mock', drives every
// scenario from inside the first agent/pre-step (awaited by the loop, so quiescence is
// gated on probe work), then latch-rejects everything (two turns), and writes JSONL
// findings to $PROBE_OUT (default /tmp/dsh-verify/findings.jsonl).
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const OUT = process.env.PROBE_OUT || '/tmp/dsh-verify/findings.jsonl'
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, '') // fresh per run

function rec(obj) {
  const line = JSON.stringify(obj) + '\n'
  fs.appendFileSync(OUT, line)
  console.log('[probe]', obj.id || '', JSON.stringify(obj).slice(0, 500))
}

const state = {
  latch: false,
  denyProbe: true, // first probe_tool call denied, second allowed
  preStepSeen: 0,
  turnsSeen: 0,
  stepsSeen: 0,
  assistantMessages: 0,
  durableToolResults: 0,
  liveToolResults: 0,
  turnEndReasons: [],
  bodyRan: 0,
  statusLog: [],
  preExecLog: [],
  childScopedSeen: 0,
  childId: null,
  jobSettled: false,
  poNoProvider: null,
  poAskResult: null,
  mockStreamCalls: 0,
  scenarioError: null,
}

let mockStreamCalls = 0
class MockLlmAdapter {
  providerInfo(provider) { return { id: provider, name: provider } }
  providerRetryPolicy() { return undefined }
  async listModels() { return [{ id: 'mock-1', name: 'mock-1' }] }
  async resolveModel(provider, model) {
    return { id: model, provider, model, context: 0, defaultMaxTokens: 128 }
  }
  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (opts) => this.stream(opts) }
  }
  stream() {
    mockStreamCalls++
    throw new Error('MOCK ADAPTER INVOKED — a model call slipped through; pre-step must reject all steps')
  }
}

async function runScenario(ctx) {
  const ab = new AbortController()
  const t0 = Date.now()

  // ---- S2/S3: gate input contract + deny/allow pipeline on the REAL bash tool ----
  try {
    const denyRes = await ctx.tools.execute({
      callId: 'probe-bash-deny-1',
      name: 'bash',
      arguments: { command: 'git push --force', description: 'probe destructive call' },
      signal: ab.signal,
    })
    rec({ id: 'S3-bash-deny', isError: denyRes.isError, contentIsArray: Array.isArray(denyRes.content) })
  } catch (e) {
    rec({ id: 'S3-bash-deny-error', error: String(e && (e.message || e)) })
  }

  // ---- S2/S3 on the probe tool: deny then allow ----
  try {
    const denyProbe = await ctx.tools.execute({
      callId: 'probe-tool-deny-1',
      name: 'probe_tool',
      arguments: { command: 'git push --force' },
      signal: ab.signal,
    })
    rec({ id: 'S3-probe-deny', isError: denyProbe.isError, bodyRan: state.bodyRan })
    state.bodyRan = 0
  } catch (e) {
    rec({ id: 'S3-probe-deny-error', error: String(e && (e.message || e)) })
  }
  state.denyProbe = false
  try {
    const allowProbe = await ctx.tools.execute({
      callId: 'probe-tool-allow-1',
      name: 'probe_tool',
      arguments: { command: 'ok' },
      signal: ab.signal,
    })
    rec({ id: 'S3-probe-allow', isError: allowProbe.isError, value: allowProbe.value, bodyRan: state.bodyRan })
  } catch (e) {
    rec({ id: 'S3-probe-allow-error', error: String(e && (e.message || e)) })
  }

  // ---- S4: subagent scope interception ----
  try {
    const handle = await ctx.agents.create({
      sessionId: 'probe-child-1',
      agentOptions: {},
      setup: async (agentCtx) => {
        agentCtx.on('tools/pre-execute', async (exec, next) => {
          state.childScopedSeen++
          return next()
        })
      },
    })
    state.childId = handle.agent.id
    rec({ id: 'S4-child-created', childId: state.childId })
    const before = state.childScopedSeen
    // call executed under the child agent: global listener must see it; child-scoped too
    await ctx.tools.execute({
      callId: 'probe-child-call-1',
      name: 'probe_tool',
      arguments: { command: 'child' },
      signal: ab.signal,
      agent: handle.agent,
    })
    const childScopedForChild = state.childScopedSeen - before
    // call without agent (parent-context): child-scoped listener must NOT see it
    const before2 = state.childScopedSeen
    await ctx.tools.execute({
      callId: 'probe-parent-call-1',
      name: 'probe_tool',
      arguments: { command: 'parent' },
      signal: ab.signal,
    })
    rec({
      id: 'S4-scope',
      globalSawChild: state.preExecLog.some((x) => x.agentId === state.childId && x.callId === 'probe-child-call-1'),
      childScopedForChild,
      childScopedForParentCall: state.childScopedSeen - before2, // expect 0
    })
  } catch (e) {
    rec({ id: 'S4-error', error: String(e && (e.message || e)) })
  }

  // ---- S5: jobs seam is inert (no implicit wake) ----
  try {
    const detach = ctx.jobs.attachController('probe')
    const statusLenBefore = state.statusLog.length
    const jobId = ctx.jobs.start({
      kind: 'probe',
      label: 'probe-job',
      run() {
        return {
          cancel() {},
          done: new Promise((resolve) => {
            setTimeout(() => {
              state.jobSettled = true
              resolve({ status: 'completed', output: 'probe-done' })
            }, 150)
          }),
        }
      },
    })
    const snap = await ctx.jobs.wait(jobId, 5000)
    rec({
      id: 'S5-job',
      jobId,
      settled: state.jobSettled,
      status: snap.status,
      agentWokeDuringJob: state.statusLog.slice(statusLenBefore).some((s) => s.status === 'running'),
    })
    detach()
  } catch (e) {
    rec({ id: 'S5-error', error: String(e && (e.message || e)) })
  }

  // ---- S6: userQuestions headless ----
  try {
    try {
      await ctx.userQuestions.ask({ questions: [{ id: 'q1', question: 'PO approve?' }] })
      state.poNoProvider = 'resolved (unexpected)'
    } catch (e) {
      state.poNoProvider = (e && (e.code || e.message)) || String(e)
    }
    rec({ id: 'S6-no-provider', outcome: state.poNoProvider })
  } catch (e) {
    rec({ id: 'S6-no-provider-error', error: String(e && (e.message || e)) })
  }
  try {
    const dispose = ctx.userQuestions.registerProvider({
      ask: async () => ({ answers: [{ id: 'q1', selected: [process.env.PROBE_PO_ANSWER || 'approve'] }] }),
    })
    try {
      const ans = await ctx.userQuestions.ask({ questions: [{ id: 'q1', question: 'PO approve?' }] })
      state.poAskResult = JSON.stringify(ans)
    } catch (e) {
      state.poAskResult = 'ERR ' + ((e && (e.code || e.message)) || e)
    }
    dispose()
    rec({ id: 'S6-with-provider', outcome: state.poAskResult })
  } catch (e) {
    rec({ id: 'S6-with-provider-error', error: String(e && (e.message || e)) })
  }

  // queue a followup so turn 2 exercises the latch across turns
  // (payload.agent is passed in by the pre-step caller)
  state.followupAgent = null // set by the pre-step handler before calling runScenario
  rec({ id: 'scenario-done', ms: Date.now() - t0 })
}

function apply(ctx) {
  // fail-loud mock adapter net (provider 'mock' set by overlay agent-default-model)
  ctx.llm.registerAdapter(['mock'], new MockLlmAdapter())

  // probe tool used for body/deny verification
  ctx.tools.register({
    name: 'probe_tool',
    description: 'AGE-63 verification probe tool',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: async (args) => { state.bodyRan++; return 'ran:' + args.command },
  })

  // timeline observers
  ctx.on('agent/status', (p) => { state.statusLog.push({ status: p.status }) })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/start') state.turnsSeen++
    if (event.type === 'turn/end') state.turnEndReasons.push(event.data.reason)
    if (event.type === 'step/start') state.stepsSeen++
    if (event.type === 'assistant/message') state.assistantMessages++
    if (event.type === 'tool/result') state.durableToolResults++
  })
  ctx.on('tools/result', () => { state.liveToolResults++ })

  // GLOBAL pre-execute listener (plain context = all agents)
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'probe_tool' || exec.name === 'bash') {
      state.preExecLog.push({
        name: exec.name,
        argumentsType: typeof exec.arguments,
        isObject: exec.arguments !== null && typeof exec.arguments === 'object' && !Array.isArray(exec.arguments),
        frozen: Object.isFrozen(exec.arguments),
        command: (exec.arguments && typeof exec.arguments === 'object' && exec.arguments.command) || null,
        agentId: exec.agent ? exec.agent.id : null,
        callId: exec.callId,
      })
      if (exec.name === 'probe_tool' && state.denyProbe) return { kind: 'deny', reason: 'probe-deny' }
      if (exec.name === 'bash') return { kind: 'deny', reason: 'probe-deny-bash' }
    }
    return next()
  })

  // Pre-step driver: run the whole scenario once, then latch-reject everything.
  // Turn 2 (latch check) is triggered from the idle observer below (true resume path).
  let followupSent = false
  let summaryWritten = false
  function writeSummaries() {
    if (summaryWritten) return
    summaryWritten = true
    rec({
      id: 'S1-summary',
      preStepsSeen: state.preStepSeen,
      turnsSeen: state.turnsSeen,
      stepsSeen: state.stepsSeen,
      assistantMessages: state.assistantMessages,
      latchBlocks: Math.max(0, state.preStepSeen - 1),
      turnEndReasons: state.turnEndReasons,
      finalStatusIdle: state.statusLog.length ? state.statusLog[state.statusLog.length - 1].status : 'none',
    })
    rec({
      id: 'S2-summary',
      gateInput: state.preExecLog.map((x) => ({
        name: x.name,
        argumentsType: x.argumentsType,
        isObject: x.isObject,
        frozen: x.frozen,
        command: x.command,
      })),
    })
    rec({
      id: 'S3-summary',
      liveToolResults: state.liveToolResults,
      durableToolResults: state.durableToolResults,
    })
    rec({ id: 'S7-summary', mockStreamCalls: mockStreamCalls })
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    state.preStepSeen++
    if (!state.agentId) state.agentId = payload.agent.id
    if (state.preStepSeen === 1) {
      try {
        await runScenario(ctx)
      } catch (e) {
        state.scenarioError = String((e && (e.stack || e.message)) || e)
        rec({ id: 'scenario-threw', error: state.scenarioError })
      }
      state.latch = true
      return { kind: 'reject' }
    }
    if (state.latch) {
      rec({ id: 'S1-latch-blocked-step', turn: payload.turn, step: payload.step })
      writeSummaries()
      return { kind: 'reject' }
    }
    return next()
  })

  // True resume path: when the headless agent is idle with the latch set, a followup
  // must produce a NEW turn whose pre-step the latch rejects (turn 2).
  ctx.on('agent/status', (p) => {
    if (state.agentId && p.agent.id === state.agentId && p.status === 'idle' && state.latch && !followupSent) {
      followupSent = true
      p.agent.followup({ id: 'probe-followup-1', role: 'user', content: [{ type: 'text', text: 'again' }], source: { kind: 'plugin', plugin: 'probe' } })
    }
    if (state.agentId && p.agent.id === state.agentId && p.status === 'idle' && state.latch && state.preStepSeen >= 2) {
      writeSummaries()
    }
  })
}

module.exports = {
  name: 'probe',
  inject: ['llm', 'tools', 'agents', 'jobs', 'userQuestions'],
  apply,
}
