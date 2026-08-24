// Review envelope — structured, explicit review answers (AGE-61 §3.4).
// For destructive checkpoints, an unknown/malformed/low-confidence envelope
// must stay BLOCKED and require manual resolution — it is never treated as
// advisory/non-blocking (AGE-61 §0.2, §4.5 UNKNOWN_REVIEW).

export const ENVELOPE_VERDICTS = ['APPROVE', 'BLOCK', 'ADVISE']
export const ENVELOPE_CONFIDENCE = ['high', 'medium', 'low']

/** The marker the checkpoint message uses to solicit the envelope. */
export const ENVELOPE_MARKER = 'REVIEW_ENVELOPE:'

/**
 * Build the envelope instruction appended to every destructive checkpoint
 * message so ChatGPT answers structurally rather than in free prose.
 * B2 hardening (AGE-65 Product Closure, Round 1): the instruction now demands
 * STRICT JSON — the parser stays strict and fail-closed, so the review prompt
 * must tell the reviewer exactly which serialization mistakes would block the
 * action. No parser relaxation is added (decided: only if B2 recurs).
 * @param {string} checkpointContext human/checkpoint context already in the message
 * @returns {string} the full checkpoint message text (context + envelope request)
 */
export function buildCheckpointMessage(checkpointContext) {
  return `${checkpointContext}

Please answer ONLY inside the review envelope below. The envelope MUST be
STRICT JSON (parsed programmatically; any deviation blocks the action):

- JSON strings MUST NOT contain literal newlines or carriage returns: write
  escaped \\n (backslash-n) instead.
- No Markdown code fences (no triple backticks), no text before or after the
  envelope.
- "rationale": one single line, 1-3 sentences.
- "required_fixes": every item on its own single line (no embedded newlines).
- Verdict must be one of APPROVE, BLOCK, ADVISE; confidence one of high,
  medium, low.

${ENVELOPE_MARKER}
{
  "verdict": "APPROVE" | "BLOCK" | "ADVISE",
  "confidence": "high" | "medium" | "low",
  "rationale": "<1-3 sentences, single line>",
  "required_fixes": ["<actionable item>"]
}
`
}

/**
 * Extract the envelope JSON from a review response file.
 * Looks for the ENVELOPE_MARKER followed by a JSON object; falls back to the
 * last JSON object in the text.
 * @param {string} text
 * @returns {{ ok: true, envelope: ReviewEnvelope } | { ok: false, reason: string }}
 */
export function extractEnvelope(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, reason: 'empty-response' }
  }
  const markerIndex = text.indexOf(ENVELOPE_MARKER)
  const candidates = []
  if (markerIndex >= 0) {
    candidates.push(text.slice(markerIndex + ENVELOPE_MARKER.length))
  }
  // last {...} occurrence as a fallback
  const braceStart = text.lastIndexOf('{')
  const braceEnd = text.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) {
    candidates.push(text.slice(braceStart, braceEnd + 1))
  }
  for (const candidate of candidates) {
    const parsed = tryParse(candidate)
    if (parsed !== null) {
      const validated = validateEnvelope(parsed)
      if (validated.ok) return { ok: true, envelope: validated.envelope }
    }
  }
  return { ok: false, reason: 'envelope-missing-or-malformed' }
}

function tryParse(text) {
  try {
    // the marker may be followed by code fences or whitespace
    const cleaned = text.replace(/```json|```/g, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Validate a parsed envelope object.
 * @param {unknown} obj
 * @returns {{ ok: true, envelope: ReviewEnvelope } | { ok: false, reason: string }}
 */
export function validateEnvelope(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, reason: 'not-an-object' }
  }
  const o = obj
  if (typeof o.verdict !== 'string' || !ENVELOPE_VERDICTS.includes(o.verdict)) {
    return { ok: false, reason: 'unknown-verdict' }
  }
  if (typeof o.confidence !== 'string' || !ENVELOPE_CONFIDENCE.includes(o.confidence)) {
    return { ok: false, reason: 'unknown-confidence' }
  }
  if (typeof o.rationale !== 'string') {
    return { ok: false, reason: 'missing-rationale' }
  }
  if (o.required_fixes !== undefined && !Array.isArray(o.required_fixes)) {
    return { ok: false, reason: 'malformed-required-fixes' }
  }
  return {
    ok: true,
    envelope: {
      verdict: o.verdict,
      confidence: o.confidence,
      rationale: o.rationale,
      required_fixes: Array.isArray(o.required_fixes) ? o.required_fixes : [],
    },
  }
}

/**
 * @typedef {{ verdict: 'APPROVE'|'BLOCK'|'ADVISE', confidence: 'high'|'medium'|'low', rationale: string, required_fixes: string[] }} ReviewEnvelope
 */
