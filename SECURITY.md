# Security Policy

## Reporting a Vulnerability

If you discover a security issue in GovernLoop-DSH (or its dependency on the
GovernLoop Neutral Relay / ChatGPT Web bridge), **do not open a public issue**.
Report it privately to the maintainers of this repository (GitHub private
vulnerability reporting, or direct maintainer contact).

Please include:

- Affected version / commit (`git rev-parse HEAD`).
- A minimal repro (environment, steps, expected vs actual).
- Impact assessment if known.

You will receive an acknowledgement, and we will coordinate a fix before
public disclosure where possible.

## Scope

This repository is a research/validation-grade thin DSH adapter. The Neutral
Relay transport, delivery confirmation, and fail-closed semantics live in the
GovernLoop Core repository — report transport/relay issues there.

## Out of scope

- Secrets embedded in issues or evidence attachments (redact before sending).
- ChatGPT Web session credentials or conversation content (never share).
