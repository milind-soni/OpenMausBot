# Live Team studio

Status: core implementation and local verification complete. All four milestones below are covered by the [verification record](../verification/live-team.md), including two reproduced baseline test failures and explicit platform limits. The optional ideas in section 3H remain future work. Source findings refer to the reviewed upstream commit.

Prepared for Richard on September 11, 2026. Planning refresh on September 12, 2026.

Repository: the repository root
Upstream: <https://github.com/milind-soni/OpenMausBot>  
Reviewed baseline: `5491157c7679d67287ce9bdcde1c0be45faa52f0`, package version `0.1.74`.

## 1. Product idea

Give the bots a shared studio that makes their real work visible. A person should be able to glance at the room and understand who is working, what is waiting for them, how work is moving between teammates, and which results are ready to read.

The studio should feel like a place inhabited by the existing Maus characters. Its usefulness comes from making task state tangible. Its personality comes from expressive characters, illustrated workstations, and small, meaningful movements.

The defining interaction is: write a brief, choose a bot by dropping the brief onto its desk, send it, and watch the team work. Every visible action must be attributable to an actual task, handoff, approval, or result.

Success means a distinctive new app experience. A page of ordinary status cards with larger avatars would not fulfill this plan.

## 2. Recommended visual direction

Use a softly illustrated 2D studio with shallow perspective. Reuse the existing Maus bodies, colors, custom avatars, app typography, and skin tokens. Keep desk names and controls flat and readable even when the furniture has depth.

This is a proposed default. Richard selected the Live Team concept but has not yet selected an art style. A pixel-art office and a minimal spatial layout remain alternatives for the first design milestone.

The recommended studio has:

- A lightly illustrated floor and a small number of architectural cues that establish a room.
- Stable desk positions, with the same bot returning to the same station.
- Recognizable Maus characters large enough for expressions to matter.
- Small task slips, desk lamps, monitor surfaces, and a shared results shelf.
- Restrained accents from the current skin, with character colors preserving identity.
- A compact room selector and a clear way back to ordinary conversations.

Furniture should support the interactions. Start with reusable CSS/SVG furniture and the current avatar renderer. Do not add a 3D engine, a new mascot system, paid asset dependencies, or generated raster backgrounds for the first implementation.

## 3. Ideas to develop

### A. Desks that tell you what is happening

Each bot has a desk, a nameplate, and one short activity line. The pose changes when a supported state changes. The nameplate remains stable and clickable.

The desk can show a monitor when a browser or computer is available. This is an affordance to open the existing viewer. It is not a live screenshot feed by default, and entering the studio must not start a browser or VM.

A bot with multiple active threads gets a small task stack and a thread count. Selecting the stack opens those actual threads. One bot should not appear to be doing only one task when it has several.

### B. A brief you can hand to a bot

The brief composer produces a draggable task slip. Dropping it onto a desk opens a compact review surface naming the bot, destination thread or new thread, and the exact text to send. The explicit Send action uses the existing message dispatch path.

Offer an equivalent Choose bot action for keyboard and touch users. A cancelled drag leaves the draft intact. A failed send retains the draft and its retry state. Changing rooms must not redirect a pending send.

In the first version, support text briefs. File attachments can follow by reusing the established composer attachment flow.

### C. Visible handoffs

When a real handoff is accepted into the queue, show a task slip beside the source desk. When it starts running on the target, animate a short transfer along a visible route. Keep a persistent, clickable handoff marker after the motion finishes.

Clicking the marker opens the actual request and its related conversation. Repeated work between the same two bots remains separately inspectable. A historical relationship between bots does not animate as new work.

The first version should move the task slip while characters acknowledge the exchange at their desks. A short character step or turn can add personality where the existing body supports it. Walking an avatar across the entire room is a later option, since it can obscure identity and imply that other active tasks stopped.

### D. A bot waiting for you

A waiting bot adopts an alert pose and displays a persistent question marker. The studio exposes the actual pending request in one action.

Use the existing question and approval components or navigate directly to the source card. Preserve request identity, options, scope, expiration, and resolution. The studio must not invent an Allow all shortcut.

Custom image avatars use an adjacent marker instead of an invented facial expression. When several threads need attention, show a count and an explicit thread chooser.

