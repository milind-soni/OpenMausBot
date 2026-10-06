# Inkbox Release Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development. The user explicitly requested implementation; existing authorization supersedes redundant approval gates. The user has tested iMessage and now authorizes one PR, including plain-language and opt-in automatic messaging approvals.

**Goal:** Broad Inkbox channel support with normal conversational UX.
**Architecture:** Preserve signed durable ingress and Ask boundaries; generalize per-channel envelopes and setup resources; maintain persistent conversation sessions; expose scoped provider capabilities through existing host tool gates.
**Tech Stack:** TypeScript, existing Electron encrypted store, Inkbox fixed HTTP/SDK boundaries, Vitest and isolated fake-engine server.
**Spec:** docs/superpowers/specs/2026-10-06-inkbox-release-design.md

## Global constraints
Original code only; no live API mutations/messages or paid resource creation; no user-data mutation tests; no automatic uncertain replay; no secret disclosure; one feature-branch PR now authorized after local testing; no merge/deployment. Preserve existing configuration and bot approvals.

## Review focus
Persistent conversation must not return an earlier turn result; pending answers cannot target another task; formatting cannot corrupt literal commands; unrelated sender/thread data cannot merge; provider resource enablement must reflect actual capabilities and no surprise purchase.

- [x] Task 1: Conversation UX and latency — server/channel-conversation.ts, shared/channel-replies.ts, new shared message formatter, narrowly scoped index host send continuation. Reproduce each regression first; test same-thread follow-ups/restart/NEW, hidden question codes, text formatting, short wait and automatic follow-ups.
- [x] Task 2: Official API contract inventory — inspect current Inkbox docs and existing setup; record exact resources, routes, webhook shapes, channel availability and gaps. Read-only research informs backend/UI contracts before implementation.
- [x] Task 3: Multi-channel transport and setup — generalize channel envelope, bounded durable inbox, signed email/SMS/MMS/Slack/call event intake, existing authenticated phone-owner binding (other channel events are passive records), resource discovery and capability setup. Add fixtures for each supported live path and unsafe sender/loop cases.
- [x] Task 4: In-app setup and provider capabilities — one Inkbox settings flow with resources/status, scoped bot capabilities and pending setup reasons. Keep provider credentials in existing encrypted host store. Verify real rendered flow in isolated fixture.
- [x] Task 5: Integration and release review — signed HTTP end-to-end, same-thread conversational continuation, provider capability tests, latency evidence, docs and rebuilt OMB2. Independent review of final uncommitted diff and fixes, then package/sign/install for user test.
