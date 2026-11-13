# Bots manage app settings (`app_settings`)

Date: 2026-11-12. Base: origin/main 2d74ba961.

**Reworked Nov 13, on the owner's rule of no new asks, cards or confirm steps at Full access.** There is no `confirm`
tier and no Change/Cancel card. Every setting that was `confirm` now applies at once with Undo, as `safe` does; Undo
restores the value read just before the change (per bot, the fields that change; for an added engine, its removal).
What can't be undone, or could lock the person out, is owner-only: the bot says in one line where in Settings the
person changes it. That adds `people.signIn` (changing sign-in), `remote.domain` and `remote.httpsAddress` (turning
off remote access the person may be using), `profile.photo` (a file), removing an AI engine (its setup and key are
deleted) and turning off `remote.wifi`, `remote.relay` or `remote.tailscale`. Where the sections below say `confirm`,
read `safe`, except for those.

## Goal

A bot can find, explain and change MausBot's own settings from chat: add an AI provider, reorder bots, group them into sidebar sections, switch the theme, change thread limits, and answer "where do I change X?" for every setting. Settings stop being a page the user has to learn.

## Risks this design closes

1. **Tool-definition bloat.** Every turn already ships about 60 KB of tool schemas. This adds one tool with a short schema. Setting details are looked up with `find`, never listed in the schema.
2. **A hijacked bot rewriting the app.** Bots default to Full access. A bot that reads a poisoned page or email must not be able to point a provider at an attacker's URL, read a key, raise its own permissions, or open the computer to the network. The guards are below.

## Data shape

One registry, `SETTINGS`, keyed by a stable id. Each entry:

```ts
type SettingTier = "safe" | "secret" | "owner-only";

interface SettingEntry<V> {
  id: SettingId;              // "appearance.skin", "providers.openai.url", "bots.order"
  label: string;              // English, for the bot and the card
  help: string;               // one line: what it does
  where: string;              // "Settings → Voice", from settings-index where one exists
  synonyms?: string[];        // for find
  tier: SettingTier;
  value?: z.ZodType<V>;       // absent for secret and owner-only
  read(): string;             // display; never a secret: a key reads as "set" or empty (unset)
  current?(): V;              // the typed value as write takes it, kept in server memory for Undo
  write?(value: V): Promise<string | null>;  // a refusal, or null; absent for secret and owner-only
}
```

The tier is the whole policy. Handlers branch on the tier, never on the id. As built (`server/app-settings/registry.ts`)
the entry is a discriminated union on `tier`, so a `safe` entry must carry `value`, `current` and `write`,
a `secret` entry carries only its `credentialId`, and an `owner-only` entry carries neither. Entries close over the
registry's deps instead of taking a `ctx`.

| Tier | Behaviour | Examples |
|---|---|---|
| `safe` | Applies at once. Posts an applied-change card with Undo. | skin/theme, Simple or Advanced, font, chat width, send key, notification sounds, language, bot order, sidebar groups, thread limits and cleanup, room turn timeout, MCP call timeout, default model for new bots |
| `secret` | `set` never takes a value. It posts the existing secret card (`secretCards.requestCredential` with a `CREDENTIAL_TARGETS` id). The person types the key into the card. The bot hears only provided or dismissed. | provider keys (OpenAI, Anthropic, OpenRouter, Mistral, Groq, ...) |
| `owner-only` | Readable and explainable. `set` is refused with one line saying where in Settings the person changes it. | Cloud account, Vault, backups and restore, pairing devices, lending folders, sidebar picture, organization, who may sign in, custom domain, HTTPS address, your photo |

## Guards