### E. A shared results shelf

Completed work places a result slip on a shared shelf. Each slip names the bot, task, completion time, and links to the existing result message or authorized attachment.

Distinguish successful completion, failure, interruption, and a result that still requires a person's review. A completed run does not prove its output is correct. Use Open result rather than a new Accepted state in the first version.

A short placement animation gives completion a visible destination. Reading the result should not make it disappear from history. Keep the shelf bounded and provide a route to older work.

### F. Rooms with a purpose

Map existing sidebar sections to rooms. A room contains the bots the user can already see in that section. Room changes are navigation, not changes to permissions, membership, working directories, or shared context.

Show a small attention count beside other room names. Reveal details only through existing authorized data. Do not animate cross-room traffic unless a real, permitted handoff identifies both endpoints.

### G. Calm mode

Calm mode keeps the same room, desk positions, task slips, and controls while removing continuous motion and travel animations. It is a first-class presentation of the studio, not a separate reduced-feature product.

Respect the operating system's reduced-motion setting automatically. Work remains legible through text and shape. Announce meaningful attention changes politely, without reading every streaming token to screen readers.

### H. More ambitious directions

These ideas extend the studio after the first release. They are deliberately outside milestones 1 through 4, so the future goal has a finish line.

**Mission wall.** Pin “Tomorrow's launch” to a wall in the room. Selecting it highlights the participating desks, outstanding questions, and delivered outputs. Several missions can share a bot without pretending the bot belongs exclusively to one project. The visible moment is an entire room resolving into one connected project when you click its brief. This needs explicit links between a brief, its turns, and its delegations. Do not infer membership from similar message titles. This is a substantial follow-up, best aligned with the existing work-item proposal.

**Follow this task.** Click a task slip to reveal its recorded path through the studio: the original request, each actual delegation, and the returned result. Selecting a step opens its source conversation. This answers “Why is the designer working on this?” without searching several chats. Begin with a static path for one delegation. A complete journey across several turns depends on richer correlation data. Label historical inspection clearly so replay never looks like current execution.

**Review gallery.** Expand the results shelf into a pinboard of actual deliverables. An announcement appears as a readable excerpt, an image as a thumbnail, and a document as its supported preview. Open a result, write feedback, then explicitly send a revision request to the chosen bot and thread. Reuse the preview work upstream. Treat human review and successful execution as separate facts. This is a medium-to-large follow-up because artifact availability, formats, permissions, and revision destinations vary.

**While you were away.** On return, offer a quiet catch-up view that highlights new results and unresolved questions since the last visit. The user can step through events and jump to their sources without watching a compulsory animation. Start with timestamped references. A written narrative would be a separate, opt-in model operation with visible provenance, latency, and cost. This is a moderate follow-up once the core event records are dependable.

**Meeting table.** Give an existing group conversation a shared table. Highlight the actual current speaker and place its latest contribution in a readable surface beside the room. Clicking a seat opens that member's relevant context. A later “Ask this group” action can reuse group sending. Seating must not imply concurrent speaking, shared computer access, or new delegation permissions. This is a larger follow-up because group conversation identity differs from sidebar section membership.

**Make the studio yours.** Offer a few desk arrangements and optional role props while preserving stable bot identity. A lamp, bookshelf, or drawing tablet can make a room personal, but does not imply a tool is configured. Save decor and layout per workspace. Team import could eventually preview the studio that an existing team package will create. This is a smaller visual follow-up if it stays local and avoids arbitrary canvas editing or a new team-package format.

Recommended sequence after the core release: a basic task trail, then the review gallery, then the mission wall once shared work identity is available. Personalization is a useful independent contribution. The meeting table can wait for the first studio workflow to prove useful.

### I. Three art directions to compare in the prototype

**Softly illustrated studio, recommended.** Existing Maus characters sit at shallow-perspective desks, with readable nameplates, task slips, and a shared shelf. It gives the characters a visible home while fitting the current renderer and skins.

**Pixel office.** A miniature office with crisp furniture and tile-based positions. It has a strong visual identity but needs a deliberate asset strategy and treatment of custom avatars. Compare it as a visual study before committing to a second character language.

