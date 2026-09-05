# Channels: reusable teams across projects

- Status: proposed
- Date: 2026-08-22
- Scope of this pull request: planning only

## Summary

Add **Teams** and **Channels** so one saved roster of bots can work across several project conversations without duplicating the bots or mixing project context.

A channel should be a project-scoped conversation with its own transcript, working folder, shared instructions, responder policy, unread state, and runtime sessions. A team should be a reusable roster. The same designer, product manager, and engineer can therefore appear in `Website launch`, `Q4 kickoff`, and `Acme renewal`, while each channel remains isolated.

This should extend the existing Room implementation rather than introduce a second conversation engine. OpenMausBot already gives every room a thread, members, bulletin, working folder, responder policy, and transcript. The work is primarily a product hierarchy plus a runtime-isolation change.

## Why this is not only a sidebar feature

The current data model already lets the same bot id belong to several rooms. However, `runGroupMemberTurn` rejects a room turn whenever `bot.busy` is true. This deliberately prevents one bot from running in two conversations at once.

That guard is correct for today's runtime: activity, interruption, some computer backends, and several cleanup paths still assume one active turn per bot. Removing it only in the UI would create crossed streams, interrupt the wrong task, or let two channels control one computer.

The feature is complete only when the same bot can safely run in multiple channels at once on supported engines and resources. A visual grouping that still says “busy in another conversation” does not meet the product promise.

## Product model

Use four distinct concepts:

- **Bot**: a reusable agent identity—name, role, avatar, engine defaults, permissions, connected-app policy, and durable personal memory.
- **Team**: a saved roster of existing bots. A team does not clone or own the bots.
- **Channel**: one project conversation for a team, with isolated context and project settings.
- **Task**: a focused unit of work inside a bot or channel conversation, preserving the existing task model.

“Channel” becomes the user-facing name for a normal multi-bot room. The backend may keep `GroupRecord`, `/api/groups`, and `group` events during migration so this feature does not require a risky all-at-once rename. Auto-created bot-to-bot DM channels remain an internal/special case and do not appear under Teams.

## User experience

### Sidebar

Add a **Teams** area to the existing sidebar. Each team expands to its channels:

```text
Teams
  Launch team
    # q4-kickoff
    # website-launch
    # acme-renewal
  Research team
    # weekly-brief
```

Each channel row shows its latest speaker/preview, unread state, and active member count. Busy state belongs to the channel. A team may optionally show an aggregate such as “2 active” but should not look blocked because one member is working elsewhere.

Standalone existing rooms appear as standalone channels in a compatibility section. Users can attach one to a team later without losing its transcript.

### Creating a team

The user can:

1. create a team from existing bots;
2. save the roster produced by a Team Library import; or
3. convert an existing room roster into a team.

Creating a team never creates duplicate bots. Deleting a team never deletes its bots.

### Creating a channel

From a team, **New channel** asks for:

- channel name;
- optional working folder;
- optional shared instructions/bulletin;
- responder policy: one default member, everyone, or mentions only; and
- roster mode: inherit the team or customize this channel.

The channel opens immediately as an empty project conversation. It does not seed every bot with a greeting.

### Managing membership

Channels inherit their team's roster by default. Team roster changes propagate to inherited channels. A channel can switch to a custom roster; after that, team changes do not silently replace its membership. The UI must label the mode and offer **Reset to team roster**.

Removing a member does not erase messages already attributed to that bot. Re-adding the member restores participation but starts future turns from the visible channel context rather than reviving a hidden stale session.

### Deletion behavior

- Delete a channel: delete only its transcript and channel runtime state.
- Delete a team: default to detaching its channels as standalone channels; require a separate explicit choice to delete channels.
- Delete a bot: remove it from teams and effective channel rosters while preserving attributed historical messages.

## Data model

Use the smallest persisted team record, compatible with the direction in open PR #342:

