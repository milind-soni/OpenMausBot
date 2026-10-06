# Messaging Questions and Approvals Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development. User explicitly requested implementation; proceed without redundant design/permission gates.

**Goal:** Ask questions and accept bounded one-time decisions through iMessage while retaining task identity.
**Architecture:** Shared pure question formatting/answer parsing, durable transport-neutral conversation manager, and private guarded host card response. Keep provider transport/signatures independent.
**Tech Stack:** Existing TypeScript, atomic private JSON, React question components, Inkbox signed adapter, Vitest/fake-engine fixtures.
**Spec:** docs/superpowers/specs/2026-10-06-channel-answers-design.md

## Constraints and review focus
Original implementation only; no external messages, commits, PR/push, live-data mutation tests, secret echoes or generic approval credentials. Sender identity, request lineage, duplicate handling and uncertain response fences are required. Options come from provider data; no fabricated buttons.

- [x] Investigate missing options with targeted read-only evidence; retain freeform and improve useful-choice tool guidance only.
- [x] Pure format/parser with RED/GREEN tests for options, descriptions, multiple questions, selections, custom text and request-coded approvals.
- [x] Durable manager with RED/GREEN tests for same-task answers, state restore, expiry, pending state, stale replies and atomic outcome fences.
- [x] Private host integration with exact-card guard tests and message provenance.
- [x] Isolated fake-engine signed HTTP acceptance for question-answer-result and approve/deny-result, plus existing security regressions.
- [x] Independent review, focused build/lint/checks, docs and rebuilt OMB2 for local retest.

Review caught and fixed missing production card turn identity, stale queued follow-ups, SMS feedback overflow, per-question code reuse, and notification accounting against inbound rate limits. Regression failures were observed before fixes. The full signed HTTP fixture also covers outbound email holds with a synthetic provider and late persistent-question continuation.

Final verification: 139 tests in seven messaging suites; 72 setup/question regressions; signed HTTP live-provider-lifetime and late-question continuation fixtures; build, lint, locale catalog validation, actual packaged-server smoke, deep/strict signature. OMB2 rebuilt with final review fixes in its server resources and re-signed. Real phone replies/approvals remain for the user to test. No commit, push or PR.
