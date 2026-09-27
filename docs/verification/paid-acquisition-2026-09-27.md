# Signup landing verification — 27 September 2026

This branch proposes a clearer signup page and a smaller initial JavaScript entry point. It has not been deployed to production.

## Changes

- Added a product introduction, existing bot artwork and clearly labeled example briefs.
- Placed the email form before example cards in the mobile reading order.
- Removed automatic keyboard focus from the introductory view.
- Preserved email-link confirmation, resend and error handling.
- Deferred workspace code and math styles until after the session check.
- Added optional Meta registration measurement, configured through a production environment variable. No account or advertising identifiers are stored in source.
- Preserved the server's new-workspace flag through email-link verification; only a new workspace can produce CompleteRegistration. Returning logins and email requests do not.
- Added an unchecked ad-measurement preference on sign-in and in General settings. The SDK is gated on consent, the production hostname, Global Privacy Control, the existing analytics opt-out, and safe public URLs. Automatic event collection and advanced matching are disabled.

## Verification

The focused account, gateway, email, session and analytics suite, including new measurement tests, passed. The isolated fixture covers new-account signup with a stubbed email outbox, starter credit, a first reply from a stand-in model and cross-account isolation. Measurement tests cover consent, opt-outs, new versus returning accounts, duplicate suppression, excluded URLs and SDK failures.

TypeScript, the production Vite build, targeted lint, whitespace checks and brand guard passed.

The workspace is loaded through a dynamic import after the session check. Shared dependencies and styles remain in the initial load; this is not a total-page-weight or live-speed claim.

The desktop preview rendered all four images without horizontal overflow at a 1363px viewport. Mobile visual verification remains open.

## Deployment checks

Production email delivery, first-task completion, capacity and Meta receipt of conversion events remain unverified. Passing isolated fixtures does not establish production readiness.

Operational advertising records do not belong in this public source document.
