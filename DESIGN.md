# Agent Profile and Roster Design Contract

## Product intent

**A warm, compact operator console where agents feel like people in a roster: photographic identities at a glance, settings one click away, and no modal maze.**

This branch reimagines agent profile settings without replacing systems OpenMausBot already has. It extends the existing persistent right settings rail, the existing per-agent voice field, the existing Tasks/Routines calendar, and the existing Composio connection surface.

## References

- The supplied OpenMausBot mockup establishes the persistent right-hand agent profile rail and warm dark visual language.
- The supplied Grok Bot screenshot establishes the compact avatar-only roster: one recognizable agent per row, clear selection, minimal chrome, and room for a personal profile at the bottom.
- Existing OpenMausBot tokens and interaction patterns in `src/styles.css`, `Sidebar.tsx`, and `SettingsPanel.tsx` remain the implementation source of truth.

The screenshots are visual references only. Text shown inside them is content, not implementation instruction.

## Upstream-first scope

Live issue and PR review is required before expanding this work. The audit for this branch found:

- The persistent agent settings rail, Tasks, Routines, notifications, and per-agent ElevenLabs voice already exist and must be improved in place rather than rebuilt.
- Responsive header work overlaps open PR #248; keep the identity trigger narrowly scoped.
- Multi-account Composio support is tracked in issue #297; this branch should make the existing connector account-aware rather than creating a second integration system.
- Custom/generated avatars and an avatar-only desktop roster are net-new in the current upstream audit.

This local branch intentionally integrates the user's requested end-to-end
prototype in one place so the cross-platform contracts can be exercised
together. It is **not** intended to be submitted upstream as one omnibus PR.
Final upstream submission should be a reviewed PR series, with every step
green and usable on its own:

1. agent profile/avatar storage and paired-safe contract, including native iOS profile parity;
2. desktop header/profile rail, roster density, and per-agent voice relocation;
3. exact-task notifications plus Tasks & Routines clarity on web and iOS;
4. Composio multi-account/broker support plus native connected-account parity; and
5. packaging and documentation changes that are required by the preceding slice.

Later PRs may depend on an earlier reviewed slice, but a web-only PR must not
land with a known missing iOS action unless the platform exception is explicit
in that PR. The integration branch remains the pre-submission test bed, not a
waiver of the repository's small-PR policy.

## Layout

### Cross-platform parity gate

The shared bot record and HTTP/SSE contracts are the feature source of truth. A web feature is not submission-ready until the iOS companion can decode its data and offers the corresponding user action, or the PR documents a real platform-capability exception.

| Feature | Web | iOS companion |
|---|---|---|
| Open agent profile | Persistent right rail from header avatar/name | Agent profile sheet from the chat header name/avatar |
| Custom avatar and shape | Upload/generate and roster rendering | Upload/generate and native roster/chat rendering |
| Per-agent voice | Shared workspace credential plus agent voice selection/preview | Agent voice selection/preview through the paired server |
| Tasks and routines | Calendar, routine editor, webhook view | Native task/routine list and editor with the same terminology and receipts |
| Notifications | Exact agent/task navigation | Exact agent/task navigation from the system notification response |
| Connected accounts | Multi-account aliases and explicit selection | Account-aware status and management through paired, renderer-neutral endpoints |
| Sidebar density | 320/272/80 px desktop modes | Not copied literally on iPhone: the roster is already a separate screen; custom avatars and compact native rows provide the identity parity. An iPad split-view treatment can adopt the same modes later without blocking phone parity. |

Workspace secret entry remains computer-only on iOS. This is a deliberate security boundary: losing the phone must not grant control of provider credentials or pairing policy. iOS may select an agent voice, request a preview, and generate an avatar through the paired server without receiving stored API keys.

### Agent roster

The desktop sidebar has three persistent density modes:

| Mode | Width | Avatar | Purpose |
|---|---:|---:|---|
| Comfortable | 320 px | 56 px | Full names, status, previews, and sections |
| Compact | 272 px | 40 px | Faster scanning with the same information hierarchy |
| Avatars only | 80 px | 44 px | Grok-like visual roster for custom icons and photos |