- **Owner turns only for writes.** Every `set` requires `phones.turnOwner({ botId, threadId, generation }) !== null`. That already refuses peer asks, relayed lines, webhook and routine runs the owner did not write, guests, shared-membership servers, and service-trust loopback. Reads are allowed in any turn the internal gate admits.
- **No secret ever reaches the bot.** `read` returns configured-or-not for keys. Secret writes go only through the secret card.
- **No card waits on an answer.** Every write applies at once with an applied card and Undo, at every approval level.
- **Write budget.** At most 10 writes per turn (generation). The rest are refused.
- **Fences stay closed.** The new internal route is not added to the outside, Bot API or read-and-draft allowlists, so confined turns are refused by default.
- **Every change is recorded.** `appendDecision` with `source: "app-settings"`, the setting id, before and after display values (never secrets), and the decision.
- **Undo is stale-safe.** Undo restores `before` only when the current value still equals `after`. Otherwise it refuses with `UNDO_STALE`.

## Tool

One tool, `app_settings`, in `TOOL_DEFINITIONS`:

```
action: "find" | "get" | "set"
query?: string     // find: words, e.g. "dark mode", "openai key"
id?: string        // get, set
value?: unknown    // set, validated by the entry's zod schema
```

- `find` returns up to 8 matches: id, label, tier, current display value, where.
- `get` returns one entry with help and allowed values.
- `set` follows the tier.

## Window-only preferences

Skin, Simple mode, font, chat width, send key and notification sounds live in the renderer's localStorage. The server pushes a change as an SSE event; the renderer applies it with the existing setters (`src/lib/skins.ts`, `src/lib/interface-mode.ts`, and so on) and reports its current values back so `read` can show them. If no window is connected, `set` on these refuses with "Open MausBot on this computer first".

## Wiring

- `shared/app-settings.ts`: ids, tiers, schemas, card payload type.
- `server/app-settings/`: registry handlers and the hold service.
- `server/routes/internal-app-settings.ts`: `createInternalAppSettingsRoutes(deps)`, dispatched inside the internal capability block next to `createInternalMcpRoutes`.
- `OptionCardData.appSettingRequest`: `{ settingId, label, before, after, tier }`, display values only.
- Card answers: a resolve branch in both respond routes in `bot-messages.ts`, with `ownerReview`.
- Undo: a branch in `undoAppliedChange`.
- Renderer: `ApprovalCard` title for the new card. Phones draw the generic options card already. The negative option must be "Cancel".
- `server/index.ts` and `src/state/store.tsx` are at their size pins. New wiring is offset by moving lines out.

## Out of scope

Cloud, Vault and backup writes. Adding, signing in or removing sign-in accounts (Claude, ChatGPT, Antigravity). (Remote access moved
in, on cards; see "Everything else, on approval" below.)

## As built (2026-11-12)

Deviations from the design above, each chosen as the safer or simpler option:

- **Undo keeps the typed earlier value in server memory**, keyed by the card's request id, not on the card. The card carries
  display strings only, as designed; a display string cannot be parsed back into a number, an id list or the groups map.
  After a server restart an older applied card's Undo answers "This change can't be undone here."
- **A confirm write runs when the owner taps Change**, inside the card's answer route, so a refused write (the config
  route's 4xx) is shown to the person on the tap and reaches the bot through the hold. The hold carries applied, failed,
  cancelled or timed out to the waiting tool call.
- **Secret entries are derived from `CREDENTIAL_TARGETS`** as `keys.<credentialId>` (19 entries), so a new credential card
  target is a setting with no further registration.
- **`where` strings live in the registry.** `src/components/settings/settings-index.ts` imports lucide icons and the
  renderer's locale types, so it is not imported server-side.
- **Window preferences change only while an owner's app window holds its live stream open** (`/api/events?window=1`).
  With none open, `set` refuses with "Open MausBot on this computer first". The window reports its values with
  `PUT /api/window-prefs` so `read` can show them.
- **The write budget counts accepted sets** (a safe or confirm write, or a secret card request). A set refused by
  validation, the tier or the turn does not spend it.
- **A groups write leaves an emptied group in place** rather than deleting it; the group's own delete rules
  (`serverError.department.*`) stay with the sidebar.
