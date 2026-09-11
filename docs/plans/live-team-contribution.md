# Live Team contribution outline

Local contribution draft. Nothing has been posted to GitHub.

## Proposed title

Add Live Team studio with real task handoffs and actionable requests

## Proposed description

Team Map shows relationships, but following current work still requires opening several conversations. Live Team adds a studio presentation with Maus characters at workstations, a brief that can be assigned to a bot, directed handoffs, pending questions, and a shared results shelf.

Dropping a brief stages its destination. Send uses the existing message path. Workstation, question, handoff, and result actions route to the existing content and viewer components. Calm mode preserves the same information without travel motion. Rooms follow existing sidebar sections, and larger teams remain reachable through pagination and search.

The server adds bounded metadata for real task state, pending requests, and terminal results. Existing delegation and approval behavior remains authoritative. Opening a station's computer uses watch mode and does not silently start infrastructure.

Validation: the recorded browser/Electron workflow and affected state/projection tests pass all 91 tests. The full suite has 6014 passing tests and two failures reproduced on the clean baseline. Build, TypeScript, lint, locale and contrast checks pass, as do broker, Electron, and packaged-server checks. [Live Team verification](../verification/live-team.md) records exact commands, evidence, baseline failures, and platform limits.

## Proposed review slices

1. **Metadata and identities.** Shared studio contract, bounded projection, terminal metadata, handoff request references, access rules, and their tests. The existing Map response stays compatible.
2. **Studio presentation.** Workstations, rooms, task/request/result inspection, skin styling, calm mode, motion rules, and Map navigation. Depend on the metadata slice and keep the app buildable.
3. **Assignment and workstation workflow.** Background task creation, explicit send and retry, return focus, passive workstation viewing, control-surface additions, renderer fixtures, and verification documentation. Re-run the launch story against the combined branch.

These are suggested boundaries for review, not three partially working releases. Ship the complete launch workflow together unless maintainers prefer another arrangement. The implementation plan's mission wall, gallery, meeting table, and personalization ideas remain follow-ups.

## Maintainer discussion draft

I would like to contribute a Live Team presentation alongside Team Map. It gives the existing Maus characters a working studio where real handoffs, questions, and results are visible and clickable. It reuses the current runtime, conversations, and computer viewer. Spaces #830 remains open, so I have kept the studio focused on team activity and ordinary navigation rather than adding another window manager.

The local prototype and fixture recording can demonstrate the full assign, handoff, question, and result sequence, including calm mode and larger teams. Would this direction fit the project, and would the metadata, presentation, and workflow review slices be useful?

Only send this draft after Richard explicitly authorizes GitHub communication. Include a successful current recording and accurate verification results when doing so.
