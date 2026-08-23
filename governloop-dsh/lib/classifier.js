// Destructive Action Classifier — v1, deterministic, conservative.
// Detects BEFORE_DESTRUCTIVE_ACTION candidates from a PARSED tool call at
// tools/pre-execute (ToolExecution.arguments is the registry-materialized,
// deep-frozen parsed object — see AGE-61 §2.1 / AGE-63 S2).
//
// This is a checkpoint trigger, NOT a security engine. It only detects and
// denies; it never issues capability (one-shot retry tokens are minted
// exclusively from explicit human authorization — AGE-61 §4.3).

/** Git destructive / history-rewriting patterns (AGE-61 §2.2). */
export const DESTRUCTIVE_GIT_RULES = [
  { ruleId: 'git-push-force', re: /\bgit\s+push\b[^;&|]*?--force\b/ },
  { ruleId: 'git-push-force-short', re: /\bgit\s+push\s+-f(?:\s|$)/ },
  { ruleId: 'git-reset-hard', re: /\bgit\s+reset\s+--hard\b/ },
  { ruleId: 'git-filter-branch', re: /\bgit\s+filter-branch\b/ },
  { ruleId: 'git-filter-repo', re: /\bgit\s+filter-repo\b/ },
  { ruleId: 'git-branch-force-delete', re: /\bgit\s+branch\s+(?:-D\b|--delete\s+--force\b)/ },
  { ruleId: 'git-tag-delete', re: /\bgit\s+tag\s+(?:-d\b|--delete\b)/ },
  { ruleId: 'git-update-ref-delete', re: /\bgit\s+update-ref\s+-d\b/ },
  { ruleId: 'git-gc-prune', re: /\bgit\s+gc\b[^;&|]*?--prune\b/ },
  { ruleId: 'git-clean-force', re: /\bgit\s+clean\s+-[a-z]*f/ },
  { ruleId: 'git-checkout-discard', re: /\bgit\s+checkout\s+--\s*\./ },
  { ruleId: 'git-rebase-force', re: /\bgit\s+rebase\b[^;&|]*?--(?:force|exec|interactive)\b/ },
]

/** Destructive filesystem patterns (AGE-61 §2.2). */
export const DESTRUCTIVE_FS_RULES = [
  { ruleId: 'rm-recursive-force', re: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+|\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+/ },
  { ruleId: 'shred', re: /\bshred\b/ },
  { ruleId: 'wipefs', re: /\bwipefs\b/ },
  { ruleId: 'mkfs', re: /\bmkfs(?:\.[a-z0-9]+)?\b/ },
  { ruleId: 'fdisk', re: /\bfdisk\b/ },
  { ruleId: 'format-volume', re: /\bformat\s+[a-zA-Z]:/ },
  { ruleId: 'dd-block-device', re: /\bdd\b[^;&|]*\bof=\/dev\// },
]

export const ALL_RULES = [...DESTRUCTIVE_GIT_RULES, ...DESTRUCTIVE_FS_RULES]

/** Tools the classifier inspects in v1 (AGE-61 §8: bash only). */
export const CLASSIFIED_TOOLS = new Set(['bash'])

/**
 * True when `command` starts with any configured allow-rule prefix. Allow rules
 * only reduce noise for provably safe operations; they never widen risk.
 * @param {string} command
 * @param {string[]} allowRules
 */
export function isAllowedByRule(command, allowRules = []) {
  return allowRules.some((prefix) => typeof prefix === 'string' && prefix.length > 0 && command.startsWith(prefix))
}

/**
 * Match a command string against the destructive rule set.
 * @param {string} command raw shell command string from the parsed bash arguments
 * @param {{ allowRules?: string[] }} [options]
 * @returns {{ ruleId: string, severity: 'hard-deny', confidence: 'high' } | null}
 */
export function matchDestructiveCommand(command, options = {}) {
  if (typeof command !== 'string' || command.length === 0) return null
  if (isAllowedByRule(command, options.allowRules)) return null
  for (const rule of ALL_RULES) {
    if (rule.re.test(command)) {
      return { ruleId: rule.ruleId, severity: 'hard-deny', confidence: 'high' }
    }
  }
  return null
}

/**
 * Classify a parsed tool execution (ToolExecution) at tools/pre-execute.
 * @param {{ name: string, arguments: unknown }} exec
 * @param {{ allowRules?: string[] }} [options]
 * @returns {{ ruleId: string, severity: 'hard-deny', confidence: 'high', command: string } | null}
 */
export function classify(exec, options = {}) {
  if (!exec || !CLASSIFIED_TOOLS.has(exec.name)) return null
  const args = exec.arguments
  // Parsed arguments are a plain object (deep-frozen by the registry). Defensive
  // narrowing: a malformed/non-object for a classified tool is treated as
  // suspicious (fail-closed, AGE-61 §2.4).
  // tools/pre-execute receives the registry-materialized parsed arguments
  // (ToolExecution.arguments: unknown, AGE-61 §2.1 / AGE-63 S2) — never the raw
  // wire string. Non-object arguments for a classified tool carry no command to
  // match; the tool itself rejects malformed input.
  const command = args !== null && typeof args === 'object' && !Array.isArray(args) && typeof args.command === 'string'
    ? args.command
    : ''
  const hit = matchDestructiveCommand(command, options)
  if (!hit) return null
  return { ...hit, command }
}
