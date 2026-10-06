# Trusted Contacts Implementation Plan

> Use superpowers:executing-plans to implement and verify each task in this session.

**Goal:** A locally testable trusted-contact scheduling workflow with messaging, remote peers and durable approvals, on one original-code branch.
**Architecture:** A strict shared contract, atomic service state, restricted scheduling executor, dedicated ingress handler, authenticated admin route module and Settings UI.
**Tech Stack:** Existing TypeScript, Node 24, Zod, React and Vitest. No new runtime dependency.
**Spec:** docs/superpowers/specs/2026-10-06-trusted-contacts-design.md

## Global Constraints

Original implementation only; do not read or copy reference implementation during coding. No live data mutations, sending, deployment or PR creation. Preserve provider-native permissions. No contact request launches arbitrary agent tools. UI must distinguish calendar invitations from booked events. Secrets appear only at creation and are omitted from public state. Keep all routes out of index.ts except dependency wiring.

## Review Focus

- A grant revoked while a read awaits must not release its result.
- Retries with changed bodies must not inherit an earlier approval.
- A failed disk save must not leave an in-memory grant or completed request.
- A forged peer response must not update another request or leak credentials.
- Timezone offsets, invalid dates and conflicting meetings must not create misleading availability.

### Task 1: Contracts, store and scheduling
Files: shared/trusted-contacts.ts, server/trusted-contacts.ts, server/trusted-contacts.test.ts.
- [x] Define validated contacts, grants, immutable availability/proposal requests, bounded intervals, state and public response interfaces.
- [x] RED: tests for expired/revoked grants, out-of-window requests, private field projection, duplicate IDs, approval/restart, disk rollback and conflicts.
- [x] Implement save-before-publish store and narrow scheduling executor. `TrustedContacts` supplies snapshot/createContact/grant/revoke/configure/receive/decide/result methods to HTTP and UI.
- [x] GREEN: focused Vitest suite.

### Task 2: Ingress, messaging and remote coordination
Files: server/trusted-contacts-http.ts, server/routes/trusted-contacts.ts, server/trusted-contacts-http.test.ts, server/webhook-ingress.ts, server/index.ts.
- [x] RED: real HTTP tests for authentication, own-request scope, request dedupe, local messages, two peers, malformed remote responses and redirects.
- [x] Implement admin routes and token-authenticated ingress. Add strict text commands for availability/proposals and durable replies. Configure and contact remote peers through owner action only.
- [x] Wire into the existing webhook listener and route table; no blanket auth exceptions on the main server.
- [x] GREEN: focused tests plus webhook/auth regression suites.

### Task 3: Calendar adapter and Settings
Files: server/trusted-calendar.ts and tests, src/components/TrustedContactsSection.tsx, src/components/SettingsModal.tsx, src/state/store.tsx, src/locales/en.json.
- [x] RED: free/busy response projection and failure tests; Settings rendering tests.
- [x] Implement calendar read adapter and Settings with contacts, grants, source controls, simulator, peers, inbox and invitation download. Use existing api, Card and locale patterns.
- [x] GREEN: tests, TypeScript and lint.

### Task 4: Local acceptance and review
Files: docs/verification/trusted-contacts.md, isolated fixture verification script/tests.
- [x] Launch disposable real harness, create two contacts, restrict a window, request free time, propose, restart, approve, download invitation, revoke and prove refusal.
- [x] Verify Settings interaction in an isolated UI; record exact commands and limitations.
- [x] Independent code review; fix material findings with regression tests.
- [x] Leave branch ready for user's local testing. No PR until requested.
