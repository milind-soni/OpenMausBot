# Bots manage app settings (`app_settings`)

Date: 2026-11-12. Base: origin/main 2d74ba961.

## Goal

A bot can find, explain and change MausBot's own settings from chat: add an AI provider, reorder bots, group them into sidebar sections, switch the theme, change thread limits, and answer "where do I change X?" for every setting. Settings stop being a page the user has to learn.

## Risks this design closes

1. **Tool-definition bloat.** Every turn already ships about 60 KB of tool schemas. This adds one tool with a short schema. Setting details are looked up with `find`, never listed in the schema.
2. **A hijacked bot rewriting the app.** Bots default to Full access. A bot that reads a poisoned page or email must not be able to point a provider at an attacker's URL, read a key, raise its own permissions, or open the computer to the network. The guards are below.

## Data shape

One registry, `SETTINGS`, keyed by a stable id. Each entry:

```ts
type SettingTier = "safe" | "confirm" | "secret" | "owner-only";

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
the entry is a discriminated union on `tier`, so a `safe` or `confirm` entry must carry `value`, `current` and `write`,
a `secret` entry carries only its `credentialId`, and an `owner-only` entry carries neither. Entries close over the
registry's deps instead of taking a `ctx`.

| Tier | Behaviour | Examples |
|---|---|---|
| `safe` | Applies at once. Posts an applied-change card with Undo. | skin/theme, Simple or Advanced, font, chat width, send key, notification sounds, language, bot order, sidebar groups, thread limits and cleanup, room turn timeout, MCP call timeout, default model for new bots |
| `confirm` | Always posts a "Change X?" card with Change and Cancel, at every approval level including Full access. The tool call waits on the answer (outbound-hold style, 9 minutes). Allow needs owner review. | provider base URLs (`anthropic.url`, `openaiCompat.url`/`model`, `xai.url`, `groq.url`, `meta.url`, `tts.baseUrl`) |
| `secret` | `set` never takes a value. It posts the existing secret card (`secretCards.requestCredential` with a `CREDENTIAL_TARGETS` id). The person types the key into the card. The bot hears only provided or dismissed. | provider keys (OpenAI, Anthropic, OpenRouter, Mistral, Groq, ...) |
| `owner-only` | Readable and explainable. `set` is refused with where to change it. | any bot's approval mode, remote access, Cloud account, Vault, backups, computer sharing, revealing a key |

## Guards

- **Owner turns only for writes.** Every `set` requires `phones.turnOwner({ botId, threadId, generation }) !== null`. That already refuses peer asks, relayed lines, webhook and routine runs the owner did not write, guests, shared-membership servers, and service-trust loopback. Reads are allowed in any turn the internal gate admits.
- **Full access never skips a confirm card.** The confirm path must not consult `fullAccess()`.
- **No secret ever reaches the bot.** `read` returns configured-or-not for keys. Secret writes go only through the secret card.
- **A bot cannot raise its own permissions.** Approval modes are `owner-only`.
- **Owner review on Allow.** A confirm card's Allow counts only with `ownerReview` (bot-messages.ts), so a bot's own shell cannot approve its card.
- **One open confirm card per bot.** A second `set` on a confirm setting while one waits is refused.
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

Remote access, Cloud, Vault and backup writes. Adding, signing in or removing sign-in accounts (Claude, ChatGPT, Antigravity).

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
