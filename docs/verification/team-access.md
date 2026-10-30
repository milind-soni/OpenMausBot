# Chief authority over additional departments

Every bot reaches every other bot, in any department, with nothing to set up:
departments are folders, not walls. What a department decides is authority. A
Chief's own department is always its own; in its profile, open **Permissions →
Also in charge of**, select named departments and choose **Save departments**
to put it in charge of them too: it supervises their bots, gets their incidents
and escalations, retries their threads and proposes setup changes there.
Selection alone changes nothing before Save. Specialists do not inherit their
Chief's authority or permissions. Persisted empty departments are selectable
too, as is General. A new grant must name an existing department exactly.
Renaming or deleting an empty department revokes its old grants; recreating
its name never restores them. A no-op rename preserves them.

A bot's own peers list is the one setting that narrows reach. When it is set
(for example by a template), **Permissions** names the bots in it and offers
**Let it talk to every bot**, and a bot it blocks is told to say so in plain
words naming that setting.

Run these checks against disposable fixtures only:

```sh
pnpm exec vitest run server/peer-roster.test.ts server/peer-roster-owners.test.ts server/chief-of-staff.test.ts server/runtime-coordinator.test.ts server/bot-overview.test.ts src/components/bot-settings/PermissionsSection.test.ts --maxWorkers=2
pnpm exec vitest run server/peer-allowlist.e2e.test.ts server/room-coordination.e2e.test.ts server/direct-coordination.e2e.test.ts server/cloud-team-open-reach.e2e.test.ts --maxWorkers=2
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/team-access-ui.e2e.test.ts --maxWorkers=1
```

The real settings UI check creates Clive in Office and three separate
departments. It selects Engineering, Research and a persisted empty
department, proves nothing changed before Save, then checks the saved grants
and revokes Engineering. Renaming the empty department updates the open
selector and revokes its old grant; a recreated name appears unselected. The
screenshot and before/after JSON are retained beside the fixture's server log
(`.team-access.png` and `.team-access.json`). The launcher removes only its own
disposable data.

The server checks prove a bot asking a bot in another department directly on a
desktop and on a Team Cloud (from a member's private chat, with the answer
coming back there and the work staying private to that member), a room mixing
departments, an explicit peers list still narrowing reach and withholding a
result when it cuts a teammate off mid-task, no specialist authority
inheritance, demotion revoking a Chief's grants, and a Team Cloud Chief keeping
authority over exactly its person's bots. An active bot cannot give itself new
department authority through an unpaired loopback request, even with a forged
Origin header; a paired owner or packaged desktop is required.

These fixtures use scripted providers, not live model judgment. Nested
coordination is covered in `server/direct-coordination.e2e.test.ts`; a grant
does not lift the job runtime's depth limit (docs/runtime-contract.md §6).
