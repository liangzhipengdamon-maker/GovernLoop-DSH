#!/usr/bin/env bash
# AGE-63 targeted runtime verification — keyless headless run.
# Uses a scratch DSH_HOME so nothing touches the user's real DSH home or credentials.
set -euo pipefail

DSH_BIN="${DSH_BIN:-/Users/Zhuanz/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

TS="$(date +%s)"
SCRATCH="/tmp/dsh-verify-$TS"
OUT="$SCRATCH/findings.jsonl"
OVERLAY="$SCRATCH/overlay.yml"
mkdir -p "$SCRATCH"

cat > "$OVERLAY" <<EOF
# AGE-63 runtime-verification overlay (headless profile) — scratch, throwaway
- id: agent-default-model
  config:
    provider: mock
    model: mock-1

- insert:
    - id: probe
      name: '$REPO/spike/runtime-verification/probe.js'
EOF

echo "== scratch DSH_HOME : $SCRATCH"
echo "== overlay           : $OVERLAY"
echo "== probe out         : $OUT"

set +e
PROBE_OUT="$OUT" DSH_HOME="$SCRATCH" "$DSH_BIN" --profile headless --patch "$OVERLAY" "verify" 2>&1 | tail -60
CODE=$?
set -e
echo "== dsh exit code: $CODE"

if [ -f "$OUT" ]; then
  echo "== findings ($(wc -l < "$OUT") records) =="
  cat "$OUT"
else
  echo "== NO FINDINGS FILE — probe likely failed to load/activate =="
fi