**Quiet architectural plan.** A top-down room with restrained furniture and large, readable task markers. It favors dense teams and calm use. Keep enough desk and character detail that it still feels like an inhabited studio.

Use the same four-bot launch scene to compare the alternatives. Choose based on character fit, clarity at normal desktop size, calm-mode quality, and implementation cost. Do not use decorative ambient activity to make one option appear more capable.

### J. What should make the first release memorable

Make the launch room itself the main contribution. The opening view should show four recognizable characters around a shared workspace, with a brief within reach. The user's first action should change something visible in that space.

The key sequence is a brief becoming a slip at the Coordinator's desk, a confirmed handoff moving toward a teammate, a question marker interrupting that bot's work, and a completed result finding a place on the shelf. Each step also has a useful action: inspect the assignment, read the handoff, answer the question, or open the result. Keep those actions available after any animation ends.

Give waiting a distinct visual presence. An upright hand or bright desk marker should make “someone needs me” apparent without forcing the user to inspect every chat. Give completion a destination. A shelf that accumulates actual work is more satisfying and useful than a temporary success toast.

For the first contribution, prioritize the quality of this connected sequence over extra rooms, furniture catalogs, or camera controls. A polished four-bot room is the visual proof. Six-bot and larger-team layouts prove that the same interaction model remains usable.

The recommended later centerpiece is the review gallery. It would let users see what their team made in the same place where they assigned the work. Build the mission wall after task correlation can reliably establish which outputs belong to a mission.

## 4. Layout and navigation

Entry point: add a Studio presentation alongside the existing Team Map. Keep Map available and preserve ordinary chat navigation. Persist the presentation choice locally, scoped to the connected workspace or server.

The room selector belongs in the page header. The main area contains the desks. The results shelf and attention list sit along an edge of the room. The brief composer remains easy to reach without covering a workstation.

The initial design should demonstrate four bots, six bots, and a larger team. Show at most twelve stations on one room page, with stable pagination for larger teams. A filter or jump action must still reach every visible bot. Do not fit large teams by shrinking names into unreadable text.

At narrow widths, use a vertical series of small desk scenes with identical actions. Avoid an infinite canvas, mandatory panning, or pinch zoom for basic navigation. Desktop is the primary design target. Responsive browser behavior is included. New native iOS and Android studio screens are deferred.

Opening a conversation, approval, or computer should use the established navigation and viewer components. Preserve the selected room and station when returning to Studio. In the first version, a workstation can open its bot's existing Computer panel with a Back to studio route. Keeping an interactive native browser embedded over the illustrated room is not required.

## 5. What the repository already provides

These findings are from source inspection, not a claim that the app was run and tested during planning.

- [`src/components/TeamMapPage.tsx`](../../src/components/TeamMapPage.tsx) provides section grouping, bot navigation, and a metadata refresh every three seconds while the document is visible.
- [`src/lib/team-map.ts`](../../src/lib/team-map.ts) defines the current map snapshot and derives edges. Its pair key sorts bot IDs, so opposite directions and repeated handoffs collapse into one edge. That helper is appropriate for a relationship map but insufficient for individual studio deliveries.
- [`server/index.ts`](../../server/index.ts), at the `/api/team-map` handler, returns collaborations, queued handoffs, and running handoffs. Queued rows omit the stable delegation ID. Running rows include a thread ID. Completed receipts and pending approval summaries are not part of this snapshot.
- [`server/delegations.ts`](../../server/delegations.ts) already has stable queued IDs and bounded durable terminal receipts. Its default one-hop delegation limit prevents arbitrary researcher-to-writer-to-designer chains.
- [`src/state/store.tsx`](../../src/state/store.tsx) owns the shared renderer state, message dispatch, task identities, and background-thread events. Some inactive transcript events are buffered. Do not assume all bot messages or all pending cards are present in the currently displayed transcript.
- [`src/components/Avatar.tsx`](../../src/components/Avatar.tsx), [`src/components/CursorAvatar.tsx`](../../src/components/CursorAvatar.tsx), and [`src/lib/mascot.ts`](../../src/lib/mascot.ts) provide existing body variants, expressions, and motion. Reuse these through a wrapper rather than changing global avatar behavior.
- [`src/lib/live-activity.ts`](../../src/lib/live-activity.ts) produces concise activity labels. Use authoritative narration where available and a generic working label otherwise.
- [`src/styles.css`](../../src/styles.css) provides skins and visual tokens. Add studio-specific structural tokens only where needed.
- The [delegation task-board plan](../superpowers/plans/2026-08-31-07-delegation-task-board.md) already proposes durable work items. Live Team should consume that work if it lands rather than create a competing work-management database.

