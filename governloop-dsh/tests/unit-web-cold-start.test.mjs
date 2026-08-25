// Regression coverage for the DSH Web cold-start provider collision discovered
// with @deepseek-ai/dsh@0.1.1-rc.2:
//   governloop-dsh loaded before api-gateway and eagerly occupied the single
//   userQuestions provider slot; api-gateway then failed with DUPLICATE_PROVIDER.
//
// Contract after the fix:
//   1) plugin activation never occupies the slot;
//   2) a later native Web/ACP provider can register normally;
//   3) headless mode still gets GovernLoop's file-backed fallback just in time
//      when a tool result starts the review path.
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

function makeCtx() {
  const handlers = new Map()
  const cleanups = []
  const userQuestions = {
    provider: undefined,
    registerProvider(provider) {
      if (this.provider !== undefined) {
        const err = new Error('a user-questions provider is already registered')
        err.code = 'DUPLICATE_PROVIDER'
        throw err
      }
      this.provider = provider
    },
    async ask(input) {
      if (this.provider === undefined) {
        const err = new Error('no user-questions provider')
        err.code = 'NO_PROVIDER'
        throw err
      }
      return this.provider.ask(input)
    },
  }

  const ctx = {
    userQuestions,
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    on(name, fn) {
      handlers.set(name, fn)
    },
  }

  return { ctx, userQuestions, handlers, cleanups }
}

test('dsh web cold-start: GovernLoop leaves userQuestions slot free for api-gateway', () => {
  const { ctx, userQuestions, handlers } = makeCtx()

  apply(ctx, {})

  // This is the critical load-order assertion: plugin activation must not claim
  // the single provider slot before DSH api-gateway initializes.
  assert.equal(userQuestions.provider, undefined)

  const webProvider = {
    id: 'dsh-web-api-gateway',
    ask: async () => ({ answers: [{ id: 'po-approve', selected: ['decline'] }] }),
  }

  // Simulate api-gateway loading after governloop-dsh. Before the fix this line
  // threw DUPLICATE_PROVIDER and `dsh web` failed to boot.
  assert.doesNotThrow(() => userQuestions.registerProvider(webProvider))
  assert.equal(userQuestions.provider, webProvider)

  // A later tool result must respect the native provider rather than replace it.
  handlers.get('tools/result')({ callId: 'safe-result' }, {})
  assert.equal(userQuestions.provider, webProvider)
})

test('headless mode: fallback provider is installed lazily at first tool result', async () => {
  const { ctx, userQuestions, handlers } = makeCtx()

  apply(ctx, {})
  assert.equal(userQuestions.provider, undefined)

  // No native Web/ACP provider appears. The first tool result is late enough in
  // runtime lifecycle to install the headless fallback without blocking profile
  // cold-start.
  handlers.get('tools/result')({ callId: 'headless-result' }, {})
  assert.equal(typeof userQuestions.provider?.ask, 'function')

  // With no approval file configured, the fallback returns no selection and the
  // real review pipeline remains fail-closed upstream.
  const answer = await userQuestions.provider.ask({ questions: [] })
  assert.deepEqual(answer.answers[0].selected, [])
})
