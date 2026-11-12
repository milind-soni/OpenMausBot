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
  read(ctx): Display;         // never returns a secret; keys read as "set" | "not set"
  write?(ctx, value: V): Promise<void>;  // absent for secret and owner-only
}
```

The tier is the whole policy. Handlers branch on the tier, never on the id.

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

Remote access, Cloud, Vault and backup writes. Adding or removing engine instances. Phone-side Undo for the applied card if phones do not already draw it (follow-up in mausbot-mobile).