```ts
interface TeamRecord {
  id: string;
  name: string;
  createdAt: number;
}

interface BotRecord {
  // existing fields remain
  teamId?: string;
}
```

The effective team roster is the visible bots whose `teamId` matches the team. This keeps the first release aligned with the proposed team switcher and lets one team be reused across many channels. Supporting one bot in several separately named teams can be a later many-to-many membership migration; it is not required for the motivating “same team, many projects” workflow.

Extend the existing `GroupRecord` instead of creating another transcript container:

```ts
interface GroupRecord {
  // existing fields remain
  teamId?: string;
  rosterMode?: "inherit" | "custom";
}
```

`memberIds` remains materialized on every group for compatibility and fast routing. When `rosterMode` is `inherit`, a bot assignment change atomically refreshes the `memberIds` of the team's inherited channels and normalizes `defaultResponder`. When a user customizes membership, the server sets `rosterMode: "custom"` before applying the channel roster.

Persist teams in a dedicated store file initially, using the existing atomic write pattern. Add team changes to the store event stream. A later SQLite migration can move teams and channels together; this feature should not introduce a second persistence strategy by itself.

### Migration

- Existing installations start with no `TeamRecord` values.
- Existing non-DM groups remain valid standalone channels with no `teamId`.
- Existing group transcripts, pins, working folders, and responder policies are unchanged.
- Existing team manifests remain persona/roster imports and cannot create arbitrary workspace structure from untrusted files.
- Project-mode team import may create a saved team plus its first channel, but only from caller-provided name/folder choices, preserving the current trust boundary.

## API and event contracts

Add bounded team endpoints:

```text
GET    /api/teams
POST   /api/teams
PATCH  /api/teams/:id
DELETE /api/teams/:id
POST   /api/teams/:id/channels
```

The existing group endpoints continue to read and mutate channel records during the compatibility period. A channel create request through `/api/teams/:id/channels` calls the same store primitive as `POST /api/groups`; it must not fork validation or transcript behavior.

Team mutations validate:

- bounded, non-empty names;
- unique existing bot ids;
- at least one visible member for creation;
- no DM group can receive a `teamId`; and
- inherited channels are updated as one server operation before events are broadcast.

Add `team` and `team.deleted` events. Existing `group` events remain authoritative for channel changes, allowing desktop and mobile clients to adopt team hierarchy without changing message streaming.

## Parallel runtime design

### Turn identity

Replace the global `bot.busy` ownership assumption with a turn lease keyed by conversation:

```ts
type TurnKey = `${botId}:${threadId}`;

interface ActiveTurn {
  botId: string;
  threadId: string;
  channelId?: string;
  instanceId: string;
  startedAt: number;
  resourceLease?: string;
}
```

Bot activity becomes derived state:

- no active turns: idle;
- one active turn: working;
- several active turns: working in N conversations.

Room/channel queues remain serial within one channel so its transcript and speaker bubble stay coherent. Different channel threads may run concurrently.

### Provider sessions and events

Provider sessions are isolated by `threadId`, which is already unique per room. Every driver must pass a concurrency conformance test before parallel turns are enabled for that instance. Drivers that keep a single process or mutable session outside the thread key remain serialized and show a clear reason.

All runtime routing must use the composite turn identity:

- stream events;
- approval ownership;
- reconnect and continuation state;
- stall watchdogs and absolute timeouts;
- interrupt, cancel, and cleanup;
- connector resume state;
- cost/usage accounting; and
- inspector state.

Stopping work in `#website-launch` must never interrupt the same bot in `#q4-kickoff`.

### Resource leases

Parallel reasoning does not imply parallel control of a shared computer or folder. Add explicit resource leases:

| Resource | Initial policy |
|---|---|
| Different channel working folders | Parallel when the driver is concurrency-safe |
| Same working folder | Serialized by default; show which channel holds the lease |
| This computer | Exclusive per bot and subject to existing approval boundaries |
| Per-bot Local VM | Exclusive until VMs can be scoped per channel |
| Box/VPS desktop | Exclusive per allocated desktop; separate allocations may run in parallel |
| Connected apps | Parallel, with normal provider rate limits and account selection |

