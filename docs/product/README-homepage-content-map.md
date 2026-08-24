# Homepage content map

This note records where release-facing content now lives after shortening the repository homepage.

## Homepage (`README.md` / `README.zh-CN.md`)

Keep only the information needed for a first-time visitor:

- product name and one-line positioning;
- the 45-second real demo above the fold;
- Why GovernLoop;
- How it works;
- Fast install;
- concise safety and compatibility notes;
- links to deeper documentation.

## Detailed product positioning

Long-form explanation of GPT Web as the persistent project outer loop, including Linear, GitHub, Docs / Drive context and authority boundaries, lives in:

- [`DSH-GPTLoop-outer-loop.md`](DSH-GPTLoop-outer-loop.md)

The homepage should link to this document instead of repeating the full discussion.

## Technical detail

Installation, configuration, plugin internals, tests, and adapter-specific behavior live in:

- [`../../governloop-dsh/README.md`](../../governloop-dsh/README.md)

## Verification

Product Closure evidence remains in:

- [`../verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md`](../verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md)

This split is documentation-only. It does not change runtime scope or authority.
