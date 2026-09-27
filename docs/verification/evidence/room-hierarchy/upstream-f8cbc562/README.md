# UI verification after upstream f8cbc562

Recorded 2026-09-13, Windows / Node 24.15.0 / pnpm 10.33.0.
Before: upstream `f8cbc562b4b8ac70d343b472c29843a8f001de85`.
After: `8ad7afbc`, including that upstream and the hierarchy extension.

Both fixtures use `launchVerificationServer` and the real threads preview,
temporary homes, fake providers and four named fixture members. The randomly
named initial bot differs between fixtures. No live app or credentials are used.

The in-app browser captures show the same Development group:

- `before-group.png`: current upstream, without optional hierarchy settings.
- `after-default.png`: optional settings start unchecked.
- `after-configured.png`: discussion required, incoming Executive selected.
- `after-unrestricted.png`: incoming restriction removed, discussion retained.

All four images were visually inspected. Corresponding DOM snapshots are
retained. The two settings JSON files come from the fixture HTTP API after the
UI changes; they confirm persisted values and the same three member IDs.
Restoring unrestricted incoming requests stores `incomingGroupIds: null`.

This is a settings/UI integration check, not a new live-model experiment.
The separately rerun three-layer fixtures passed: each layer discusses before
delegation, and the branching pyramid has 15 members, 45 scripted turns,
5 work nodes, 10 assignments and 7 discussions. Earlier five-group transcript
screenshots remain in the dated integration directory; they are not relabeled
as captures of this upstream revision.

Local focused verification after the merge: 180/182 tests passed across 12
files. The two failures were the new team-computer test's POSIX mode assertion
on Windows and a symlink creation `EPERM`. The mode follow-up preserves real
atomic writes, requires mode 0600 for every write on all OSes, retains the exact
POSIX stat assertion and checks owner read/write bits on Windows. That file
then passed 9/10 cases; the unchanged symlink-security case still fails at
fixture setup on this account. Hosted CI must verify it independently.

Canvas, shared-computer and composer UI scenarios passed. Initial unpinned
browser launches timed out. The pinned agent-browser 0.36.0-omb.1 resolved that
startup problem; the saved-key scenario additionally needed a bounded wait
for visible controls, then passed in 37.14 seconds with its original behavior
and cleanup assertions. Typecheck, lint, i18n validation and build passed.

These focused checks do not constitute a full green test suite or establish
Windows ACL isolation. Final-head CI and review status are reported on the PR.