- **Stop closes a waiting "Change X?" card at once.** Stopping or revoking the turn, or the call going away, marks the
  card unavailable and tells the bot nothing changed; a later tap changes nothing. Once the owner taps Change the answer
  is settled, so a Stop that lands while the write runs still reports the change.
- **The tool is in every profile** and is not a bridge hot tool: on the bridged list it is reached through `find_tool`.
- **Writes use the Settings window's own routes** (`PUT /api/config`, `PUT /api/bots/order`, `POST /api/sidebar-sections`)
  through `server/routes/call-route.ts`, so provider reloads, broadcasts and refusals are the Settings window's. On a
  shared-membership server (a Team Cloud) `turnOwner` is null for every turn, so no write happens there.
- **AI engines are one `confirm` setting, `engines`.** `get` lists each engine's id, name and address, never a key.
  `set` takes `{"kind":"ollama"|"lmstudio","url"}`, `{"kind":"openai-compat","name","url","keyFrom"}`,
  `{"kind":"bedrock",...}` or `{"kind":"remove","instanceId"}`, and always posts a card naming what changes. A key never
  passes through the bot: any key-like field is refused, and `keyFrom` names a key the person saved through the secure
  card, read by the server only when the owner taps Change (the card says which saved key the engine will receive).
  Removal is refused before any card for sign-in accounts, built-in engines, and an engine a bot, its backups, its
  threads or the new-bot default uses; the card warns when it is the only working engine. Writes go through
  `POST /api/instances/*` and `DELETE /api/instances/:id`, so the Settings window's checks (including a running turn on
  the engine) still apply.

## Everything else, on approval (2026-11-13)

The owner asked for every remaining Settings value, each one behind a Change/Cancel card. Every newly added setting is
`confirm`; the 15 `safe` entries stay `safe`, and the existing `confirm` and `secret` entries are unchanged. The registry
now holds 104 settings: 15 safe, 62 confirm (8 before), 19 secret, 8 owner-only (6 before).

**Owner-only moved to confirm, and why that is safe.** Per-bot approval mode (`bots.approvalModes`, value
`{"botId","mode"}`), remote access (`remote.wifi`, `remote.relay`, `remote.tailscale`, `remote.keepAwake`,
`remote.httpsAddress` off only, `remote.domain`) and computer sharing (`computer.sharing`, the
`features.sharedComputers` switch) are now `confirm`. The card is what keeps them safe: its Change counts only with
`ownerReview` (the desktop app or a paired Full-access device), so a bot's own shell on loopback gets 403, and the confirm
path never reads `fullAccess()`, so Full access never skips it. Every card names the bot and the effect in plain words
(`Let Kiwi act without asking (Full access)`, `Let your paired phones reach this computer from anywhere, through MausBot's
relay`, `... A lent folder can be used to reach a shell`). `describe` refuses before any card an unknown bot, Custom
approval (desktop app only), and Approve for me on this computer's own desktop (the route takes that only with the
warning the bot's Settings dialog shows). The approval change is sent with `applyToAllThreads`, as the bot panel does.
`cloud.account` and `vault.logins` stay owner-only.

**How the new groups write.**