The app should recommend separate folders or Git worktrees when several code channels target one repository. It must not silently let concurrent agents edit the same checkout.

### Memory and context isolation

Each channel gets:

- its own transcript and provider resume/session cursor;
- its own bulletin and working folder;
- its own compact channel summary/memory; and
- no implicit visibility into another channel's transcript.

Bot persona and explicitly durable bot memory remain shared. Channel turns read a snapshot of shared memory at dispatch. Concurrent writes to shared bot memory must go through an atomic, serialized update path; channel-local notes should be preferred for project facts. A channel must never overwrite another channel's summary.

## Security and permission boundaries

- Existing per-bot approval policy remains the upper bound; a channel cannot grant more authority than its members have.
- Connected-app account aliases are selected per turn and never stored in channel transcripts as tokens.
- Adding a powerful bot to a team does not automatically enable it in custom-roster channels.
- Local-computer and shared-workspace leases fail closed when ownership is ambiguous.
- Team and channel names/instructions are untrusted text and must not become filesystem paths or shell fragments.
- Imported team manifests cannot attach to existing bots by id, mutate existing teams, or create channels unless the local caller explicitly chooses project import.

## Mobile and companion behavior

The iOS companion should receive teams as navigation metadata while continuing to fetch channel transcripts through the existing room/thread APIs. The first mobile slice needs:

- nested team/channel list;
- unread and active state per channel;
- sending, approvals, interruption, and search in a selected channel; and
- graceful fallback that shows channels as rooms when paired with an older desktop.

Channel creation and roster administration can remain desktop-only for the first release.

## Relationship to open work

### PR #342: sidebar team switcher

PR #342 proposes the first persisted Team record, `teamId` assignment on bots and rooms, scoped search/import/export, and a sidebar team switcher. If it passes review and lands, it should be treated as the foundation for delivery PR 1 below—not reimplemented in the Channels series.

Channels still add capabilities that #342 does not claim to provide:

- several named project conversations nested under one team;
- inherited versus customized channel rosters;
- channel-level creation and management UX; and
- safe simultaneous turns for one bot across different channel threads.

The Channels implementation should be rebased after #342 and keep only the missing deltas. If #342 does not land, its useful team contract can be extracted into the smaller groundwork PR described here.

### PR #339: scout a project folder into a suggested team

PR #339 is a team-discovery/onboarding flow. It can eventually create a team's first channel on the selected folder, but it should continue to suggest before mutating and should not own team persistence, channel runtime, or concurrency behavior. Channels must work fully without the folder scout.

## Delivery as small pull requests

All implementation work stays behind a disabled feature flag until the runtime-isolation exit conditions pass.

### PR 1: team persistence and compatibility model

- Land or extract the bounded team foundation from #342: `TeamRecord`, bot assignment, atomic persistence, store operations, validation, and events.
- Extend groups with optional `teamId` and `rosterMode`.
- Add API contracts and migration tests.
- Keep the current UI unchanged.

Exit condition: teams and attached channels survive restart; existing rooms load byte-for-byte equivalent at the API boundary.

### PR 2: channel navigation and management

- Add the nested Teams sidebar.
- Add create, rename, reorder, roster-mode, detach, and delete flows.
- Reuse `GroupView`, composer, pins, search, responder policy, and working-folder UI.
- Add accessibility and compact/sidebar-density coverage.

Exit condition: users can organize one roster into several isolated channels without duplicating bots.

### PR 3: conversation-scoped turn ownership

- Introduce the active-turn registry keyed by bot and thread.
- Move interruption, approval ownership, watchdogs, activity, and cleanup to the composite key.
- Add driver concurrency capability and conformance tests.
- Keep unsafe drivers serialized with an actionable status.

