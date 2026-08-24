# DSH-GPTLoop — Project Outer Loop

**Status:** Product explanation for release positioning. This document does not expand runtime scope or grant new implementation authority.

## Definition

**DSH-GPTLoop is the outer loop for DeepSeek Harness.**

- **DeepSeek Harness (DSH)** is the fast local execution / inner loop.
- **GPT Web** is the persistent project reasoning + independent review / outer loop.
- **DSH-GPTLoop** connects the two without replacing DSH-native runtime capabilities.

> **Fast inner loop. Persistent outer loop. One project.**

```text
                 GPT Web
        persistent project outer loop
     context / reasoning / independent review
                 ↑
                 │
            DSH-GPTLoop
      GovernLoop bridge + DSH adapter
                 │
                 ↓
        DeepSeek Harness
        fast local execution loop
   plan / act / tools / test / resume
```

## Why an outer loop exists

A coding agent session is optimized for the work in front of it: inspect code, change files, run tools, execute tests, fix failures, and continue.

A real project has a wider lifecycle:

**Idea / Research → Product Decision → Issue → Implementation → Test → Review → PR → CI → Merge → Release → Documentation → Follow-up**

The outer loop keeps the wider project reasoning connected while the local agent moves quickly through implementation.

> **The local agent knows what it is doing now. The outer loop knows why the project is doing it.**

## GPT Web is more than a model endpoint

The value of GPT Web is not only model inference. It can be a persistent human-facing workspace where project context accumulates across many turns: research, architecture, trade-offs, product decisions, review history, blocker resolution, and follow-up reasoning.

When relevant tools are connected and authorized, that same outer-loop workspace can bring together context from multiple parts of the development lifecycle.

```text
                      GPT Web
               persistent project outer loop

      research / product / architecture / review
                         │
          ┌──────────────┼──────────────┐
          ↓              ↓              ↓
       Linear          GitHub       Docs / Drive
   issues / planning   PR / CI      specs / evidence
          │              │              │
          └──────────────┼──────────────┘
                         ↓
                    DSH-GPTLoop
                         ↓
                  DeepSeek Harness
                         ↓
               code / tools / tests
```

Examples of outer-loop context include:

- research and product reasoning;
- architecture and scope decisions;
- Linear issues, priorities, blockers, and follow-up work when Linear is connected;
- GitHub repository state, commits, pull requests, reviews, and CI evidence when GitHub is connected;
- documents, specifications, evidence, and knowledge sources when those stores are connected;
- release-readiness review and post-release follow-up.

This is a context and reasoning layer, not a new universal authority layer.

## Authority does not collapse into GPT Web

Connecting context must not blur lifecycle authority.

- **GitHub** remains authoritative for repository content, commits, pull requests, and repository lifecycle state.
- **Linear** remains authoritative for issue and project tracking when it is used.
- **CI** remains verification evidence. A passing check does not itself authorize merge, deploy, or release.
- **DSH** remains authoritative for its native runtime, execution, sandbox, permission, session, and approval behavior.
- **Humans** retain consequential lifecycle authority where required.
- **GPT Web review** is advisory evidence unless an explicit workflow grants some narrower non-destructive action.

> GPT Web does not replace those systems. **It connects their context.**

## Why this matters for different builders

### Solo builders / OPCs

A single person may act as Product Owner, researcher, architect, engineer, reviewer, operator, and release manager. The outer loop reduces repeated reconstruction of project context across those roles and across tools.

### Vibe coding workflows

Fast implementation increases the need for a stable outer loop. The bottleneck moves from only “how do I write this?” toward “what should happen next, why, under what scope, with what evidence, and who should authorize it?”

> **The faster the inner loop becomes, the more valuable the outer loop becomes.**

### Professional engineering teams

The separation can also be useful when execution and independent review should not live in the same agent context. Teams still need to respect organizational security, data-handling, access-control, and source-of-truth policies.

## DSH-GPTLoop only fills the bridge gap

This product does not attempt to replace DSH-native capabilities or the connected project tools around it.

The rule is:

1. Is the capability required by the DSH ↔ GPT Web bridge?
2. If not, it is out of scope.
3. If yes, does DSH or another authoritative system already provide it?
4. If yes, use/adapt the native capability.
5. Only add the minimum missing bridge primitive.

That keeps DSH-GPTLoop thin and makes the division of responsibility explicit.

## Current verified runtime boundary

The current verified implementation is narrower than the full conceptual outer-loop workspace above.

What is verified today is the real DSH → GovernLoop → Chrome/CDP → bound GPT Web conversation → independent review → read-back → DSH resume loop, including fail-closed error paths and explicit human authorization where required.

Connected-tool examples such as Linear, GitHub, Docs/Drive describe what GPT Web can bring into the project outer-loop workspace **when those tools are connected and authorized**. They are not claims that DSH-GPTLoop itself reimplements or owns those integrations.

Verification evidence: [`../verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md`](../verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md).