- Per-bot (`server/app-settings/registry-bots.ts`): `PATCH /api/bots/:id` through `routes.botPatch`, so the route's own
  checks run (name limits, the colour list, `checkedModelSelection` with `requireAvailableModel`, Custom and hosted
  Full-access refusals, the default bot's rules). `current()` is undefined, so a per-bot card has no Undo.
- Server config (`server/app-settings/registry-config.ts`): `PUT /api/config` through `routes.config`, validated first
  with the route's own section schema (`CONFIG_PATCH_FIELDS` exported from `server/config.ts`). Other routes go through
  a new `call(route, ...)` dep: `POST`/`DELETE /api/settings/custom-domain` (moved out of `server/index.ts` into
  `server/routes/custom-domain.ts`), `POST /api/starter/awake`, `PATCH /api/skills-library/:name` and
  `PUT /api/bots/:id/skills-library`. A route that throws (the domain verifier) comes back as a refusal.
- Window and desktop (`server/app-settings/registry-window.ts`): a confirm variant of `windowPref`; the frame goes out
  only on Change. `src/lib/window-prefs.ts` applies each with the row's own setter, and reaches desktop-only ones through
  the preload bridge (`openAtLogin`, `talkShortcut`, `windowFrame`, `rail`, `workspaces.color`, `updatesConsent`,
  `companion`). Reads may be async; a preference whose bridge is absent is left out of the report, and the server refuses
  a preference the window never reported ("The open MausBot window can't change this here").
- Keys: `withoutKeys` (the engines refusal, now shared) wraps every object value that could carry one; decider and
  image sections drop their key fields, and `read` strips any key, token, secret or password field.
- Anything that sends data off the computer says so on its card: decision provider, image provider, product update
  emails (your address goes to MausBot), usage analytics (PostHog).

**Inventory** (every row of `src/components/settings/settings-index.ts`):

| Row | Setting id(s) | Tier | Written by |
|---|---|---|---|
| pair, paired | `phone.pairing` | owner-only | pairing takes a code; removal and per-device grants stay in Settings |
| wifi | `remote.wifi` | confirm | window → `companion.setRoute("wifi")` |
| relay | `remote.relay` | confirm | window → `companion.setRoute("relay")` (needs a MausBot sign-in) |
| keep-awake | `remote.keepAwake` | confirm | window → `companion.keepAwake` |
| wake-automations | — | skipped | opens Automations, not a value |
| tailscale | `remote.tailscale`, `remote.httpsAddress` | confirm | window → `companion.setTailscale` / `setRoute("https", false)`; turning HTTPS on needs the pairing flow |
| domain | `remote.domain` | confirm | `POST`/`DELETE /api/settings/custom-domain`, checked live |
| sidebar-color | `appearance.sidebarColor` | confirm | window → `workspaces.color` |
| sidebar-picture | `appearance.sidebarPicture` | owner-only | a picture file |
| show-helper | `sidebar.showHelper` | confirm | `PATCH /api/bots/:id {sidebarHidden}` on the default bot |
| providers | `engines` | confirm (existing) | `/api/instances/*`; sign-in accounts stay in Settings |
| keys | `keys.*`, provider addresses | secret, confirm (existing) | secure card; `PUT /api/config` |
| backup-model | `ai.backupModel` | confirm | `PUT /api/config {automaticRecovery}` |
| routing | `ai.routing` | confirm | `PUT /api/config {decider}` without keys; its keys have no secure-card target, so they are typed in Settings |
| images | `ai.images` | confirm | `PUT /api/config {imageGen}` without keys (OpenAI image key is `keys.openaiImageApiKey`) |
| about-you | `profile.name`, `profile.email`, `profile.aboutMe`, `profile.photo` (remove only), `bots.everyBotRules` | confirm | `PUT /api/config {profile}` / `{everyBotRules}`; a new photo is a file |
| away-emails | — | skipped | Team Cloud only and per person; a Team Cloud never has an owner turn |
| new-bots | `bots.newBotEffort`, `bots.newBotTemplate`, `bots.defaultModel` | confirm, confirm, safe (existing) | `PUT /api/config {newBots}` / `{newBotDefaults}`; sharing as a preset is an export |
| limits | `bots.keepWarm`, `bots.awake`, `mcp.callTimeoutMinutes` | confirm, confirm, safe (existing) | `PUT /api/config {cacheKeepWarm}`; `POST /api/starter/awake` |
| parallel | `threads.maxConcurrentPerBot` | safe (existing) | `PUT /api/config` |
| group-turns | `rooms.turnTimeoutMinutes` | safe (existing) | `PUT /api/config` |
| skills | `skills.library`, `bots.skills` | confirm | `PATCH /api/skills-library/:name`, `PUT /api/bots/:id/skills-library`; importing a skill is content |
| early | `bots.skillAuthoring`, `bots.skillReview`, `bots.shareLearnedSkills` | confirm | `PUT /api/config {features}` |
| all-bots | — | skipped | a page |
| browser | `desktops.browser`, `desktops.browserLocalNetwork`, `desktops.browserEngine`, `desktops.browserProfiles` | confirm | `PUT /api/config {features}` / `{browserEngine}` / `{browserProfiles}`; removing a profile deletes its logins, so it is refused |
| desktop-kinds | `desktops.privateDesktop` | confirm | `PUT /api/config {localVm}`; pull, start, stop and remove are actions |
| saved-steps | `desktops.savedSteps` | confirm | `PUT /api/config {features}` |
| (computer sharing) | `computer.sharing`, `computer.lending` | confirm, owner-only | `PUT /api/config {features.sharedComputers}`; each lent folder is picked and confirmed in the desktop's own dialogs |
| vault | `vault.logins` | owner-only | logins and secrets |
| spending | — | skipped | information |
| backups | `data.backups` | owner-only | no schedule or location exists; a backup takes a password, the company schedule a typed confirmation, restore and delete are destructive |
| bring-in | — | skipped | a one-time import |
| move | `data.keepHere` | owner-only | the desktop takes it only from the person's click |
| storage | `threads.eventLogRetentionDays`, `threads.eventLogMaxBytes` | safe (existing), confirm | `PUT /api/config {threads}`; clearing attachments deletes data |
| activity | — | skipped | a read-only log |
| members | `people.signIn` | confirm | `PUT /api/config {signIn}` |
| bot-access | — | skipped | Team Cloud only (no owner turn there) |
| account | `cloud.account` | owner-only | sign-in |
| organization | `account.organization` | owner-only | portal sign-in |
| emails | `account.productEmails` | confirm | window → `updatesConsent.choose` |
| plan, this-week | — | skipped | billing and information |
| updates, your-computers, help, shortcuts, apps | — | skipped | actions and navigation |
| language | `general.language` | safe (existing) | `PUT /api/config` |
| send-key | `general.sendKey`, `general.followUp` | safe (existing), confirm | window |
| talk | `general.talkShortcut` | confirm | window → `talkShortcut.set` |
| notifications | `general.notificationSounds`, `general.finishedNotifications`, `general.notificationFeed` | safe (existing), confirm, confirm | window; turning device notifications on asks the system first |
| startup | `general.openAtLogin` | confirm | window → `openAtLogin.set` |
| analytics | `general.analytics` | confirm | window → `setAnalyticsEnabled` |
| light-dark, theme | `appearance.skin` | safe (existing) | window |
| bubbles | `appearance.userBubbles` | confirm | window |
| tool-calls | `appearance.toolCalls`, `appearance.runCard`, `appearance.chatWidth`, `appearance.font` | confirm, confirm, safe, safe | `PUT /api/config {features.showToolCalls}`; window |
| layout | `appearance.showComputers`, `appearance.windowFrame`, `appearance.showThreads`, `appearance.toolsLayout`, `appearance.pinnedCircles`, `appearance.universalPins`, `appearance.pinnedPages` | confirm | window (rail and frame through the desktop bridge) |
| bot-settings | `bots.approvalModes`, `bots.name`, `bots.color`, `bots.model`, `bots.archived`, `bots.settings` | confirm | `PATCH /api/bots/:id` |

**Not exposed.** A bot's outbound policy, connector and phone-app scopes, tool scope, MCP servers, fallback models,
always-allow list and managed sections are left out of `bots.settings`: the bot route refuses those loosenings from the
local API while any bot works, and the asking bot is always working while its card waits. A browser profile removal,
attachment clearing and backup restore delete data. Away emails and bot sharing exist only on a Team Cloud, where no turn
is the owner's. Window-side reads come from the window's last report, so a change made by hand since shows on the next
report, and a desktop bridge that refuses a change (Tailscale not installed, no sign-in for the relay) leaves the old value
in the next report while the bot was told it changed.

