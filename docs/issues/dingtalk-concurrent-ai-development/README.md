# Issues Index — dingtalk-concurrent-ai-development

Generated from: `dingtalk-concurrent-ai-development-prd.md`  
Last updated: 2026-08-27

## Scope

These tickets deliver the confirmed first milestone: a real DingTalk-to-local-candidate, single-Agent vertical loop under a single Owner. Multi-Agent concurrency, integration branches, preview deployment, default-branch merge, and the full management console remain later phases.

## Overview

| # | Title | Type | Status | Blocked by |
|---|-------|------|--------|-----------|
| [001](001-establish-runnable-project-baseline.md) | Establish runnable project baseline | AFK | TODO | None |
| [002](002-create-work-item-from-message.md) | Create Work Item from message | AFK | TODO | 001 |
| [003](003-clarify-and-publish-plan.md) | Clarify requirements and publish plan | AFK | TODO | 002 |
| [004](004-generate-trusted-isolated-candidate.md) | Generate trusted isolated candidate | AFK | TODO | 003 |
| [005](005-control-and-accept-as-owner.md) | Control and accept as Owner | AFK | TODO | 002, 004 |
| [006](006-recover-and-degrade-safely.md) | Recover and degrade safely | AFK | TODO | 004, 005 |
| [007](007-connect-real-dingtalk-stream.md) | Connect real DingTalk Stream | AFK | TODO | 002, 005 |
| [008](008-operate-secure-headless-service.md) | Operate secure headless service | AFK | TODO | 006, 007 |
| [009](009-validate-nonproduction-pilot.md) | Validate non-production pilot | HITL | TODO | 007, 008 |

## Execution order

Tickets are ordered by product capability. A dependent ticket starts only after its blockers are complete.

```text
001 ──► 002 ──► 003 ──► 004 ──► 006 ──► 008 ──► 009
          │               │       ▲       ▲
          └──────────────►005 ─────┘       │
                          └──────► 007 ─────┘
```

## Confirmed product constraints

- DingTalk is the primary interaction surface.
- The authoritative control plane is a headless service.
- The first milestone uses one Developer Agent and a sequential Work Graph.
- Only one active Owner may control, accept, deploy, merge, or administer work.
- The first milestone ends at a local candidate commit with deterministic test evidence.
- Real execution begins in a disposable Git fixture, then a non-production pilot repository.

