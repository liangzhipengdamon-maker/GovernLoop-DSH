// AGE-65 Slice 2 — Real Subagent Delegation Identity / Lineage probe.
// Runs inside the headless agent's FIRST agent/pre-step (so the current
// initiator = root principal P), then rejects the step (no model call for P).
// Keyless: children use the ScriptedAdapter (provider 'mock').
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { ScriptedAdapter } from './mock-adapter.mjs'

const OUT = process.env.A65_S2_OUT || '/tmp/dsh-a65-s2/findings.jsonl'
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, '')

function rec(obj) {
  const line = JSON.stringify(obj) + '\n'
  fs.appendFileSync(OUT, line)
  console.log('[a65s2]', JSON.stringify(obj).slice(0, 600))
}

const rejectSteps = (agentCtx) => {
  agentCtx.on('agent/pre-step', async (p, next) => ({ kind: 'reject' })) // keyless
}

async function runProbe(ctx) {
  const subagents = ctx.get('subagents')
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const agents = ctx.get('agents')
  const abort = new AbortController()

  const P = agents.requireInitiator()
  rec({
    id: 'P-root',
    sessionId: P.session.id,
    agentId: P.id,
    header: {
      parentSession: P.session.header.parentSession ?? null,
      delegationDepth: P.session.header.delegationDepth ?? null,
    },
  })

  // ---- Q1/Q2/Q3: real delegated child via the spawn provider ----
  let childId = null
  try {
    const runC = await subagents.start('spawn', {
      label: 'a65-s2-child',
      prompt: [{ type: 'text', text: 'child task' }],
      parent: P,
      signal: abort.signal,
    })
    const C = runC.localAgent
    childId = C.session.id
    rec({
      id: 'Q1-child-created',
      childSessionId: childId,
      distinctFromParent: childId !== P.session.id,
      childAgentIdEqualsSession: C.id === C.session.id,
    })
    rec({
      id: 'Q2-child-live-header',
      parentSession: C.session.header.parentSession ?? null,
      delegationDepth: C.session.header.delegationDepth ?? null,
    })
    // Let the child settle so its session log is durably flushed before we
    // read persistence.
    const childRes = await runC.result
    rec({
      id: 'Q1-child-settled',
      stopReason: childRes.stopReason,
      outputText: childRes.output.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    })
    try {
      const insp = await persistence.load(childId)
      rec({
        id: 'Q2-child-persisted-header',
        parentSession: insp.meta.parentSession ?? null,
        delegationDepth: insp.meta.delegationDepth ?? null,
        eventCount: insp.events.length,
      })
    } catch (e) {
      rec({ id: 'Q2-child-persisted-error', error: String(e && (e.message || e)) })
    }
    await runC.dispose()
  } catch (e) {
    rec({ id: 'Q1-child-error', error: String(e && (e.message || e)) })
  }

  // ---- Q5: child resume ----
  if (childId) {
    try {
      const rh = await agents.resume({ resumeSessionId: childId, setup: rejectSteps })
      rec({
        id: 'Q5-child-resume',
        sameSessionId: rh.agent.session.id === childId,
        parentSession: rh.agent.session.header.parentSession ?? null,
        delegationDepth: rh.agent.session.header.delegationDepth ?? null,
        agentIdEqualsSession: rh.agent.id === rh.agent.session.id,
      })
      await rh.dispose()
    } catch (e) {
      rec({ id: 'Q5-child-resume-error', error: String(e && (e.message || e)) })
    }
  }

  // ---- Q4: session-fork comparison (fresh scratch session, closed turn) ----
  try {
    const sc = sessions.create(undefined, { meta: { cwd: process.cwd() } })
    sc.append('turn/start', { turn: 1 })
    sc.append('step/start', { turn: 1, step: 1 })
    sc.append('step/end', { turn: 1, step: 1 })
    sc.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await sessions.flush(sc)
    const fork = await sessions.fork(sc.id)
    rec({
      id: 'Q4-session-fork',
      sourceId: sc.id,
      forkId: fork.id,
      parentSession: fork.header.parentSession ?? null,
      seedLength: fork.header.seedLength,
      delegationDepth: fork.header.delegationDepth ?? null,
    })
  } catch (e) {
    rec({ id: 'Q4-session-fork-error', error: String(e && (e.message || e)) })
  }

  // ---- Q6: nested delegation (grandchild) — present only when the scripted
  // adapter ran in nested mode and the child delegated through the real
  // model-facing `subagent` tool (continuable background). Poll persistence
  // for the grandchild header (parentSession === childId) and then wait for
  // its completed turn, because the grandchild settles asynchronously.
  if (process.env.A65_S2_NESTED === '1' && childId) {
    try {
      const deadline = Date.now() + 20000
      let grand = null
      let settled = false
      let insp = null
      while (Date.now() < deadline) {
        const headers = await persistence.list()
        grand = headers.find((h) => h.parentSession === childId)
        if (grand) {
          try {
            insp = await persistence.load(grand.id)
            settled = insp.events.some(
              (ev) => ev.type === 'turn/end' && ev.data && ev.data.reason && ev.data.reason.kind === 'completed'
            )
          } catch { /* keep settled=false */ }
          if (settled) break
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      if (grand) {
        const desc = insp ? insp.events.find((ev) => ev.type === 'subagent/descriptor') : null
        const finalText = insp
          ? insp.events
              .filter((ev) => ev.type === 'assistant/message' && ev.data && ev.data.message)
              .map((ev) => ev.data.message.content || [])
              .flat()
              .filter((b) => b && b.type === 'text')
              .map((b) => b.text)
              .join('')
          : ''
        rec({
          id: 'Q6-grandchild',
          grandchildSessionId: grand.id,
          distinctFromAll: grand.id !== childId && grand.id !== P.session.id,
          parentSession: grand.parentSession ?? null,
          delegationDepth: grand.delegationDepth ?? null,
          descriptor: desc ? desc.data : null,
          settledCompletedTurn: settled,
          persistedEventCount: insp ? insp.events.length : null,
          finalOutputText: finalText,
        })
      } else {
        rec({ id: 'Q6-grandchild', found: false, persistedCount: (await persistence.list()).length })
      }
    } catch (e) {
      rec({ id: 'Q6-grandchild-error', error: String(e && (e.message || e)) })
    }
  }
}

export const name = 'a65-slice2'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'subagents', 'llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter())
  let first = true
  ctx.on('agent/pre-step', async (payload, next) => {
    if (first) {
      first = false
      try {
        await runProbe(ctx)
      } catch (e) {
        rec({ id: 'probe-threw', error: String(e && (e.stack || e.message)) })
      }
      return { kind: 'reject' } // P runs no model step
    }
    return next() // children (and later steps) are allowed
  })
}
