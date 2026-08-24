#!/usr/bin/env bash
# Executable wrapper for the governloop session CLI (the CLI script itself
# lacks the execute bit; the plugin spawns the session manager directly).
# P1 contract fix made the plugin parse canonical Core output, so NO output
# augmentation is needed here — this only execs the real CLI via python3.
exec python3 "${GOVERLOOP_SESSION_CLI:?GOVERLOOP_SESSION_CLI required}" "$@"