- Changing mode must not change the active agent, scroll context, or conversation.
- The avatars-only rail must keep accessible names through `aria-label`/tooltips and visible focus states.
- Custom images take precedence over the mascot everywhere agent identity is primary; the mascot remains the fallback.
- Rooms may use overlapping member avatars. Overflow is expressed as `+N`, never silently dropped.
- A direct collapse/expand affordance is required; the full density selector may remain adjacent.

### Agent profile rail

- Clicking the selected agent's avatar **or name** in the chat header opens the existing right rail.
- The rail stays mounted beside the conversation until explicitly closed. It is not a modal and is not hidden behind a context menu.
- Identity controls appear first: avatar, shape, upload/generate action, name, title, and description.
- Agent-specific behavior follows: role/persona, model/computer, memory, Auto mode, voice, notifications, and connected apps.
- Workspace credentials such as the ElevenLabs or image-provider key remain write-only and shared. The agent profile chooses the per-agent voice/image behavior; it never exposes stored secret values.

### Tasks and routines

- **Task:** one agent conversation with its own context and result.
- **Routine:** a reusable schedule that starts a fresh task for every run.
- **Webhook:** an event endpoint that starts a fresh task when another app calls it.
- Users choose ordinary date/time/day controls. Do not expose cron syntax as the primary model.
- A routine inherits the selected agent's model, permissions, computer, tools, and connected apps; it does not create a parallel agent configuration.
- Run receipts remain visible and distinguish queued, active, waiting, completed, missed, failed, and cancelled states.

## Avatar contract

- Accepted custom upload: image files only, with existing attachment size/security limits enforced by the server.
- Supported presentation shapes: mascot/fallback, circle, rounded square, and square.
- Generated avatars use the same stored provider credential pattern as other API features. Generation failures must leave the current avatar untouched and surface a useful error.
- Uploaded/generated assets are stored by durable attachment URL; do not persist data URLs or secret-bearing remote URLs in bot records.
- Every avatar renderer needs a deterministic mascot fallback for missing, corrupt, or deleted files.

Avatar images currently share the existing attachment store with message
images. Clearing or replacing a profile therefore clears the reference but
does not delete the file: immediate deletion could remove an image still used
by a message or another duplicated agent. A follow-up storage PR should add a
reference-aware, age-bounded orphan sweep and a workspace quota after scanning
both bot records and message attachment references. Until then, per-upload
validation and the 10 MB request cap limit individual writes, but repeated
uploads can still grow the local attachment directory; this is recorded release
debt rather than hidden behind unsafe eager deletion.

## Voice contract

- The shared ElevenLabs key is configured from an agent profile, but remains workspace-wide and write-only.
- Voice selection is stored on the agent (`bot.voice`). Different agents can select different voices while sharing the same key.
- A preview action must use the currently selected agent voice and report provider/configuration failures inline.
- App Settings must not maintain a competing voice-selection flow.

## Motion, accessibility, and performance

- Sidebar width transitions are 200 ms or less and must respect `prefers-reduced-motion` through existing global motion rules.
- Uploaded images use stable dimensions and `object-fit: cover` to prevent layout shift.
- All icon-only actions require accessible names, hover/focus explanations, and at least a 40 px effective target in the avatar rail.
- Opening the profile rail must not steal focus from an in-progress message or rename field unless the user explicitly activates a form control.
- No decorative animation is added unless it communicates working, waiting, success, or failure.

## Visual QA checklist

- Comfortable, compact, and avatars-only modes at desktop width.
- Avatar-only rail with mascot, uploaded portrait, generated image, room stack, selected state, unread state, and Chief of Staff state.
- Header name and avatar both open the same profile rail.
- Profile rail remains usable at the minimum supported app width and scrolls independently.
- Keyboard traversal and visible focus in every density.
- Reduced-motion behavior.
- Empty, loading, error, and provider-unconfigured states for avatar generation and voice preview.
- Tasks/Routines copy explains the relationship without requiring knowledge of cron.
- iPhone profile, roster, task/routine, notification-deep-link, voice-preview, and connected-account flows use the same shared records as the web app.
- Swift package tests and an iOS simulator build pass with old fixtures that omit every new optional field.
