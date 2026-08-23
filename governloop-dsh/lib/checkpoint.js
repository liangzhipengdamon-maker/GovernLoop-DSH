// Checkpoint state machine — the thin DSH-side governor for the
// BEFORE_DESTRUCTIVE_ACTION vertical slice (AGE-61 §4, Rev 2).
//
//   RUNNING → CHECKPOINT_PENDING (deny + latch) → REVIEW_IN_FLIGHT (relay)
//   → REVIEW_RECEIVED (envelope) → AWAITING_PO_AUTHORIZATION (human decides)
//   → RESUME_PENDING → RETRY_ARMED (latch released, one-shot token armed)
//   → RUNNING (token consumed on the exact retry; verdict injected)
//   BLOCKED / FAILED: terminal, latch stays set, no auto-resend.
//
// Latch = session-scoped; consulted first at agent/pre-step. Deny is detection,
// the latch is the pause (AGE-63 S1). ChatGPT review is advisory; the one-shot
// retry token is minted ONLY from explicit human (PO) authorization (AGE-61 §4.3).
import fs from 'node:fs'
import { classify } from './classifier.js'
import { buildCheckpointMessage, extractEnvelope } from './envelope.js'
import { mintToken, checkToken, consumeToken } from './token.js'
import { ensureSession, sendCheckpoint, sessionStateDir } from './relay.js'

export const CHECKPOINT_TYPE = 'BEFORE_DESTRUCTIVE_ACTION'

const DEFAULT_CONFIG = {
  tokenTtlMs: 10 * 60 * 1000, // 10 minutes (AGE-61 §4.3)
  evidenceMaxEvents: 20,
  relayTimeoutMs: 600000,
  attachPaths: [],
  allowRules: [],
  poAnswerFile: '', // headless PO approval channel (ADR-13): file containing approve|decline
  debugOut: '',
  advisoryFooter:
    'This review is advisory evidence. It does NOT authorize repository mutation, commit, push, PR, merge, deploy, release, or any other action. Follow the shared authorization boundary; only explicit user authorization grants action.',
}

/** Statuses that hold the session latch (pause) at agent/pre-step. */
const LATCH_STATUSES = new Set([
  'CHECKPOINT_PENDING',
  'REVIEW_IN_FLIGHT',
  'REVIEW_RECEIVED',
  'AWAITING_PO_AUTHORIZATION',
  'RESUME_PENDING',
  'BLOCKED',
  'FAILED',
])

/** Statuses where a second identical trigger merges instead of opening a new review. */
const MERGE_STATUSES = new Set(['CHECKPOINT_PENDING', 'REVIEW_IN_FLIGHT', 'REVIEW_RECEIVED', 'AWAITING_PO_AUTHORIZATION', 'RESUME_PENDING'])

