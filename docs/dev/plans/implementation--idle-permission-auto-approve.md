# Idle permission auto-approval

User approval: confirmed by Yv on 2026-09-24. Permission cards may auto-approve after 10 seconds of no app activity by default, including destructive actions. Question cards always require a person to answer.

## Design

1. Persist `autoApprovePermissions` (default `true`) and `autoApproveDelaySeconds` (default `10`, range 1–120) in app config. Expose them through `/api/config` and Settings → System & Updates.
2. Run one timer controller in the mounted React store. It tracks all pending permission cards, whether their chat is selected or not. Keyboard, pointer, wheel, and touch activity in the app restarts each pending countdown. A card's Cancel control disables its timer for the rest of the mounted session. Allow, Deny, and Dismiss settle or cancel that card immediately. Show remaining seconds on the card.
3. Send automatic Allow through the existing response API with an `autoApproved` marker. The server accepts that marker only for a pending permission card, and records the resolution as auto-approved in the card and room activity. It never auto-answers a question.
4. Test the timer with a fake clock and the server response path with an isolated harness. Run Node 24 typecheck, tests, and builds.

## Timer location and trade-off

The timer is in the UI. Closing the app stops it, and opening the app starts a fresh countdown for pending cards. The harness never approves an unattended request on its own. A suspended or backgrounded page may delay the timer until JavaScript resumes; the controller checks elapsed time when it resumes. Multiple open browser windows can each observe the same request, so the server treats an already resolved request as a conflict and only records the first resolution.
