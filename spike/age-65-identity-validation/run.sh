#!/usr/bin/env bash
# AGE-65 first-slice identity validation — keyless headless run.
set -euo pipefail
DSH_BIN="${DSH_BIN:?DSH_BIN required (pinned @deepseek-ai/dsh binary)}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
RUNNER="$REPO/spike/age-65-identity-validation/a65-runner.mjs"
PKG_ROOT="$(dirname "$(dirname "$DSH_BIN")")/node_modules/@deepseek-ai"

TS="$(date +%s)"
SCRATCH="/tmp/dsh-a65-$TS"
OUT="$SCRATCH/findings.jsonl"
OVERLAY="$SCRATCH/overlay.yml"
mkdir -p "$SCRATCH"

cat > "$OVERLAY" <<EOF
# AGE-65 identity-validation overlay (headless profile) — scratch, throwaway
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

- id: headless-runner
  disabled: true

- insert:
    - id: a65-runner
      name: '$RUNNER'
      config:
        task: 'identity'
EOF

echo "== scratch: $SCRATCH"
set +e
A65_OUT="$OUT" DSH_PKG_ROOT="$PKG_ROOT" DSH_HOME="$SCRATCH/home" \
  "$DSH_BIN" --profile headless --patch "$OVERLAY" "identity" > "$SCRATCH/run.out" 2>&1
CODE=$?
set -e
echo "== dsh exit: $CODE"
tail -5 "$SCRATCH/run.out"
if [ -f "$OUT" ]; then
  echo "== findings =="
  cat "$OUT"
else
  echo "== NO FINDINGS =="
fi