Exit condition: the same supported bot can stream in two fixture channels simultaneously; stopping either one leaves the other untouched.

### PR 4: resource leases and memory isolation

- Add folder and computer lease enforcement.
- Add channel-local summaries/memory and serialized shared-memory writes.
- Surface blocked-resource ownership and safe recovery in the UI.
- Exercise Local VM, Box, VPS, host computer, and connected-app cases.

Exit condition: no two channels can accidentally share a mutable computer/folder resource, and no transcript, summary, approval, or event crosses channels.

### PR 5: migration UX, mobile, docs, and rollout

- Let users attach existing rooms to a team.
- Integrate project-mode Team Library import.
- Add companion navigation with old-desktop fallback.
- Add docs, analytics, recovery guidance, and the release flag.

Exit condition: an existing workspace upgrades without losing rooms, and the feature can be enabled by default on every supported desktop platform.

## Test matrix

### Persistence and API

- Create, rename, and delete a team.
- Duplicate, missing, hidden, and deleted bot ids.
- Inherited versus custom channel rosters.
- Default-responder normalization when membership changes.
- Detach channels on team deletion without transcript loss.
- Existing `groups.json` migration and restart durability.
- Team import cannot mutate existing records from manifest-provided ids.

### Runtime isolation

- Same bot, two channels, simultaneous streamed text.
- Same bot, direct task plus channel turn.
- Different models/engines across members and channels.
- Approval in each channel, answered independently.
- Interrupt one channel while another continues.
- Timeout, stall, crash, reconnect, and app restart with multiple turns.
- Usage and inspector events attributed to the correct channel.
- Unsupported single-session driver serializes rather than corrupting state.

### Resources

- Distinct folders run in parallel.
- Same folder is blocked/queued with a visible owner.
- Host computer, Local VM, Box, and VPS lease acquisition and release.
- Lease cleanup after cancellation, crash, timeout, and restart.
- Multiple connected accounts remain explicitly selected per channel turn.
- Concurrent shared-memory updates cannot lose either write.

### UI and accessibility

- Empty, one-team, many-team, and many-channel sidebars.
- Search finds a bot, team, channel, and channel message.
- Unread and busy indicators remain channel-scoped.
- Keyboard creation, navigation, menus, and focus restoration.
- Comfortable, compact, avatars-only, narrow-window, light, and dark modes.
- Historical messages retain sender identity after roster changes.

## Definition of done

The feature is ready when all of the following are true:

1. One saved team can own at least five channels without duplicating bots.
2. Every channel has isolated transcript, provider session, bulletin, folder, approvals, usage, and unread state.
3. The same concurrency-safe bot can work in at least two channels at the same time.
4. Interrupting, deleting, or failing one channel cannot affect another channel's turn.
5. Shared folders and computers are protected by explicit leases.
6. Existing rooms upgrade without data loss and can remain standalone.
7. Desktop search, navigation, notifications, and the iOS companion identify the correct team and channel.
8. The UI never promises parallel work for a driver or resource that is being serialized.

## Explicit non-goals for the first release

- Slack/Discord-style public servers, invite links, or multi-tenant cloud hosting.
- Cross-device collaborative editing by several human users.
- Automatic Git branching, merging, or conflict resolution.
- Copying channel transcripts into every other channel.
- Giving channels authority beyond their bots' existing permissions.
- Replacing tasks, bot-to-bot DMs, or automation runs with channels.

## Open decisions for implementation review

- Should channels be reorderable manually, or sorted by most recent activity for the first release?
- Should team-level defaults include a bulletin and responder policy, or should those always be explicit per channel?
- Which current drivers can truthfully advertise parallel-session support after conformance testing?
- Should a conflicting folder request queue automatically or require the user to retry after the lease is released?
- Is channel-local memory visible/editable in the first release, or only used internally until the memory UI is redesigned?

These decisions do not block the planning PR. They must be resolved before the corresponding implementation slice leaves its feature flag.
