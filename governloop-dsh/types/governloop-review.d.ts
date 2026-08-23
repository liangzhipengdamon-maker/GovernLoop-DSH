// Type-level provenance for review verdicts injected into the agent inbox
// (AGE-61 §5.2). MessageSourceMap is a merge-extensible sum type — plugins add
// their own kinds. This makes a GovernLoop review verdict structurally distinct
// from user input (kind 'user'), model output (kind 'model'), tool output
// (kind 'tool'), and GovernLoop authority (no such kind exists — reviews are
// advisory evidence only).
import type { ContextForm } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'governloop-review': {
      kind: 'governloop-review'
      /** e.g. 'BEFORE_DESTRUCTIVE_ACTION-1' */
      checkpointId: string
      /** Parsed from the structured review envelope; advisory only. */
      verdict: 'approve' | 'block' | 'advise'
      /** Opaque review identifier (conversation/turn ref), when known. */
      reviewSession?: string
      /** Fingerprint of the response file, for audit. */
      responseSha256?: string
      /** ContextForm: "a message another agent addressed to this one". */
      form?: Extract<ContextForm, 'relay'>
    }
  }
}

export {}