export class CheckpointManager {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    // Capture service references at activation (context active). The review
    // pipeline runs on event-dispatch fibers that may become inactive after the
    // dispatch returns; resolving ctx.userQuestions later would throw
    // "cannot get required service ... in inactive context".
    this.userQuestions = ctx.userQuestions
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.ownPoProvider = null
    this.bySession = new Map() // sessionId -> checkpoint record (active or terminal-blocked)
    this.events = new Map() // sessionId -> rolling evidence event buffer
    this.seq = 0
  }

  debug(record, event, data) {
    if (!this.config.debugOut) return
    const line = JSON.stringify({
      checkpointId: record?.id ?? null,
      sessionId: record?.sessionId ?? null,
      event,
      ...data,
      at: Date.now(),
    }) + '\n'
    try {
      fs.appendFileSync(this.config.debugOut, line)
    } catch { /* debug channel is best-effort */ }
  }

  observeEvent(session, event) {
    const id = session.id
    const buf = this.events.get(id) ?? []
    buf.push({
      type: event.type,
      turn: event.data?.turn,
      step: event.data?.step,
      name: event.data?.name,
      contentHead: event.type === 'tool/result' ? String(event.data?.message?.content?.[0]?.text ?? '').slice(0, 200) : undefined,
    })
    if (buf.length > this.config.evidenceMaxEvents) buf.shift()
    this.events.set(id, buf)
  }

  /**
   * tools/pre-execute gate: classify + deny + record pending checkpoint.
   * Returns a deny decision for destructive calls; undefined otherwise.
   * A valid one-shot retry token allows the EXACT call once (AGE-61 §4.3).
   */
  gate(exec) {
    const hit = classify(exec, { allowRules: this.config.allowRules })
    if (!hit) return undefined
    const sessionId = exec.agent?.session?.id ?? exec.agent?.id ?? null
    const cwd = exec.agent?.session?.header?.cwd ?? ''
    const existing = sessionId ? this.bySession.get(sessionId) : undefined

    // RETRY_ARMED: a one-shot token exists for this session. Exact fingerprint +
    // command + unexpired + unused → allow ONCE; anything else → deny.
    if (existing?.token) {
      const check = checkToken(existing.token, { sessionId, cwd, name: exec.name, args: exec.arguments })
      if (check.allow) {
        consumeToken(existing.token)
        this.bySession.delete(sessionId) // checkpoint complete; next destructive call is a fresh checkpoint
        this.debug(existing, 'token-allowed', { callId: exec.callId })
        return undefined
      }
      this.debug(existing, 'token-denied', { callId: exec.callId, reason: check.reason })
      return { kind: 'deny', reason: `governloop-dsh: retry not authorized (${check.reason}); destructive action requires review + explicit human authorization` }
    }

    // Terminal block: no new checkpoint while the latch is held (fail-closed,
    // AGE-61 §4.5). The action stays denied until explicit human resolution.
    if (existing && (existing.status === 'BLOCKED' || existing.status === 'FAILED')) {
      this.debug(existing, 'blocked-deny', { callId: exec.callId })
      return { kind: 'deny', reason: `governloop-dsh: ${existing.ruleId} — action remains blocked (${existing.blockedReason ?? existing.status}); resolve manually` }
    }

    // Duplicate while one is already pending/in-flight: merge into it.
    if (existing && MERGE_STATUSES.has(existing.status)) {
      existing.mergedCalls = (existing.mergedCalls ?? 0) + 1
      this.debug(existing, 'dedupe-merge', { callId: exec.callId })
      return { kind: 'deny', reason: `governloop-dsh: ${existing.ruleId} — checkpoint already in flight; this call is merged` }
    }

    const record = {
      id: `${CHECKPOINT_TYPE}-${++this.seq}`,
      type: CHECKPOINT_TYPE,
      sessionId,
      agent: exec.agent,
      callId: exec.callId,
      name: exec.name,
      args: exec.arguments,
      cwd,
      command: hit.command,
      ruleId: hit.ruleId,
      status: 'CHECKPOINT_PENDING',
      triggeredAt: Date.now(),
      token: null,
      envelope: null,
      poAnswer: null,
      governloopSessionId: null,
      relayResult: null,
      mergedCalls: 0,
      blockedReason: null,
    }
    if (sessionId) this.bySession.set(sessionId, record)
    this.debug(record, 'gate-deny', { ruleId: hit.ruleId, command: hit.command, callId: exec.callId })
    return { kind: 'deny', reason: `governloop-dsh: ${hit.ruleId} — destructive action requires independent review + explicit human authorization` }
  }

  /**
   * agent/pre-step gate: the session latch. While a checkpoint holds the latch,
   * every proposed step is rejected (the pause primitive, AGE-63 S1).
   */
  stepGate(payload) {
    const record = this.bySession.get(payload.agent.id)
    if (record && LATCH_STATUSES.has(record.status)) {
      this.debug(record, 'latch-blocked-step', { turn: payload.turn, step: payload.step })
      return { kind: 'reject' }
    }
    return undefined
  }

  /**
   * Live tools/result observer: kick off the review pipeline for a denied call.
   * Fire-and-forget; the agent is latched at the next pre-step meanwhile.
   */
  onToolResult(exec, result) {
    const record = [...this.bySession.values()].find(
      (r) => r.callId === exec.callId && r.status === 'CHECKPOINT_PENDING',
    )
    if (!record) return
    // Fire-and-forget review pipeline. Service references are captured at
    // activation (this.userQuestions) so the dispatch-continuation fiber's
    // inactivity cannot break resolution; the final followup works from this
    // continuation (verified empirically in the AGE-63 E2E).
    void this.runReview(record).catch((err) => {
      this.fail(record, 'REVIEW_PIPELINE_ERROR', String(err && (err.message || err)))
    })
  }

  async runReview(record, signal) {
    record.status = 'REVIEW_IN_FLIGHT'
    this.debug(record, 'review-started')
    if (signal?.aborted) throw new Error('review cancelled before start')

    // 1) ensure GovernLoop session (never persists the conversation URL)
    record.governloopSessionId = await ensureSession(this.config, { task: record.command, signal })

    // 2) evidence + checkpoint message (send decisions, not logs)
    const message = this.buildEvidenceMessage(record)

    // 3) relay (background; no auto-resend)
    const sent = await sendCheckpoint(this.config, {
      sessionId: record.governloopSessionId,
      type: record.type,
      messageText: message,
      seq: this.seq,
      signal,
    })
    record.relayResult = sent.res
    if (sent.res.aborted) throw new Error('relay cancelled')
    if (sent.res.code !== 0) {
      throw new Error(`relay failed (exit ${sent.res.code}): ${(sent.res.stderr || sent.res.stdout).slice(0, 300)}`)
    }

    // 4) read-back + freshness + envelope (fail-closed for destructive)
    if (!fs.existsSync(sent.responseFile)) throw new Error('review response file missing')
    const stat = fs.statSync(sent.responseFile)
    if (stat.mtimeMs < record.triggeredAt) throw new Error('review response is stale (older than checkpoint)')
    const text = fs.readFileSync(sent.responseFile, 'utf8')
    const parsed = extractEnvelope(text)
    if (!parsed.ok) throw new Error(`review envelope invalid (${parsed.reason})`)
    if (parsed.envelope.confidence === 'low') throw new Error('review envelope low-confidence — stays blocked')
    record.envelope = parsed.envelope
    record.status = 'REVIEW_RECEIVED'
    this.debug(record, 'review-received', { verdict: parsed.envelope.verdict, confidence: parsed.envelope.confidence })

    // 5) AWAITING_PO_AUTHORIZATION — explicit human decision; review is advisory only
    record.status = 'AWAITING_PO_AUTHORIZATION'
    const answer = await this.askPo(record)
    record.poAnswer = answer
    if (answer !== 'approve') {
      record.status = 'BLOCKED'
      record.blockedReason = answer === 'decline' ? 'PO declined authorization' : `PO unavailable (${answer})`
      this.debug(record, 'po-not-approved', { answer })
      return // latch stays set; fail-closed (AGE-61 §4.5 PO_DECLINED / NO_PROVIDER)
    }
    this.debug(record, 'po-approved')

    // 6) one-shot token minted ONLY from the explicit human authorization
    record.token = mintToken({
      sessionId: record.sessionId,
      checkpointId: record.id,
      callId: record.callId,
      cwd: record.cwd,
      name: record.name,
      args: record.args,
      exactCommand: record.command,
      ttlMs: this.config.tokenTtlMs,
    })

    // 7) resume: release the latch (RETRY_ARMED) and deliver the verdict.
    record.status = 'RETRY_ARMED'
    this.debug(record, 'token-minted', { expiresInMs: this.config.tokenTtlMs })
    const agent = record.agent
    try {
      if (agent?.whenIdle) await agent.whenIdle()
      const msg = this.buildReviewMessage(record)
      if (agent?.followup) {
        agent.followup(msg)
        this.debug(record, 'verdict-injected', { verdict: record.envelope.verdict, token: !!record.token })
      }
    } catch (err) {
      this.debug(record, 'deliver-threw', { error: String((err && (err.stack || err.message)) || err) })
      throw err
    }
  }

  buildEvidenceMessage(record) {
    const buf = (this.events.get(record.sessionId) ?? []).slice(-this.config.evidenceMaxEvents)
    const recent = buf
      .map((e) => `${e.type}${e.name ? `(${e.name})` : ''}`)
      .join(', ')
      .slice(0, 2000)
    const ctx = [
      `CHECKPOINT: ${record.type}`,
      `SESSION: ${record.governloopSessionId}`,
      'TRIGGER: runtime',
      `RULE: ${record.ruleId}`,
      `COMMAND: ${String(record.command).slice(0, 2000)}`,
      `ARGS: ${JSON.stringify(record.args).slice(0, 2000)}`,
      `CWD: ${record.cwd}`,
      `RECENT_EVENTS: ${recent || '(none)'}`,
    ].join('\n')
    return buildCheckpointMessage(ctx)
  }

  buildReviewText(record) {
    const tokenNotice = record.token
      ? `\nA one-shot authorization token valid for ${Math.round(this.config.tokenTtlMs / 60000)} min was minted for the exact denied call (${record.ruleId}). It authorizes ONLY that exact call, once.`
      : ''
    return [
      `[GovernLoop review — ${record.id}]`,
      `Verdict: ${record.envelope.verdict} (confidence: ${record.envelope.confidence})`,
      `Rationale: ${record.envelope.rationale}`,
      ...(record.envelope.required_fixes.length
        ? [`Required fixes: ${record.envelope.required_fixes.join('; ')}`]
        : []),
      tokenNotice,
      this.config.advisoryFooter,
    ].join('\n\n')
  }

  /** The verdict UserMessage with the merge-extensible governloop-review source (AGE-61 §5). */
  buildReviewMessage(record) {
    return {
      id: `governloop-review-${record.id}`,
      role: 'user',
      content: [{ type: 'text', text: this.buildReviewText(record) }],
      source: {
        kind: 'governloop-review',
        checkpointId: record.id,
        verdict: record.envelope.verdict.toLowerCase(),
        form: 'relay',
      },
    }
  }

  /**
   * ADR-13 headless PO authorization surface: the plugin registers its own
   * userQuestions provider (only when none is active — the Web UI provider wins
   * in web deployments). The headless channel is an approval file
   * (config.poAnswerFile / GOVERLOOP_PO_ANSWER_FILE) containing approve|decline.
   * Missing/unreadable file -> no answer -> BLOCKED (fail-closed).
   */
  /**
   * ADR-13 headless PO authorization surface: register the plugin's own
   * userQuestions provider ONLY when none is active (a Web/ACP provider, when
   * present, is never replaced or shadowed).
   *
   * Why v1 sets the single provider slot directly instead of calling
   * userQuestions.registerProvider(): registerProvider() attaches the
   * registration to the service's own fiber via ctx.effect, and that fiber is
   * torn down before the async review pipeline reaches ask() — observed
   * empirically in the AGE-63 spike (the provider slot came back empty). The
   * direct field keeps the provider for this plugin's lifetime; dispose()
   * restores the slot on unload ONLY if it is still ours (a provider another
   * plugin installed later is left untouched).
   */
  registerPoProvider() {
    if (!this.userQuestions) return
    if (this.userQuestions.provider !== undefined) return // a UI/ACP provider is already active — it serves
    const provider = {
      ask: async () => {
        const file = this.config.poAnswerFile || process.env.GOVERLOOP_PO_ANSWER_FILE
        let decision = null
        if (file) {
          try {
            decision = fs.readFileSync(file, 'utf8').trim().toLowerCase()
          } catch { /* missing/unreadable -> no answer (blocked) */ }
        }
        const selected = decision === 'approve' ? ['approve'] : decision === 'decline' ? ['decline'] : []
        return { answers: [{ id: 'po-approve', selected }] }
      },
    }
    // Set the single provider slot directly, owned by this plugin's lifetime.
    // registerProvider() would attach the registration to the service's own
    // fiber via ctx.effect; observed empirically that slot is torn down before
    // the async review pipeline reaches ask() (see AGE-63 spike notes), so we
    // keep the provider for the plugin lifetime instead.
    this.userQuestions.provider = provider
    this.ownPoProvider = provider
  }

  /** Plugin-unload cleanup: restore the provider slot only if it is still ours. */
  dispose() {
    if (this.userQuestions && this.userQuestions.provider === this.ownPoProvider) {
      this.userQuestions.provider = undefined
    }
    this.ownPoProvider = null
  }

  async askPo(record) {
    this.debug(record, 'ask-po-start')
    try {
      const answer = await this.userQuestions.ask({
        questions: [
          {
            id: 'po-approve',
            header: 'GovernLoop-DSH: destructive action authorization',
            question: `Authorize the one-shot retry of the destructive action blocked by checkpoint ${record.id} (${record.ruleId})?\nCommand: ${record.command}`,
            detail: 'The independent ChatGPT review is advisory evidence only and does NOT authorize execution. Explicit Product Owner authorization is required. The token authorizes ONLY the exact denied call, once.',
            options: [
              { label: 'approve', description: `Mint a one-shot token for the exact denied call (expires in ${Math.round(this.config.tokenTtlMs / 60000)} min)` },
              { label: 'decline', description: 'Keep the action blocked' },
            ],
          },
        ],
      })
      const selected = answer?.answers?.[0]?.selected ?? []
      if (selected.includes('approve')) return 'approve'
      if (selected.includes('decline')) return 'decline'
      return 'unknown-answer'
    } catch (err) {
      return err?.code || (err && err.message) || 'NO_PROVIDER'
    }
  }

  /** Session gone / cancelled: abandon the checkpoint, clear the latch. */
  onAgentGone(agent) {
    const record = this.bySession.get(agent.id)
    if (record) {
      this.debug(record, 'session-cancelled')
      this.bySession.delete(agent.id)
    }
  }

  fail(record, code, message) {
    record.status = 'FAILED'
    record.blockedReason = `${code}: ${message}`
    this.debug(record, 'failed', { code, message })
    // Fail-closed: for destructive checkpoints the latch stays set until
    // explicit human resolution (AGE-61 §4.5). No auto-resend, no unlock.
    // The agent already saw the deny reason in the tool result; the human
    // resolves via the debug/ops channel or a future command surface.
  }
}
