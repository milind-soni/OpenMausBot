# Chief access to additional teams

A Chief's own team is always in scope. In its profile, open **Permissions →
Additional teams**, select named teams and choose **Save team access**. Selection
alone does not change access. Individual peer restrictions still narrow the
roster; specialists do not inherit their Chief's additional access or permissions.
Persisted empty teams are selectable too, as is General. A new grant must name
an existing team exactly. Rename or delete an empty team revokes its old grants;
recreating its name never restores them. A no-op rename preserves access.

Run these checks against disposable fixtures only:

```sh
pnpm exec vitest run server/peer-roster.test.ts server/chief-of-staff.test.ts server/delegations.test.ts server/bot-overview.test.ts --maxWorkers=2
pnpm exec vitest run server/peer-allowlist.e2e.test.ts server/room-coordination.e2e.test.ts --maxWorkers=2
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/team-access-ui.e2e.test.ts --maxWorkers=1
```

The real settings UI check creates Clive in Office and three separate teams.
It selects Engineering, Research and a persisted empty team, proves nothing
changed before Save, then checks the saved grants and revokes Engineering.
Renaming the empty team updates the open selector and revokes its old grant;
a recreated name appears unselected. The screenshot and before/after
JSON are retained beside the fixture's server log (`.team-access.png` and
`.team-access.json`). The launcher removes only its own disposable data.

The server checks prove explicit cross-team consultation, nested room handoffs,
no specialist access inheritance, refusal of a mixed-team transcript, demotion
revocation, and withholding a child result if access changes mid-task, including
empty-team rename/delete and recreation while a child is running. Grant changes
persist before a team name is freed: a failed rename may leave access revoked,
but never leaves a reusable name carrying old authority. An active
bot cannot give itself new team authority through an unpaired loopback request,
even with a forged Origin header; a paired owner or packaged desktop is required.

These fixtures use scripted providers, not live model judgment. Direct-chat
nested coordination is covered separately when available; granting team access
alone does not remove the existing direct-chat one-hop limit.
