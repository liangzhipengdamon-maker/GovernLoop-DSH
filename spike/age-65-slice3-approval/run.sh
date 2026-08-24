#!/usr/bin/env bash
# AGE-65 Slice 3 — DSH native approval vs GovernLoop token/latch (minimal, keyless).
# Usage: DSH_BIN=<pinned dsh> bash spike/age-65-slice3-approval/run.sh
set -euo pipefail
DSH_BIN="${DSH_BIN:?DSH_BIN required (pinned @deepseek-ai/dsh binary)}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
RUNNER="$REPO/spike/age-65-slice3-approval/a65s3-runner.mjs"
PKG_ROOT="$(cd "$(dirname "$DSH_BIN")/../@deepseek-ai" && pwd)"
A65_S3_TOOLS="$PKG_ROOT/dsh-tools/lib/index.js"

TS="$(date +%s)"
SCRATCH="/tmp/dsh-a65-s3-$TS"
OUT="$SCRATCH/findings.jsonl"
OVERLAY="$SCRATCH/overlay.yml"
mkdir -p "$SCRATCH"

cat > "$OVERLAY" <<EOF
# AGE-65 Slice 3 overlay (headless profile) — scratch, throwaway
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
    - id: a65-s3
      name: '$RUNNER'
EOF

echo "== scratch: $SCRATCH"
set +e
A65_S3_OUT="$OUT" A65_S3_TOOLS="$A65_S3_TOOLS" DSH_HOME="$SCRATCH/home" \
  "$DSH_BIN" --profile headless --patch "$OVERLAY" "approval probe" > "$SCRATCH/run.out" 2>&1
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
