---
name: capture-ledger
description: "Run durable, fail-closed inbound capture sweeps with per-source cursors and Chief-only delivery."
---

# Durable Capture

Treat a capture sweep as an audited workflow, not a conversational summary.

## Source contract

Use the stable source ids from `server/capture-source-catalog.ts`. The fast
watch declares `gmail-account-1`, `gmail-account-2`, `gmail-account-3`,
`calendar-account-1`, `calendar-account-2`, `calendar-account-3`, `plaud`, and
`google-messages`. The hourly refresh declares the three calendar slots,
`drive`, `plaud`, `local-inbox`, `monarch`, `chrome-history`, `youtube`,
`ai-chatgpt`, `ai-claude`, `ai-grok`, `ai-gemini`, and
`whoop`. Account slots are independent: one authorized Gmail or Calendar
account must never be silently reused for another slot. A readiness check may
report a connector as authorized while an individual slot still needs an
alias/account assignment.

1. Call `capture_begin` before reading any source. Declare every expected
   source and whether it is required. Its returned cursor is the only start
   point for that source. First deliver any returned `pendingOutbox` reports
   to the section's Chief with `delegate_bot`, then acknowledge each delivered
   entry with `capture_ack_delivery`.
2. Read each source independently. Prefer connected-app tools for Gmail,
   Calendar, and Drive. Use `capture_read_browser_receipts` for explicitly
   captured Plaud, Google Messages, Monarch, YouTube, ChatGPT, Claude, Grok,
   Gemini tabs, and
   `capture_read_chrome_history` for default-profile title/domain history.
   AI-platform receipts are metadata-only: visible sidebar/thread/notebook
   titles, never conversation bodies, prompts, responses, attachments, or drafts.
   These local reads work only when the user has explicitly assigned this bot
   to **This computer**. Never use a failed read as evidence that a source is
   quiet.
3. Call `capture_record_source` exactly once for every declared source:
   `ok` when items were read, `empty` only after a successful read with no new
   items, `needs-auth` for sign-in/MFA/CAPTCHA, or `failed` for other errors.
   Advance a cursor only with `ok` or `empty`.
4. Classify candidate actions as exactly one of: Build, Money chase, Collect
   then deliver, Outbound follow-up, Redline/legal, Calendar/RSVP, File a loop,
   or Ignore. Suppress authentication codes, FYI-only items, routine CI/deploy
   noise, sent mail, drafts, and streams explicitly owned by another operator.
   Store new normalized evidence with `capture_memory_upsert`; retrieve only
   relevant, provenance-bearing evidence with `capture_memory_search`. Use
   `capture_memory_tombstone` only for a confirmed correction or duplicate.
5. Call `capture_finish` even when a source failed. If it returns an outbox
   entry, call `list_bots`, locate the section's Chief of Staff, and send the
   exact report plus outbox id with `delegate_bot`. Acknowledge only after the
   delegation was queued successfully.

If the process restarts, treat any interrupted run as degraded and wait for
its durable Chief report before starting a new catch-up run. Never reset a
cursor to the current time merely because a browser session or connector was
unavailable. Browser cursors should be stable item timestamps/ids; local file
cursors should include the file identity and offset where possible.

Capture is read-only. Never send or reply, accept an RSVP, change a calendar,
spend money, approve terms, publish, commit, push, delete, reset a browser
profile, or enter passwords, MFA codes, payment data, or government IDs. Ask
for human takeover when a protected input or login checkpoint appears. Reports
go to Chief only, never directly to the user. Exclude secrets, authentication
codes, and full private transcripts from reports.

Silence is valid only when every required source returned `ok` or `empty` and
there are no actionable items. A source failure always requires Chief delivery.