The [Spaces PR #830](https://github.com/milind-soni/OpenMausBot/pull/830) was open when checked on September 11, 2026. Its head was `892dbe7eeaec14dc7f18053495654f854088b64c`. It proposes simultaneous chat cards, split layouts, and canvas navigation. Live Team has a different purpose: a compact spatial overview of activity. Recheck the PR before implementation and reuse any relevant navigation or viewer ownership work. Do not copy or merge its branch automatically.

September 12 planning refresh: the public issue listing and Spaces PR were checked again. Spaces remains open at the same head commit. The source baseline above remains the basis of this plan. Existing local implementation drafts are not evidence that its acceptance checklist has passed.

### Related open work checked for this plan

The public open-issue and PR listing was reviewed on September 11, 2026. These are integration considerations, not claims that an open proposal is implemented or that a reported bug has been reproduced locally.

- [Spaces #830](https://github.com/milind-soni/OpenMausBot/pull/830) remains open. Coordinate navigation, composer targeting, hotkey ownership, and computer-view mounting with its multi-chat work.
- [Approval outcome issue #1046](https://github.com/milind-soni/OpenMausBot/issues/1046) reports that peer receipts collapse explicit denial, expiry, and cancellation. A studio should use a neutral blocked label when the reason is ambiguous. It must not claim the user rejected a handoff without evidence. Distinct reasons depend on fixing the underlying protocol.
- [Focus issue #1011](https://github.com/milind-soni/OpenMausBot/issues/1011) reports the desktop coming to the foreground when a result arrives. Studio result arrival should update the shelf without activating the window, changing the selected conversation, or taking keyboard focus.
- [Performance audit #893](https://github.com/milind-soni/OpenMausBot/issues/893) and [bounded transcript-read PR #1100](https://github.com/milind-soni/OpenMausBot/pull/1100) reinforce the need for metadata-only studio reads and bounded history. Do not fetch every bot's transcript to animate a room.
- [Document previews #877](https://github.com/milind-soni/OpenMausBot/pull/877) and [additional preview formats #959](https://github.com/milind-soni/OpenMausBot/pull/959) are natural dependencies for the later review gallery. Start the shelf with reliable result links.
- [People and visibility PR #949](https://github.com/milind-soni/OpenMausBot/pull/949) may change which bots and threads a connected person may see. Recheck its status before defining the studio endpoint's access rules.
- [Private-thread provenance issue #776](https://github.com/milind-soni/OpenMausBot/issues/776) and [concurrent room responders issue #323](https://github.com/milind-soni/OpenMausBot/issues/323) matter for the later meeting table. Group membership alone does not establish where a reply came from or whether several agents are executing together.

## 6. State and event contract

### Separate current state from animation

Build a pure studio projection with four collections: stations, handoffs, attention items, and results. The existing server remains authoritative. The projection is a view model, not another scheduler.

Station identity is the bot ID. Work identity includes bot ID and thread ID, plus turn ID where available. Handoff identity is the existing delegation ID. Attention identity includes request ID and source thread. Result identity includes its actual turn or receipt and source conversation.

Keep direction intact for handoffs. Do not use the unordered pair key from the current map as an event ID.

### State rules

| Observed condition | Studio presentation | Important behavior |
| --- | --- | --- |
| No active work and provider available | Ready at desk | Never animate fake typing |
| Confirmed queued task | Task slip waiting at desk | Do not show it executing |
| Active turn | Working pose and current task label | Show multiple threads when applicable |
| Unresolved question or approval | Alert pose, persistent request marker | Link to the exact live request |
| Browser takeover requested | Distinct assistance marker | Open the established takeover UI |
| Confirmed successful terminal event | Result placed on shelf | One placement per result identity |
| Failure or interruption | Persistent status with details | No success celebration |
| Lost connection or unavailable engine | Last-known state marked stale or unavailable | Stop claims of live movement |

Waiting and working can coexist across a bot's threads. The station should prioritize the attention marker while retaining the active-work count. Do not derive successful completion from a transition to idle.

### Minimum data extension

Prefer an additive extension to the existing authorized team metadata path, with optional fields for older clients. If that would complicate the existing map contract, introduce one small studio projection endpoint sharing its access checks and internal helpers. Finalize that choice after a focused audit of request authorization and event delivery.

The projection needs stable handoff IDs, source and target thread references where known, authoritative state, timestamps, bounded attention references, and bounded recent result references. Fetch request bodies and result content only when opened, through the existing authorized conversation/file paths.

Initial bounds: twelve visible stations per room page, fifty recent handoffs and fifty recent results per selected room, with pagination where needed. Surface an explicit count or More action when attention exceeds the displayed page. Never silently discard an unresolved request because a display cap was reached.

Use existing SSE state where available. A bounded visible-only metadata refresh is acceptable for the first version. Transitions that can occur between polls must remain discoverable through stable receipts. Do not treat a snapshot diff as a complete event history.

Use a snapshot revision or watermark and stable IDs to deduplicate transitions. Hydration and reconnect should establish the current scene without replaying all old transfers. If the connection fails, retain the last-known layout with a clear stale indicator. If a bot is removed, cancel its visual transitions without cancelling unrelated server work.

The server must revalidate access to bots, threads, and files. Being visible in a client-side room filter is not authorization. Local presentation storage must contain only preferences and IDs, not copied conversations or credentials.

## 7. Motion and performance

Motion is a consequence of a verified transition. Model-generated prose such as “I sent this to the writer” is insufficient evidence of a handoff.

Use short acknowledgement gestures and task-slip transfers. Allow at most two prominent transfers at once. Coalesce a burst into a counted marker so the room remains understandable. Every animated event leaves an inspectable static representation.

Use transforms and opacity for movement. Keep React text controls outside decorative transforms. Pause animations and metadata refreshes when the view is hidden. A station should not rerender for every token emitted by another bot.

Profile twelve visible stations with simulated background traffic from a larger workspace. Record browser, hardware, trace, and limitations. Target smooth interaction around a 16.7 ms frame budget on the development machine, with no repeated long tasks caused by studio updates. This is a measured implementation target, not a cross-device guarantee.

All actions need keyboard and touch equivalents. Preserve visible focus, meaningful accessible names, and at least 44 px effective touch targets. In calm mode and reduced-motion mode, disable mascot drift, pointer-following effects where relevant, travel, and celebration loops as well as the studio's own CSS animations.

## 8. Demonstration story

Use an isolated workspace with a Coordinator, Researcher, Writer, and Designer. The Coordinator can use the existing permitted peer tools.

1. The user opens the launch room and writes “Prepare tomorrow's launch. Gather evidence, draft the announcement, and propose a launch graphic.”
2. The user drops the brief onto the Coordinator's desk, reviews the destination, and sends it.
3. The Coordinator starts a real turn and delegates a bounded research task. A task slip appears and then transfers when the target starts.
4. The Researcher produces a result. Its actual receipt adds an item to the shelf and allows the Coordinator to continue through supported behavior.
5. The Coordinator sends subsequent briefs to Writer and Designer. The visualization reflects their actual scheduling. It does not manufacture parallel execution.
6. One bot asks a real clarification question. The user opens and answers it through the existing request UI.
7. The Designer's workstation opens the existing browser/computer view when configured. Returning restores the launch room.
8. Completed outputs arrive on the shelf with working links to the correct conversations.
9. Calm mode shows the same work and requests with no travel motion.

Use a coordinator-centered sequence because arbitrary recursive delegation is outside this feature. Do not change recursion limits to make the demo more theatrical. The scripted fake-engine fixture must be visibly labeled as a demo, and the production scene must be connected to the same projection used by real work.

## 9. Implementation milestones

All four milestones below belong to the first implementation goal. Their checked state is supported by the verification record, screenshots, recording, and test logs. A static mockup alone would not complete it.

### Milestone 1: visual prototype and interaction design

- [x] Confirm the chosen art direction or proceed with the softly illustrated default if Richard leaves it open.
- [x] Build a working prototype inside the repository using the existing avatar renderer and skins.
- [x] Demonstrate four desks, a brief, a handoff, a waiting bot, and the results shelf with explicitly labeled fixture data.
- [x] Include a six-bot layout, a larger-team page, an empty room, narrow widths, dark/light skins, and calm mode.
- [x] Establish keyboard order and click targets before adding decorative motion.
- [x] Capture a short prototype walkthrough and revise the design against the product idea in section 1.

Exit: the studio reads as a coherent illustrated place and its core actions work locally. Record design decisions and any user feedback. Keep the fake data confined to the prototype/fixture path.

### Milestone 2: real state projection and studio integration

- [x] Recheck upstream changes, Spaces, and the work-item proposal against the recorded baseline.
- [x] Add the Studio presentation and persist its room/presentation preferences per workspace.
- [x] Implement pure state derivation and stable event identity.
- [x] Add the smallest necessary server projection for handoffs, attention, and results.
- [x] Connect the view to real state, including background threads and multiple tasks per bot.
- [x] Implement snapshot hydration, deduplication, reconnect, stale state, and removal handling.
- [x] Keep reads bounded and avoid loading every transcript or opening every computer.

Exit: real isolated server activity changes the room correctly, including failures and reconnection. No scene status depends on a scripted timer.

### Milestone 3: usable studio workflow

- [x] Wire drag-to-assign and its keyboard/touch equivalent through the existing draft/send behavior.
- [x] Pin the chosen bot and thread before sending, including busy, deleted, or unavailable targets.
- [x] Open exact handoff conversations and distinguish repeated or reverse-direction handoffs.
- [x] Open the existing approval/question UI and retain its resolution semantics.
- [x] Open workstation viewers with preserved studio return navigation.
- [x] Populate the results shelf from actual terminal records and authorized content links.
- [x] Add short event-driven motion and the complete calm-mode behavior.

Exit: the launch story runs end to end against the isolated harness. A rejected send, expired request, missing file, or unavailable computer produces an understandable state.

### Milestone 4: verification and contribution package

- [x] Add regression tests for the contracts below and run the required repository checks.
- [x] Complete real renderer verification in the disposable fixture.
- [x] Capture before/after screenshots and a video of real fixture-driven transitions.
- [x] Record performance traces, tested platforms, and untested platform limits.
- [x] Write `docs/verification/live-team.md` with exact commands and expected outcomes.
- [x] Prepare focused commits or a proposed PR split and a contribution description.

Exit: implementation is reviewable locally, checks pass or baseline failures are reproduced and clearly documented, and the full acceptance list below is satisfied. Publishing, posting to GitHub, and sending messages to maintainers are separate actions for a later explicitly authorized step.

## 10. Likely file boundaries

Names for new files are proposals. Reuse equivalent modules if upstream adds them before implementation.

- `src/components/live-team/LiveTeamStudio.tsx`: room composition and interaction ownership.
- `src/components/live-team/StudioStation.tsx`: desk, avatar, activity, and thread stack.
- `src/components/live-team/StudioHandoffs.tsx`: persistent handoff markers and bounded motion.
- `src/components/live-team/StudioResults.tsx`: result references and empty/error states.
- `src/components/live-team/StudioBrief.tsx`: draft, target review, and existing send integration.
- `src/lib/live-team.ts`: pure projection, status precedence, and filtering.
- `src/lib/live-team-motion.ts`: deduplication, transition queue, and reduced-motion rules.
- `src/lib/live-team-preferences.ts`: validated, workspace-scoped local preferences.
- `src/components/TeamMapPage.tsx` and `src/App.tsx`: presentation entry and return navigation.
- `src/state/store.tsx`: narrow integrations only, avoiding a wholesale store refactor.
- `server/index.ts`, `server/delegations.ts`, and a possible `server/live-team.ts`: bounded projection with shared authorization and existing receipts.
- Existing locale catalogs and `src/styles.css`: localized strings and scoped studio styling.
- Colocated tests and `docs/verification/live-team.md`: permanent coverage and reproduction.

Recommended review slices are the projection contract, the studio view, and the interaction/verification completion. Each slice should remain buildable. Avoid unrelated changes to providers, automation policy, native packaging, or enterprise code.

## 11. Acceptance and regression checklist

- [x] A first-time viewer can identify each bot, its work state, requests needing attention, and available results without entering a chat.
- [x] The studio visibly contains desks, characters, handoffs, and a shared results area, rather than only a rearranged card dashboard.
- [x] Every working pose, transfer, request marker, and result corresponds to authoritative state with an inspectable reference.
- [x] Two handoffs between the same bots remain distinct. Reverse-direction handoffs stay correctly directed.
- [x] Refreshing, reconnecting, and switching rooms do not replay old deliveries or duplicate results.
- [x] Multiple threads on one bot retain correct identity and do not overwrite each other's requests or send targets.
- [x] Dropping a brief stages it. Send submits it once through the established mechanism. Cancellation or failure preserves useful draft state.
- [x] Requests resolved elsewhere disappear or become resolved without a second answer being accepted.
- [x] Opening a workstation never silently provisions a computer or changes access settings.
- [x] A new result updates the shelf without stealing keyboard focus, changing the selected thread, or activating the app window.
- [x] Ambiguous blocked handoffs do not falsely attribute denial to the user.
- [x] Hidden, deleted, inaccessible, and stale entities are handled without exposing their content or routing to another target.
- [x] A successful turn with no attachment still provides a valid result-message link. A missing attachment produces a useful fallback.
- [x] The first render does not animate historical work. Disconnect shows last-known data as stale.
- [x] All core actions work without dragging, hovering, or motion.
- [x] Names and controls remain readable at 375, 768, 1024, and 1440 px widths and at 200% browser zoom.
- [x] Midnight and a light skin pass visual contrast review. Long localized labels fit.
- [x] Opening Studio does not mount twelve live browser previews, add a second SSE connection, or trigger a full-history scan per frame.
- [x] The launch demonstration succeeds through the existing allowed delegation behavior and includes a real question and a terminal result.

Pure tests should cover status precedence, identity, duplicate/out-of-order updates, room filtering, page stability, and animation coalescing. API tests should cover access, bounds, background-thread references, and receipt pagination. Real renderer tests should cover drag and keyboard assignment, focus return, request routing, workstation navigation, and result links.

Follow [`docs/verification/README.md`](../verification/README.md): use an isolated fixture and never verify mutations against the person's live app or data. Extend the actual control surface when a studio action is not yet supported. A green model test does not establish that the rendered interaction works.

Required commands at the reviewed baseline:

```sh
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm test
pnpm build
```

Run `pnpm check:electron` if desktop-shell code changes. Use relevant native smoke coverage for viewer behavior. Prioritize real macOS Electron testing for the workstation path, and clearly record what browser tests do and do not prove about Windows/Linux native views. Do not claim platform verification from shared TypeScript compilation alone.

## 12. Risks and decisions for implementation

The largest technical risk is missing or ambiguous lifecycle data. Prove the projection before polishing transitions. Preserve unknown states instead of inferring success.

The largest product risk is decorative activity becoming distracting. Keep stations stable, bound transfers, and ensure the calm scene remains equally useful.

The largest integration risk is competing ownership of native computer views. Use the existing viewer route first. An inline studio viewer can be considered only after its mounting and focus behavior is proven.

Upstream moves quickly. The recorded baseline and PR status are planning evidence, not a promise that interfaces will remain unchanged. Rebase and update the file map at implementation start. Discuss the substantial UI direction with maintainers before proposing an upstream merge, following [CONTRIBUTING.md](../../CONTRIBUTING.md). Prepare the concrete prototype and issue text locally before any request to post it.

## 13. Proposed future goal

> Implement the Live Team studio in the repository root according to `docs/plans/2026-09-11-live-team-studio.md`, completing milestones 1 through 4 and the acceptance checklist. Build a softly illustrated spatial room with the existing Maus characters, real task states, identifiable handoffs, staged brief assignment, actionable requests, workstation navigation, a results shelf, and calm mode. Reuse the current agent runtime and permission behavior. Verify the launch story in an isolated fixture, provide screenshots and video, and leave the work ready for review. Keep implementation local unless publishing or GitHub communication is separately authorized.

This was the implementation goal that Richard subsequently activated. Its core scope is now implemented and locally verified. The optional follow-ups in section 3H are not included in that completion.
