// One-shot retry token — the ONLY capability this plugin can ever issue.
// Minted exclusively from explicit human (PO) authorization in
// AWAITING_PO_AUTHORIZATION; NEVER from a ChatGPT review (AGE-61 §4.3).
// Bound to session + call fingerprint + exact command/args + expiry; one use.

/**
 * Stable fingerprint of a tool call for token binding.
 * @param {string} cwd session workspace (canonical)
 * @param {string} name tool name
 * @param {unknown} args parsed arguments object
 */
export function fingerprint(cwd, name, args) {
  return JSON.stringify([cwd, name, args])
}

/**
 * Mint a one-shot retry token. Caller MUST have explicit human authorization.
 * @param {{ sessionId: string, checkpointId: string, callId: string, cwd: string, name: string, args: unknown, exactCommand: string, ttlMs: number, now?: number }} input
 * @returns {RetryToken}
 */
export function mintToken(input) {
  const now = input.now ?? Date.now()
  return {
    sessionId: input.sessionId,
    checkpointId: input.checkpointId,
    callId: input.callId, // audit only; the retry call has a new callId
    fingerprint: fingerprint(input.cwd, input.name, input.args),
    exactCommand: input.exactCommand,
    mintedAt: now,
    expiresAt: now + input.ttlMs,
    used: false,
  }
}

/**
 * Check whether a retry is authorized by a token.
 * @param {RetryToken | null | undefined} token
 * @param {{ sessionId: string, cwd: string, name: string, args: unknown, now?: number }} input
 * @returns {{ allow: true } | { allow: false, reason: string }}
 */
export function checkToken(token, input) {
  const now = input.now ?? Date.now()
  if (!token) return { allow: false, reason: 'no-token' }
  if (token.sessionId !== input.sessionId) return { allow: false, reason: 'wrong-session' }
  if (now > token.expiresAt) return { allow: false, reason: 'expired' }
  if (token.used) return { allow: false, reason: 'already-used' }
  if (token.fingerprint !== fingerprint(input.cwd, input.name, input.args)) {
    return { allow: false, reason: 'fingerprint-mismatch' }
  }
  if (input.args && typeof input.args === 'object' && input.args.command !== token.exactCommand) {
    return { allow: false, reason: 'command-mismatch' }
  }
  return { allow: true }
}

/** Mark a token used (one-shot). */
export function consumeToken(token) {
  if (token) token.used = true
}

/**
 * @typedef {{ sessionId: string, checkpointId: string, callId: string, fingerprint: string, exactCommand: string, mintedAt: number, expiresAt: number, used: boolean }} RetryToken
 */
