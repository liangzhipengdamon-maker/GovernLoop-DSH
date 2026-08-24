#!/usr/bin/env bash
# Product Closure E2E (AGE-65) — broken session-manager stub for the
# relay-fail scenario: the plugin spawns this and it exits 1 immediately.
echo "broken-relay: intentional failure (S3a relay-fail)" >&2
exit 1
