#!/usr/bin/env bash
# AGE-65 Slice 2 — subagent delegation identity/lineage validation (keyless).
# Usage: DSH_BIN=<pinned dsh> [A65_S2_NESTED=1] bash spike/age-65-slice2/run.sh
set -euo pipefail
DSH_BIN="${DSH_BIN:?DSH_BIN required (pinned @deepseek-ai/dsh binary)}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
RUNNER="$REPO/spike/age-65-slice2/slice2-runner.mjs"
PKG_ROOT="$(dirname "$(dirname "$DSH_BIN")")/node_modules/@deepseek-ai"

TS="$(date +%s)"
SCRATCH="/tmp/dsh-a65-s2-$TS"
OUT="$SCRATCH/findings.jsonl"
OVERLAY="$SCRATCH/overlay.yml"
mkdir -p "$SCRATCH"

cat > "$OVERLAY" <<EOF
# AGE-65 Slice 2 overlay (headless profile) — scratch, throwaway
- id: agent-default-model
  config:
    provider: mock
    model: mock-1

- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')
    compression: none

- id: session-title-llm
  disabled: true

- insert:
    - id: a65-slice2
      name: '$RUNNER'
EOF

echo "== scratch: $SCRATCH (nested=${A65_S2_NESTED:-0})"
set +e
A65_S2_OUT="$OUT" A65_S2_NESTED="${A65_S2_NESTED:-0}" DSH_PKG_ROOT="$PKG_ROOT" DSH_HOME="$SCRATCH/home" \
  "$DSH_BIN" --profile headless --patch "$OVERLAY" "identity" > "$SCRATCH/run.out" 2>&1
CODE=$?
set -e
echo "== dsh exit: $CODE"
tail -4 "$SCRATCH/run.out"
if [ -f "$OUT" ]; then
  echo "== findings =="
  cat "$OUT"
else
  echo "== NO FINDINGS =="
fi
