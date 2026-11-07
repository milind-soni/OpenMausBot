# Phone Move-In to a Paired Computer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone paired by QR moves its pocket home's bots (chats, memory, skills, routines, attachments, ticked API keys) into the computer it is paired with, once the computer's owner says yes on that computer.

**Architecture:** The grant lives in the companion sidecar, like `browserControlAccess`: the phone asks through a sidecar-owned route, the companion asks Electron main over its private port, main shows a native dialog and answers through the control plane. While the grant is live the proxy opens a fixed list of move routes and marks those requests with `x-openmausbot-companion-move: 1`. The harness trusts that mark only on the verified companion path and only on a move route, treats such a request as owner-for-move, and lets it touch only bots that phone brought in (recorded when it creates them). Data moves over the existing `/api/cloud-send/*` receiving routes with kept ids; a ticked key moves as a `PhoneSecret` HPKE envelope through one new route and is saved by Electron main the way the desktop saves that key.

**Tech Stack:** Node 24 TypeScript (type stripping), zod, `@hpke/core`, Electron 43 main (`.mjs`), vitest, `node --test`.

**Spec:** `SupaMaus/mausbot-mobile` → `docs/superpowers/specs/2026-11-04-independent-phone-app-design.md`, section "4. Move to Cloud or Mac" and "Constraints" (read with `git -C /Users/omkar/Desktop/openmaus/mausbot-mobile-independent-apps show HEAD:docs/superpowers/specs/2026-11-04-independent-phone-app-design.md`).

## Choices this plan makes, and why

- **Native dialog, not an in-app card.** The grant lets a phone write bots and a provider key, so the yes must come from something no page, server or phone can draw or answer. Electron main's own `dialog.showMessageBox` is that (the rule `electron/lending-dialogs.mjs` states). The companion already talks to main over its private `parentPort`, and main already answers grants through the control plane (`companionBrowserControlAccess`), so the round trip needs no renderer, no polling and no new UI surface, and the dialog shows even when the window is closed. Cost: its words live in main as well, under the existing parity-test pattern (`electron/lending-words.mjs`).
- **The grant is not bound to bot ids in the companion; the harness binds the move to the bots the phone creates.** Without that bound, an approved phone could set Full access on a computer bot or replace an enabled routine's prompt (`adoptRoutine` overwrites a routine with the same id). The harness records each bot id a phone creates under its grant (`phone-move-ins.json`) and refuses every other move write.
- **Bot create keeps today's narrowing; bot patch is lifted to a bounded set.** The move's create body (`id, threadId, name, useDefaults:false, modelSelection, requireAvailableModel`) already passes `adminOnlyBotSetting`. For a brought bot, PATCH accepts profile, look, model, voice and memory settings (`MOVED_BOT_SETTINGS`), never approval level, tools, computer, folder, team or Chief: the companion README rule that "what it may do and reach" is the host's.
- **Phone lines are not stamped on a computer.** On a computer the owner's own lines name nobody; `POST /api/cloud-send/chats` keeps `owner: cloudSendOwner`, which never answers a phone, so nothing is stamped. Only the routes that need owner authority (kind, memory, files, arrived) get the phone's owner.
- **`arrived` on a computer records a phone's arrival without turning lending on.** `ownHome.here()` is true once `moved-from.json` exists, which enables shared computers on a desktop. A phone's record carries `phone: true`, `here()` ignores it, and a phone's arrival never overwrites a computer's record. The "one line per bot" `arrived` sends is the per-webhook line; a phone brings no webhooks, so no line appears.
- **No single move-in route.** The phone drives the existing receiving routes with kept ids, as the desktop's Send to My Cloud does; each call's answer is that step's receipt, and `POST /api/cloud-send/chats/verify` confirms the chats.
- **MausBot on both sides is decided by the server.** A new opt-in `mainIfUnused` on `PUT /api/cloud-send/kind` takes over as main only over an unused starter and answers `mainBot`. The phone guard forces it on for computer moves; the phone sends it itself on Cloud. Desktop to Cloud moves do not send it and behave as today.

## Global Constraints

- Repo and branch: `milind-soni/OpenMausBot`, worktree `/Users/omkar/Desktop/openmaus/OpenGrokBot-phone-move-in`, branch `feat/phone-move-in`. Commit; never push (Omkar owns publishing). No phone code here: phone code goes to `SupaMaus/mausbot-mobile`.
- Spec: "idempotent by bot id and message id, so a resend after a dropped connection adds nothing twice." Keep ids; build on `/api/cloud-send/*` and kept-id `POST /api/bots`, never `/api/teams/import`.
- Spec: "a phone paired with a computer: allowed only after the owner says yes on that computer ('Your iPhone wants to move 4 bots here. Allow?')".
- Spec: "Secrets leave the phone only to the person's own home, over that home's authenticated channel." A key value is never echoed, logged, written to chat, SQLite, SSE or a file other than where Settings keeps it.
- A paired phone without a live grant behaves exactly as today: same routes, same statuses, same messages. The one exception: a `POST /api/bots` with its own `id` answers `403 { error: "Allow this move on the computer first." }`, so a create made while the grant is gone never leaves a bot the move cannot finish.
- `server/index.ts` (15711 lines now; ratchet `scripts/testing/file-size-ratchet.test.ts`) and `electron/main.mjs` (3245, at its ratchet) gain **no lines**: wiring goes onto existing statements, logic into new modules. `index.ts` gains no request-path guard (`scripts/testing/index-route-ratchet.test.ts`). New routes follow `server/routes/README.md` (factory with explicit deps, `import type` for types).
- Comments follow `AGENTS.md`: only what code cannot say (security invariants, outside facts, public wire contracts). No narration, no PR or plan names.
- New desktop copy: keys under `moveIn.` in `src/locales/en.json`, translated in `pt-br.json`, `zh.json`, `zh-tw.json` (the spec's three languages; other packs fall back to English); `pnpm i18n:check` and `pnpm vitest run src/locales` pass. No internal words (engine, server, workspace, lent).
- Verify only against isolated fixtures (`docs/verification/README.md`), never the installed app or its data.
- Times: an ask waits `MOVE_ASK_TTL_MS = 300_000` (5 min); a grant lasts `MOVE_GRANT_TTL_MS = 1_800_000` (30 min); a move asks for 1 to `MOVE_MAX_BOTS = 200` bots.

## Review Focus

1. **The grant ends while a large request is in flight** (expiry, owner revoke, the phone's own end): the in-flight request finishes, the next move-only call gets today's 404 (the two shared calls answer as "Refusals during a move" says), `GET /api/companion/move` says `expired` or `refused`, and a resend after a new yes adds nothing twice. Tests: Task 2 "a request that began under the grant finishes; the next one gets today's 404", Task 8 resend.
2. **The same phone asks twice, or two phones ask at once:** one dialog per pending ask, shown one at a time; a repeat ask while one waits raises no second dialog. Tests: Task 1 "asking again … raises no second ask", Task 7 "asks one at a time".
3. **The phone sends a bot id the computer already has** (a collision, or an id read from `GET /api/bots`): create answers 409, the bot never becomes the phone's, and every move write for it is refused; the computer's bot is unchanged. Tests: Task 3 "a bot already on this computer never becomes the phone's", Task 8 no-grant test.
4. **The computer's MausBot already has history:** the phone's MausBot arrives as a separate bot, the computer's MausBot stays main and Chief, and the answer says `mainBot: false` so the phone renames it "MausBot from iPhone". Test: Task 5.
5. **A computer that already took a computer's move gets a phone's move:** sharing stays on and `moved-from.json` keeps the computer. Tests: Task 4 arrived and own-home tests.

## Files

| File | Responsibility |
|---|---|
| `companion/src/move-grants.ts` (new) | Per-device ask and grant state, in memory, with expiry |
| `companion/src/routes.ts` | `MOVE_ROUTES`, `isMoveRoute`, `denyReason({ move })`, the sidecar-owned `/api/companion/move` |
| `companion/src/proxy.ts` | Answers `/api/companion/move`, opens move routes under a live grant, adds the move header, long deadline for move routes |
| `companion/src/control.ts` | `POST`/`DELETE /devices/:id/move`; unpairing ends a grant |
| `companion/src/index.ts` | Wires `MoveGrants`, posts the ask to Electron main |
| `server/request-auth.ts` | `companionMove` on the verified companion path; `MOVED_BOT_SETTINGS` |
| `server/phone-move-in.ts` (new) | `moving`, `brings`, `owner`, and the guard that binds a move to its bots |
| `server/routes/bot-patch.ts`, `server/routes/cloud-send.ts`, `server/cloud-send-arrived.ts`, `server/own-home.ts`, `server/index.ts` | Wiring and the bounded lift |
| `server/default-bot.ts`, `server/cloud-send-kinds.ts` | MausBot on both sides (`mainIfUnused`, `mainBot`) |
| `server/phone-secret.ts`, `server/routes/phone-move-key.ts` (new) | Opening and saving a moved key |
| `electron/move-in-ask.mjs` (new), `electron/companion.mjs`, `electron/lending-words.mjs`, `electron/credential-patch.mjs`, `electron/main.mjs` | The dialog, the relay, and saving a provider key |
| `server/testing/desktop-parent.mjs`, `server/phone-move-in.e2e.test.ts` (new) | End to end through the companion path |

## Interface for the phone

Every call goes to the paired computer's companion with the device token (`Authorization: Bearer …`), as today. The companion adds the grant itself; the phone never sends a move header (one it sends is dropped). Every status and string below is the code's own.

**Ask and wait**

| Call | Request | Answers |
|---|---|---|
| `POST /api/companion/move` | `{ "v": 1, "bots": 4 }` (integer 1–200) | `202 { v: 1, state: "pending", expiresAt }` (asked, or already asked); `200 { v: 1, state: "granted", expiresAt }` (already live); `200 { v: 1, state: "refused" }` (the owner said no or ended the grant within the last 5 minutes: not a grant, say so and stop); `429 { error: "This computer was asked a moment ago. Ask again in a few minutes." }` (this phone ended its own ask or grant within 5 minutes of asking: show the message, never retry on a timer); `400 { error: "send { v: 1, bots }" }`; `409 { error: "Open OpenMausBot on this computer to move bots here." }` (no desktop app to ask); `500 { error: "could not ask this computer" }`; `401 { error: "pair this device from Remote access settings on the host computer" }` (unpaired) |
| `GET /api/companion/move` | none | `200 { v: 1, state: "none" \| "pending" \| "granted" \| "refused" \| "expired", expiresAt? }` (`expiresAt` with `pending` and `granted`) |
| `DELETE /api/companion/move` | none | `200 { v: 1, state: "none" }` (ends this phone's ask or grant; the next ask within 5 minutes of the last one answers `429`) |

An older computer answers all three with `403 { error: "Remote access settings are managed on the host computer" }`: say to update OpenMausBot on the computer. Poll `GET` every 2 s while `pending` (the ask expires after 5 minutes). A grant lasts 30 minutes from the yes.

**Under the grant** (`dataDir` is any fixed fake folder, e.g. `"/phone"`; attachment paths in rows start with `"/phone/attachments/"` and names match `^[A-Za-z0-9-]{1,80}\.[A-Za-z0-9]{1,10}$`)

| Call | Request | Answers |
|---|---|---|
| `GET /api/bots?messages=0` | — | today's list; find the ids already here |
| `POST /api/bots` | `{ id, threadId, name, useDefaults: false, modelSelection?, requireAvailableModel? }` (ids `^[\w-]{8,128}$`) | `201 { bot }`; `409 { error: "a bot with this id already exists here" }` (already moved: continue; only this exact error means that); `409 { error: "this conversation id is already used here" }` and `409 { error: "this workspace is limited to <N> bots" }` (the bot did not move: stop with it and tell the person, never continue); `400 { error: "id and threadId must be ids of letters, digits, - and _ (8 to 128)" }`; `403 { error: "forbidden: a paired device may say who a new bot is and how it looks, not \"<field>\"; set that on the host computer" }` for any field beyond profile, look and model. A model the computer lacks: retry without `modelSelection` |
| `POST /api/attachments` | image bytes (avatar) | today's answer; then `PATCH avatarUrl` |
| `PATCH /api/bots/:id` | profile, look, model, voice, memory and phone-app fields: `name, title, description, soul, notifications, color, mascot*, avatar*, voice, speakReplies, replyStyle, voiceNotes, memoryEnabled, memoryUpkeep, phoneApps, modelSelection, fallback, projects, playbooks, assignedSkills, hidden, pinned, unread` | `200 { bot }`; `403 { error: "forbidden: a phone's move may bring a bot's profile, look, model, voice, memory and phone-app settings, not \"<field>\"; set that on the host computer" }`. Approval level and tools are the computer's defaults. `sidebarHidden` and `welcomed` go only in the bot kind record below: PATCH answers them with `400 { error: "Only MausBot is hidden this way; archive or delete other bots." }` on a bot that is not MausBot yet |
| `PUT /api/cloud-send/kind` (bot) | `{ v: 1, key: "bot:<id>", dataDir, record: { defaultBot?: {}, chiefOfStaff?, welcomed?, pinned?, hidden?, sidebarHidden?, projects?, playbooks?, assignedSkills?, fallback?, managedSections? } }` | `200 { v: 1, ok: true, mainBot? }`. With `defaultBot`, `mainBot: true` means it is now the main MausBot; `false` means the computer's MausBot has history: `PATCH { name: "MausBot from iPhone" }` (phone-localized). Send `chiefOfStaff: true` with `defaultBot` so the computer's unused starter is archived |
| `GET /api/bots/:id/skills` | — | `{ skills: [{ name, … }] }`; install only names not listed |
| `POST /api/bots/:id/skill-template` | `{ name, description, warnings: [], source: "iPhone", text, enabled }` (`text` is SKILL.md, its `name` equal to `name`) | `201 { installed }`; `400 { error: "<the schema's message>" }` (a field missing or malformed); `400 { error: "Skill name does not match its contents" }`; `422 { error }` (the skill could not be installed). A `400` or `422` is final for that skill: skip it |
| `POST /api/cloud-send/chats` | `{ v: 1, dataDir, conversations: [{ bot, threadId, task, rows, leaf, sent }] }`: ≤200 conversations, ≤1200 rows each, rows carry `id`, `at`, `parentId`; keep each request ≤8 MB | `200 { conversations, messages, accepted: [], waiting: [], removed: [] }`; resend `waiting` later; a second send of the same rows answers `messages: 0` |
| `POST /api/cloud-send/chats/verify` | `{ v: 1, conversations: [{ threadId, ids }] }` | `200 { v: 1, conversations: [{ threadId, missing, … }] }` |
| `POST /api/cloud-send/chats/attachments` | `{ names: [...] }` | `200 { missing: [...] }` |
| `POST /api/cloud-send/chats/attachment/<name>` | raw bytes | `201 { stored: true }` new; `200` already here; `413`; `507 { full: true }` |
| `PUT /api/cloud-send/kind` (routine) | `{ v: 1, key: "routine:<id>", dataDir, record: <routine with botId of a moved bot, target: "bot">, runs? }` | `200 { v: 1, ok: true }` (arrives switched off); `409` its bot is not here yet |
| `POST /api/cloud-send/memory` | `{ v: 1, bot, files: [{ path, text }], journal? }` (no `about`, no `teams`) | `200 { v: 1, files, journal, about, teams, failed }` |
| `POST /api/cloud-send/files?path=workspaces/<bot>/<rel>&size&sha256&offset&mode=new` | raw part ≤8 MB | today's answers: `{ received }` to resume, `201 { stored: true }` when whole, `409 { conflict: true }` a different file is there, `400 { error: "not a bot file a move carries" }` (memory and skills, which move by their own calls, and other left-out paths: skip it). Never send a path with a segment that starts with `.` (any dotfile or dot-folder: `.env`, `.git`, `.claude`, `.mcp.json`…), that contains `~`, or that is named, in any capitals, `bunfig.toml`, `opencode.json` or `opencode.jsonc`: an engine's settings, hooks and MCP servers stay the computer's, and such a path answers `403 { error: "This move only brings in the bots your phone asked to move." }`. `AGENTS.md`, `CLAUDE.md` and other notes move |
| `POST /api/phone-move/key` | `{ version: 1, keyId, deviceId, target, requestKey, encapsulatedKey, ciphertext }` sealed as below, no other field | `200 { v: 1, saved: true }`; `200 { v: 1, saved: false, kept: true }` (the computer has its own key; nothing changed); `400 { error: "The encrypted key is invalid" }` (the envelope's shape); `400 { error: "Add this key on the computer." }` (a key this computer cannot keep); another `400` (the envelope did not open: never resend it); `403 { error: "This encrypted key belongs to another phone." }`; `409 { error: "This phone was paired with an older security key. Pair it again by QR code." }`; `429`, `503`, `504` retryable (cap the retries). Without a grant the companion answers `404 { error: "no route: POST /api/phone-move/key" }` |
| `PATCH /api/routines/:id` | `{ enabled: true }` | today's answer (for routines that were on) |
| `POST /api/cloud-send/arrived` | `{ v: 1, computer: "<this phone's name>", webhooks: [], bots: [ids] }`: `bots` MUST name the bots the phone brought, or they stay open to the move for 24 h | `200 { v: 1, told: 0 }` |

**Refusals during a move:**
- `404 { error: "no route: <METHOD> <path>" }` on a move-only call = no live grant: check `GET /api/companion/move`, ask again, then resume from the start (every step is idempotent).
- The two calls a paired phone also makes every day answer differently without a grant. `POST /api/bots` with an `id` answers `403 { error: "Allow this move on the computer first." }`, and nothing is made. `PATCH /api/bots/:id` answers `403 { error: "forbidden: a paired device may change how a bot looks, not \"<field>\"; change it on the host computer" }`, the same answer as for a bot the move no longer holds (after `arrived`, or 24 h after its create). Read either as the grant gone, and do as for the 404; but if `GET /api/companion/move` then says `granted`, the move no longer holds that bot: stop with it, as for the move refusal, and do not start over.
- `403 { error: "This move only brings in the bots your phone asked to move." }` = a bot the move did not create here or no longer holds (after `arrived`, or 24 h after its create), a room, a kind other than bot or routine, place-wide memory, or a file the move never carries.
- `401 { error: "pair this device from Remote access settings on the host computer" }` = unpaired.

A 403 on a routine is final, never retried: it covers a run of another bot, a run that is not an object, and a run whose `threadId` is null or names a conversation that was not moved.

**Sealing a key** (iOS 17+, the pairing QR's `secretPublicKey`): HPKE base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, info `"OpenMausBot phone credential v1"`, plaintext the key (1–4096 bytes UTF-8), AAD the UTF-8 of these five lines joined by `\n`: `openmausbot-phone-move-key-v1`, `keyId`, `deviceId`, `target`, `requestKey`. `requestKey` is a fresh `^[\w-]{1,128}$` id per key; resending the same envelope is safe. `target` is a desktop credential id: `anthropicApiKey`, `openaiApiKey`, `openrouterApiKey`, `mistralApiKey`, `cerebrasApiKey`, `groqApiKey`, `greenferenceApiKey`, `metaApiKey`, `deepseekApiKey`, `xaiApiKey`, `ttsKey` (ElevenLabs), and the other `CREDENTIAL_TARGETS` except `onePasswordToken`. A key with no target (a Gemini chat key) does not move: the sheet says to add it on the computer.

The envelope's fields: `version` is `1`. `keyId` is 22 characters: the first 16 bytes of SHA-256 over the 65 raw bytes of the QR's `secretPublicKey`, as unpadded base64url. `deviceId` is this phone's paired device id. `encapsulatedKey` is the 65-byte uncompressed P-256 encapsulated key and `ciphertext` the sealed key with its tag, both unpadded base64url: `encapsulatedKey` exactly 87 characters, `ciphertext` 23 to 5483.

After a resend of a key the phone itself saved, `{ v: 1, saved: false, kept: true }` means success: the first send saved it.

**Call order:** ask → poll until `granted` → `GET /api/bots?messages=0` → per bot, MausBot first: create, avatar, PATCH, bot kind (rename on `mainBot: false`), skills → per bot: chats in pages, verify, attachments → routine kinds → memory → files → ticked keys → `PATCH /api/routines/:id { enabled: true }` → `arrived` → `DELETE /api/companion/move` → switch to the computer.

After `arrived` the brought bots are closed to the move: the phone never replays profile steps after `arrived`. A resend of the whole move happens before `arrived`.

---

### Task 1: Move grants in the companion

**Files:**
- Create: `companion/src/move-grants.ts`
- Modify: `companion/src/control.ts` (`ControlOptions.moves`; routes beside `/devices/:id/browser-control` at :271-283; the revoke branch at :284-293)
- Modify: `companion/src/index.ts:150-175` (one `MoveGrants` instance passed to `createControlServer`)
- Test: `companion/test/move-grants.test.ts` (new), `companion/test/control.test.ts`

**Interfaces:**
- Produces:

```ts
export const MOVE_ASK_TTL_MS = 300_000;
export const MOVE_GRANT_TTL_MS = 1_800_000;
export const MOVE_MAX_BOTS = 200;
export type MoveState =
  | { state: "none" }
  | { state: "pending"; bots: number; expiresAt: number }
  | { state: "granted"; expiresAt: number }
  | { state: "refused" }
  | { state: "expired" };
export class MoveGrants {
  constructor(now?: () => number);
  /** created: false while an ask already waits or a grant is live, so no second dialog is raised. */
  ask(deviceId: string, bots: number): { state: MoveState; created: boolean };
  /** The owner's yes to the ask expiring at `expiresAt`: only that unexpired pending ask becomes a grant, so a yes to an
   * earlier ask, before a restart too, never grants a newer one. */
  allow(deviceId: string, expiresAt: number): boolean;
  /** The owner's no, a revoke, or unpairing: the ask or grant ends and reads "refused". */
  refuse(deviceId: string): void;
  /** The phone's own end: reads "none". */
  end(deviceId: string): void;
  state(deviceId: string): MoveState;
  live(deviceId: string): boolean;
}
```
- `ControlOptions.moves?: MoveGrants`. Control routes: `POST /devices/:id/move?expiresAt=<the ask's expiresAt>` → `200 companionState` | `404 { error: "no such device" }` | `409 { error: "no move to allow" }`; `DELETE /devices/:id/move` → `200 companionState` | `404`. `DELETE /devices/:id` also calls `moves.refuse(id)`.
- The step sketches below call `allow(deviceId)` as first planned; the tests as built (`companion/test/move-grants.test.ts`, `companion/test/control.test.ts`) pass the ask's `expiresAt`, and also cover the 5-minute quiet window after an ask or a No.

- [ ] **Step 1: Write the failing tests**

`companion/test/move-grants.test.ts`, with a fake clock `let now = 1_000; const grants = new MoveGrants(() => now);`:

```ts
it("an ask waits for the owner, and Allow grants that phone alone for 30 minutes", () => {
  expect(grants.ask("phone-1", 4)).toEqual({ created: true, state: { state: "pending", bots: 4, expiresAt: 1_000 + MOVE_ASK_TTL_MS } });
  expect(grants.live("phone-1")).toBe(false);
  expect(grants.allow("phone-1")).toBe(true);
  expect(grants.state("phone-1")).toEqual({ state: "granted", expiresAt: 1_000 + MOVE_GRANT_TTL_MS });
  expect(grants.live("phone-1")).toBe(true);
  expect(grants.live("phone-2")).toBe(false);
});
it("asking again while an ask waits or a grant is live raises no second ask", () => {
  grants.ask("phone-1", 4);
  expect(grants.ask("phone-1", 9).created).toBe(false);
  grants.allow("phone-1");
  expect(grants.ask("phone-1", 4)).toEqual({ created: false, state: { state: "granted", expiresAt: 1_000 + MOVE_GRANT_TTL_MS } });
});
it("Don't Allow is final for that ask; the phone may ask again later", () => {
  grants.ask("phone-1", 4); grants.refuse("phone-1");
  expect(grants.state("phone-1")).toEqual({ state: "refused" });
  expect(grants.allow("phone-1")).toBe(false);
  expect(grants.ask("phone-1", 4).created).toBe(true);
});
it("an unanswered ask expires after 5 minutes and can no longer be allowed", () => {
  grants.ask("phone-1", 4); now += MOVE_ASK_TTL_MS;
  expect(grants.state("phone-1")).toEqual({ state: "expired" });
  expect(grants.allow("phone-1")).toBe(false);
});
it("a grant ends at 30 minutes, on the owner's revoke and on the phone's own end", () => {
  grants.ask("a", 1); grants.allow("a"); now += MOVE_GRANT_TTL_MS;
  expect(grants.live("a")).toBe(false); expect(grants.state("a")).toEqual({ state: "expired" });
  grants.ask("b", 1); grants.allow("b"); grants.refuse("b");
  expect(grants.live("b")).toBe(false); expect(grants.state("b")).toEqual({ state: "refused" });
  grants.ask("c", 1); grants.allow("c"); grants.end("c");
  expect(grants.state("c")).toEqual({ state: "none" });
});
```

`companion/test/control.test.ts`: add `["POST", "/devices/x/move"]` to the list in "refuses every route without it" (:73); and, with this file's control server helper and a paired device `phone-1`:

```ts
it("allows and refuses a phone's move per device, and unpairing ends its grant", async () => {
  // POST /devices/phone-1/move with no ask → 409 { error: "no move to allow" }
  // moves.ask("phone-1", 4); POST /devices/phone-1/move → 200, moves.live("phone-1") === true
  // DELETE /devices/phone-1/move → 200, moves.state("phone-1") deep-equals { state: "refused" }
  // POST /devices/nobody/move → 404 { error: "no such device" }
  // moves.ask + allow again; DELETE /devices/phone-1 → moves.live("phone-1") === false
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run companion/test/move-grants.test.ts companion/test/control.test.ts`
Expected: FAIL, `Cannot find module '../src/move-grants.ts'` and 404 on `/devices/phone-1/move`.

- [ ] **Step 3: Implement `MoveGrants` in `companion/src/move-grants.ts` and the control routes**

A `Map<string, { kind: "pending" | "granted" | "refused"; bots?: number; expiresAt?: number }>`, expiry evaluated on read (as `DeviceRegistry.pairingWindow` does). In memory only: a companion restart ends every grant, which fails closed. The control routes check the device exists in `options.devices.list()` first, then call `allow`/`refuse`; on success return `companionState(options)`. Construct one `MoveGrants` in `companion/src/index.ts` and pass it as `moves`.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run companion/test/move-grants.test.ts companion/test/control.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add companion/src/move-grants.ts companion/src/control.ts companion/src/index.ts companion/test/move-grants.test.ts companion/test/control.test.ts
git commit -m "feat(companion): per-device move grants the computer's owner allows"
```

### Task 2: The phone asks, and the companion opens the move routes under the grant

**Files:**
- Modify: `companion/src/routes.ts` (`RouteRequest.move?`; `MOVE_ROUTES`; `isMoveRoute`; `/api/companion/move` in `ALLOWED`; `denyReason` at :268-287)
- Modify: `companion/src/proxy.ts` (`ProxyOptions`; `companionIdentityHeaders` :175-186; `forwardHeaders` :190; `proxyHeadersTimeoutMs` :61-64; the handler around :270-365)
- Modify: `companion/src/index.ts:32-34` (`parentPort` gains `postMessage`), `:131-141` (proxy options)
- Modify: `companion/README.md` (one row in "What it is responsible for")
- Test: `companion/test/routes.test.ts`, `companion/test/move-proxy.test.ts` (new, a fake upstream as `browser-revocation.test.ts` builds one)

**Interfaces:**
- Consumes: `MoveGrants`, `MOVE_MAX_BOTS` (Task 1).
- Produces:

```ts
// companion/src/routes.ts — the server imports these too (Task 3)
export const MOVE_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/api\/bots$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+$/ },
  { method: "GET", path: /^\/api\/bots\/[\w-]+\/skills$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/skill-template$/ },
  { method: "PUT", path: /^\/api\/cloud-send\/kind$/ },
  { method: "POST", path: /^\/api\/cloud-send\/chats$/ },
  { method: "POST", path: /^\/api\/cloud-send\/chats\/(?:verify|attachments)$/ },
  { method: "POST", path: /^\/api\/cloud-send\/chats\/attachment\/[A-Za-z0-9-]{1,80}\.[A-Za-z0-9]{1,10}$/ },
  { method: "POST", path: /^\/api\/cloud-send\/(?:memory|files|arrived)$/ },
  { method: "POST", path: /^\/api\/phone-move\/key$/ },
];
export function isMoveRoute(method: string, path: string): boolean;
export interface RouteRequest { path: string; method: string; authenticated: boolean; /** The device holds a live move grant. */ move?: boolean }
// companion/src/proxy.ts
export interface ProxyOptions {
  // existing fields; authenticate's result gains `name?: string`
  moves?: Pick<MoveGrants, "ask" | "state" | "live" | "end">;
  /** Hands the ask to the desktop app; false or absent when no app can ask the owner. */
  askOwner?(ask: { deviceId: string; deviceName: string; bots: number }): boolean;
}
export function companionIdentityHeaders(authenticatedDeviceId?: string, mutationToken?: string, move?: boolean): Record<string, string>;
```
- The parent-port message (Task 7 reads it): `{ type: "openmausbot:companion-move-ask", deviceId, deviceName, bots }`.

- [ ] **Step 1: Write the failing tests**

`companion/test/routes.test.ts`:

```ts
const MOVE_ONLY: Array<[string, string]> = [
  ["GET", "/api/bots/b1/skills"], ["POST", "/api/bots/b1/skill-template"], ["PUT", "/api/cloud-send/kind"],
  ["POST", "/api/cloud-send/chats"], ["POST", "/api/cloud-send/chats/verify"], ["POST", "/api/cloud-send/chats/attachments"],
  ["POST", "/api/cloud-send/chats/attachment/3f2a-map.png"], ["POST", "/api/cloud-send/memory"], ["POST", "/api/cloud-send/files"],
  ["POST", "/api/cloud-send/arrived"], ["POST", "/api/phone-move/key"],
];
it("opens the move routes only while the computer's owner allows the move", () => {
  for (const [method, path] of MOVE_ONLY) {
    expect(denyReason({ method, path, authenticated: true })).toEqual({ status: 404, error: `no route: ${method} ${path}` });
    expect(denyReason({ method, path, authenticated: true, move: true })).toBeNull();
    expect(isMoveRoute(method, path)).toBe(true);
  }
  for (const [method, path] of [["POST", "/api/bots"], ["PATCH", "/api/bots/b1"]]) {
    expect(denyReason({ method, path, authenticated: true })).toBeNull();
    expect(isMoveRoute(method, path)).toBe(true);
  }
  expect(denyReason({ method: "POST", path: "/api/cloud-send/chats", authenticated: false, move: true })?.status).toBe(401);
});
it("keeps every other cloud-send, settings and team route closed even under a grant", () => {
  for (const [method, path] of [["GET", "/api/cloud-send/manifest"], ["POST", "/api/cloud-send/verify-secrets"], ["POST", "/api/cloud-send/chats/settings"],
    ["POST", "/api/cloud-send/chats/owner"], ["DELETE", "/api/cloud-send/kind"], ["GET", "/api/cloud-send/files"], ["POST", "/api/cloud-send/home"],
    ["PUT", "/api/config"], ["POST", "/api/teams/import"], ["PUT", "/api/bots/b1/memory/file"]]) {
    expect(denyReason({ method, path, authenticated: true, move: true })).not.toBeNull();
    expect(isMoveRoute(method, path)).toBe(false);
  }
});
```
Add `["GET", "/api/companion/move"]`, `["POST", "/api/companion/move"]`, `["DELETE", "/api/companion/move"]` to the "what the app may do" list.

`companion/test/move-proxy.test.ts` (proxy with `mutationToken: () => "relay-secret"`, `moves: new MoveGrants()`, an `askOwner` spy, `authenticate` returning `{ id: "phone-1", name: "Omkar's iPhone", cloudDesktopAccess: false, browserControlAccess: false }`, and an upstream that records each request's path and headers):

```ts
it("raises one ask with the phone's name and answers pending, then granted once the owner allows", async () => {
  // POST /api/companion/move { v: 1, bots: 4 } → 202, body { v: 1, state: "pending", expiresAt: expect.any(Number) }
  // askOwner calls deep-equal [[{ deviceId: "phone-1", deviceName: "Omkar's iPhone", bots: 4 }]]
  // a second POST → 202, askOwner still called once; the upstream saw no request
  // moves.allow("phone-1"); GET /api/companion/move → 200 { v: 1, state: "granted", expiresAt: expect.any(Number) }
});
it("refuses a malformed ask, and one no app on this computer can show", async () => {
  // bots 0, 201, "4", missing v → 400 { error: "send { v: 1, bots }" }
  // proxy without askOwner: POST → 409 { error: "Open OpenMausBot on this computer to move bots here." }; GET → { v: 1, state: "none" }
});
it("forwards the move header only on a move route while the grant is live", async () => {
  // before the grant: POST /api/cloud-send/chats → 404 "no route: POST /api/cloud-send/chats", upstream not reached,
  //   also when the phone itself sends "x-openmausbot-companion-move: 1"
  // before the grant: PATCH /api/bots/b1 reaches upstream with no x-openmausbot-companion-move header
  // after ask + allow: POST /api/cloud-send/chats reaches upstream with x-openmausbot-companion-move "1",
  //   x-openmausbot-companion-device "phone-1" and x-openmausbot-companion-auth "relay-secret"
  // after allow: GET /api/bots reaches upstream with no move header
});
it("a request that began under the grant finishes; the next one gets today's 404", async () => {
  // upstream holds POST /api/cloud-send/chats open; moves.refuse("phone-1"); upstream answers 200 → the phone gets 200
  // the next POST /api/cloud-send/chats → 404, and GET /api/companion/move → { v: 1, state: "refused" }
});
it("lets the phone end its own grant", async () => {
  // DELETE /api/companion/move → 200 { v: 1, state: "none" }; POST /api/cloud-send/memory → 404
});
it("gives a move route the long deadline a large upload needs", () => {
  expect(proxyHeadersTimeoutMs("/api/cloud-send/chats")).toBe(105_000);
  expect(proxyHeadersTimeoutMs("/api/cloud-send/files?path=workspaces/b/x&size=1")).toBe(105_000);
  expect(proxyHeadersTimeoutMs("/api/bots")).toBe(30_000);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run companion/test/routes.test.ts companion/test/move-proxy.test.ts`
Expected: FAIL, `isMoveRoute is not a function` and 404 on `/api/companion/move`.

- [ ] **Step 3: Implement**

`denyReason`: after the `ALLOWED` check, `if (move && isMoveRoute(method, path)) return null;`. Proxy: read `const moving = Boolean(device?.id && options.moves?.live(device.id))` once per request, pass `move: moving` to `denyReason`; answer `/api/companion/move` locally right after the existing `/api/companion/endpoints` answer (POST validates with `readJson`, then `moves.ask`; when `created`, call `askOwner`, and if it returns false call `moves.end` and answer 409); `companionIdentityHeaders` adds `x-openmausbot-companion-move: "1"` only with a mutation token, `move` true, and the caller passes `moving && isMoveRoute(method, path)`. `proxyHeadersTimeoutMs` gives `PHONE_SECRET_HEADERS_TIMEOUT_MS` to any path whose pathname is a move route path. In `index.ts` pass `moves` and, only when `parentPort` exists, `askOwner: (ask) => { parentPort.postMessage({ type: "openmausbot:companion-move-ask", ...ask }); return true; }`. README row: "**Moving bots in** | A separate per-device grant the computer's owner gives in a dialog on the computer, for 30 minutes. It opens only the routes a move needs (`MOVE_ROUTES`); the harness lets those requests change only the bots that phone brought in. |"

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run companion`
Expected: PASS (all companion tests, `proxy.test.ts` included).

- [ ] **Step 5: Commit**

```bash
git add companion/src/routes.ts companion/src/proxy.ts companion/src/index.ts companion/README.md companion/test/routes.test.ts companion/test/move-proxy.test.ts
git commit -m "feat(companion): a phone asks to move its bots in, and the move routes open under the grant"
```

### Task 3: The harness trusts the move mark, and binds a move to the bots its phone brought

**Files:**
- Modify: `server/request-auth.ts` (`RequestAuth` :15-21; the companion branch :603-614; next to `BOT_PROFILE_SETTINGS` :462-470)
- Create: `server/phone-move-in.ts`
- Modify: `server/cloud-send-kinds.ts:37` and `server/cloud-send-memory.ts:20` (export `KIND_BODY_MAX`, `MEMORY_BODY_MAX` so the guard reads with the handler's own limits)
- Test: `server/request-auth.test.ts`, `server/phone-move-in.test.ts` (new)

**Interfaces:**
- Consumes: `isMoveRoute`, `RouteRequest.move` (Task 2).
- Produces:

```ts
// server/request-auth.ts
// loopback variant gains: /** Set only on the verified companion path, on a move route, while the companion holds that phone's move grant. */ companionMove?: true;
export function movedBotSetting(fields: Record<string, unknown>): string | null; // first field outside MOVED_BOT_SETTINGS = BOT_PROFILE_SETTINGS + voiceNotes, memoryEnabled, memoryUpkeep
// server/phone-move-in.ts
export interface PhoneMoveInDeps {
  dataDir: string;
  store: Pick<Store, "bot" | "botByThread" | "groupByThread">;
  routines(): Pick<RoutineManager, "listRoutines"> | null;
  ownerName(): string;
}
export function createPhoneMoveIn(deps: PhoneMoveInDeps): {
  /** The phone's device id when this request is its move under a live grant; null for any other request. */
  moving(auth: RequestAuth): string | null;
  brings(auth: RequestAuth, botId: string): boolean;
  /** { person: "", name: ownerName() } while moving: the computer's owner, whose lines here name nobody. */
  owner(auth: RequestAuth): CloudOwner | null;
  guard: RouteHandler;
};
export const PHONE_MOVE_REFUSAL = "This move only brings in the bots your phone asked to move.";
```
- Brought bots persist at `<dataDir>/phone-move-ins.json` as `{ "v": 1, "bots": { "<botId>": <ms when recorded> } }`, mode `0o600`, `writeFileAtomic`, written before the create runs. The ids are not bound to a device (Ruling Q5): a bot stays open to any phone's move under a live grant until `arrived` names it or 24 h after it was recorded, whichever comes first; after that it is the computer's own.

**The guard** (runs only when `moving(auth)`; reads the body once with the handler's limit and hands it on through `ctx.readBody`, as `server/team-move-in.ts` does; a refusal is `403 { error: PHONE_MOVE_REFUSAL }`, after `req.resume()` for a body it did not read):

| Route | Passes when |
|---|---|
| `POST /api/bots` | always; when `body.id` matches `^[\w-]{8,128}$` and is no bot, bot thread or room thread here, the id is recorded first. Without a grant, a paired phone's create with an `id` answers `403 { error: "Allow this move on the computer first." }` in the create route |
| `GET /api/bots/:id/skills`, `POST /api/bots/:id/skill-template` | `:id` is open to the move |
| `PUT /api/cloud-send/kind` | `bot:<id>` with `<id>` open to the move (the record handed on without `installedPackage`); or `routine:<id>` with `record.botId` open to the move, `record.target === "bot"`, `record.resultsThreadId` absent or a thread of that bot, and no routine with that id here on another bot. Any other kind is refused. Every body handed on carries `mainIfUnused: true` |
| `POST /api/cloud-send/chats` | every conversation has `bot` open to the move, no `room`, and a `threadId` that is new here or that bot's |
| `POST /api/cloud-send/chats/verify` | every `threadId` is new here or a thread of a bot open to the move |
| `POST /api/cloud-send/memory` | `bot` is open to the move, and no `about` or `teams` |
| `POST /api/cloud-send/files` | the `path` query starts with `workspaces/<b>/` or `task-workspaces/<b>/` for a bot `<b>` open to the move, and no segment of it, after NFKC, starts with `.`, contains `~`, or is (lowercased) `bunfig.toml`, `opencode.json` or `opencode.jsonc` (engine settings, hooks, plugins and MCP servers, git, `.env`, Bun's preload, and Windows short names such as `GIT~1`) |
| attachments, `arrived`, `/api/phone-move/key`, `PATCH /api/bots/:id` | always (the patch is bounded in Task 4) |

- [ ] **Step 1: Write the failing tests**

`server/request-auth.test.ts`, using the `relay` headers this file builds at :779 (`x-openmausbot-companion: "1"`, `-device: "phone-1"`, `-auth: "relay-secret"`) and `DESKTOP` options:

```ts
it("trusts a companion's move mark only on a move route of a verified companion request", () => {
  // relay + x-openmausbot-companion-move "1", POST /api/cloud-send/chats →
  //   auth deep-equals { kind: "loopback", scopes: ["admin", "client"], companionDevice: "phone-1", companionMove: true }
  // relay without the mark, POST /api/cloud-send/chats → status 403, error "forbidden: invalid companion request"
  // relay + mark, GET /api/bots → auth has companionDevice "phone-1" and no companionMove
  // relay + mark, POST /api/cloud-send/verify-secrets → 403 "forbidden: invalid companion request"
  // no companion auth header, mark only, GET /api/bots → auth has neither companionDevice nor companionMove
});
it("lets a moved bot bring its profile, model, voice and memory settings, never what it may do", () => {
  expect(movedBotSetting({ name: "Scout", soul: "Plans trips", voiceNotes: true, memoryEnabled: true, memoryUpkeep: "weekly", modelSelection: {}, welcomed: true })).toBeNull();
  for (const field of ["approvalMode", "alwaysAllow", "computer", "cwd", "mcpServers", "composio", "browser", "peers", "section", "chiefOfStaff", "defaultBot", "installedPackage"]) {
    expect(movedBotSetting({ [field]: true })).toBe(field);
  }
});
```

`server/phone-move-in.test.ts`: a fake store with bot `here-bot-0001` (thread `here-thread-01`) and a room thread `room-thread-01`, routines `[{ id: "r-here", botId: "here-bot-0001", target: "bot" }]`, a temp `dataDir`; `phone = { kind: "loopback", scopes: ["admin", "client"], companionDevice: "phone-1", companionMove: true }`; a `run(auth, method, path, body)` helper that builds a `RouteContext` (as `cloud-send-kinds.test.ts:47` does) and returns `{ out, status, body, handedOn }`.

```ts
it("does nothing for a request that is not a phone's move", async () => {
  // loopback owner and a companion request without companionMove: moving() === null; guard returns PASS and never reads the body
});
it("a bot becomes the phone's when it creates it under the grant, and stays so after a restart", async () => {
  // POST /api/bots { id: "pocket-scout-0001", threadId: "pocket-scout-main" } → PASS, handedOn deep-equals the body
  // brings(phone, "pocket-scout-0001") === true; brings({ ...phone, companionDevice: "phone-2" }, "pocket-scout-0001") === true (Ruling Q5)
  // a second createPhoneMoveIn on the same dataDir → brings(phone, "pocket-scout-0001") === true
  // statSync(join(dataDir, "phone-move-ins.json")).mode & 0o777 === 0o600
});
it("a bot already on this computer never becomes the phone's", async () => {
  // POST /api/bots { id: "here-bot-0001" } → PASS; brings(phone, "here-bot-0001") === false
  // POST /api/bots { id: "here-thread-01" } → PASS; brings(phone, "here-thread-01") === false
});
it("refuses every move write for a bot the phone did not bring", async () => {
  // each → 403 { error: PHONE_MOVE_REFUSAL }:
  // POST /api/bots/here-bot-0001/skill-template; GET /api/bots/here-bot-0001/skills
  // PUT kind { key: "bot:here-bot-0001" }; POST chats with bot "here-bot-0001"; POST chats with bot "pocket-scout-0001" and threadId "here-thread-01"
  // POST chats/verify with threadId "here-thread-01"; POST memory { bot: "here-bot-0001" }; POST /api/cloud-send/files?path=workspaces/here-bot-0001/a.md
});
it("refuses rooms, other kinds and place-wide memory from a phone", async () => {
  // after the phone created pocket-scout-0001, each → 403: chats with a `room`; kind keys "webhook:w1", "call:c1",
  // "app-event:e1", "imported-skill:x", "library-skill:x"; memory { bot: "pocket-scout-0001", about: {…} }; memory { teams: [] }
});
it("a routine arrives only for a brought bot and never replaces a computer bot's routine", async () => {
  // kind routine:r-here with botId pocket-scout-0001 → 403; routine:r-new with resultsThreadId "here-thread-01" → 403
  // routine:r-new { botId: "pocket-scout-0001", target: "bot" } → PASS
});
it("hands a bot record on without a package, asking to be main only over an unused MausBot", async () => {
  // kind { v: 1, key: "bot:pocket-scout-0001", dataDir: "/phone", record: { defaultBot: {}, installedPackage: { id: "p" } } } → PASS,
  // handedOn deep-equals { v: 1, key: "bot:pocket-scout-0001", dataDir: "/phone", record: { defaultBot: {} }, mainIfUnused: true }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run server/request-auth.test.ts server/phone-move-in.test.ts`
Expected: FAIL, `movedBotSetting is not a function`, `Cannot find module './phone-move-in.ts'`.

- [ ] **Step 3: Implement**

In the companion branch of `resolveRequestAuth`: `const move = headerValue(req.headers["x-openmausbot-companion-move"]) === "1";` pass `move` to `companionDenial`, and add `companionMove: true` to the returned auth only when `move && isMoveRoute(method, path)`. `moving(auth)`: `auth.kind === "loopback" && auth.companionMove === true && auth.companionDevice ? auth.companionDevice : null`. Guard dispatch: a small table keyed by method and path, as the one above.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run server/request-auth.test.ts server/phone-move-in.test.ts server/live-access.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/request-auth.ts server/phone-move-in.ts server/cloud-send-kinds.ts server/cloud-send-memory.ts server/request-auth.test.ts server/phone-move-in.test.ts
git commit -m "feat(server): a phone's move under the grant reaches only the bots it brought"
```

### Task 4: Wire the move into the harness's routes

**Files:**
- Modify: `server/routes/bot-patch.ts:102-114` (`BotPatchRouteDeps.movesIn?`)
- Modify: `server/routes/cloud-send.ts` (`CloudSendRouteDeps.phoneMove?`; pass `phone` into `arrivedRoute` at :88)
- Modify: `server/cloud-send-arrived.ts` (`MovedFrom.phone?: true`; `movedFrom` reads it; `ArrivedDeps.phone?`; the write at :69)
- Modify: `server/own-home.ts:36`
- Modify: `server/index.ts`, no new lines: imports appended to an existing import line; on the `ROUTES.push(createBotPatchRoutes({` line (:12199) prepend `const phoneMoveIn = createPhoneMoveIn({ dataDir: DATA_DIR, store, routines: () => routines, ownerName: () => cfg.profile?.name?.trim() || "User" }); ROUTES.unshift(phoneMoveIn.guard);` and add `movesIn: phoneMoveIn.brings` to its deps; on :12248 in `createCloudSendRoutes({…})`: `ownHome: (auth) => ownHome.owner(auth) || phoneMoveIn.moving(auth) !== null`, `phoneMove: (auth) => phoneMoveIn.moving(auth) !== null`, and in `move`: `owner: (auth) => cloudSendOwner(auth) ?? phoneMoveIn.owner(auth)`. `chats.owner` stays `cloudSendOwner`.
- Test: `server/routes/bot-patch.test.ts`, `server/cloud-send-arrived.test.ts`, `server/own-home.test.ts`

**Interfaces:**
- Consumes: `createPhoneMoveIn`, `movedBotSetting` (Task 3).
- Produces: `BotPatchRouteDeps.movesIn?(auth: RequestAuth, botId: string): boolean`; `CloudSendRouteDeps.phoneMove?(auth: RequestAuth): boolean`; `ArrivedDeps.phone?(auth: RequestAuth): boolean`; `MovedFrom` = `{ computer: string; at: number; told: string[]; phone?: true }`.

- [ ] **Step 1: Write the failing tests**

`server/routes/bot-patch.test.ts`, with this file's `fixture()` given `movesIn: (_auth, id) => id === bot.id`:

```ts
it("lets a phone's move set its own bot's profile, model, voice and memory, never what the bot may do", async () => {
  const phone = { headers: { "x-openmausbot-companion": "1" } };
  const ok = await patch(bot.id, { soul: "Plans trips", memoryEnabled: true }, phone);
  expect(ok.status).toBe(200);
  expect(store.bot(bot.id)?.soul).toBe("Plans trips");
  const refused = await patch(bot.id, { approvalMode: "full" }, phone);
  expect(refused.status).toBe(403);
  expect(refused.body.error).toBe(`forbidden: a phone's move may bring a bot's profile, look, model, voice, memory and phone-app settings, not "approvalMode"; set that on the host computer`);
});
it("keeps today's look-only rule for every bot the move did not bring", async () => {
  // fixture with movesIn: () => false; patch(bot.id, { soul: "x" }, phone) → 403, error matches /a paired device may change how a bot looks, not "soul"/
});
```

`server/cloud-send-arrived.test.ts`:

```ts
it("a phone's arrival is kept as a phone's, and never replaces a computer's record", async () => {
  // deps.phone = () => true, deps.owner = () => ({ person: "", name: "Omkar" })
  // POST { v: 1, computer: "Omkar's iPhone", webhooks: [] } → 200 { v: 1, told: 0 }; movedFrom(dir) matches { computer: "Omkar's iPhone", phone: true }
  // with moved-from.json already { computer: "Studio Mac", at: 5, told: ["w1"] }: the same POST → 200;
  //   movedFrom(dir) deep-equals { computer: "Studio Mac", at: 5, told: ["w1"] }
});
```

`server/own-home.test.ts`:

```ts
it("a phone's move does not make this computer a home other computers work for", () => {
  // one-owner facts; moved-from.json { computer: "Omkar's iPhone", at: 1, told: [], phone: true } → here() === false
  // { computer: "Studio Mac", at: 1, told: [] } → here() === true
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run server/routes/bot-patch.test.ts server/cloud-send-arrived.test.ts server/own-home.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

`bot-patch.ts`: `const pairedDevice = …; const moving = pairedDevice && deps.movesIn?.(auth, m[1]) === true;` when `moving`, refuse with the message above if `movedBotSetting(body)` names a field; otherwise the existing branch runs unchanged. `arrivedRoute`: when `deps.phone?.(auth)` and `kept` is a computer's record, answer without writing; else write with `phone: true` added for a phone. `own-home.ts` `here()`: `const from = movedFrom(dataDir); return oneOwner(facts()) && from !== null && from.phone !== true;`.

- [ ] **Step 4: Run them, the ratchets and the type check**

Run: `pnpm vitest run server/routes/bot-patch.test.ts server/cloud-send-arrived.test.ts server/own-home.test.ts server/cloud-send.test.ts scripts/testing/file-size-ratchet.test.ts scripts/testing/index-route-ratchet.test.ts && pnpm typecheck && wc -l server/index.ts`
Expected: PASS; `15711 server/index.ts` or fewer.

- [ ] **Step 5: Commit**

```bash
git add server/routes/bot-patch.ts server/routes/cloud-send.ts server/cloud-send-arrived.ts server/own-home.ts server/index.ts server/routes/bot-patch.test.ts server/cloud-send-arrived.test.ts server/own-home.test.ts
git commit -m "feat(server): a computer takes a phone's move into the bots it brought"
```

### Task 5: MausBot on both sides

**Files:**
- Modify: `server/default-bot.ts:149-159`
- Modify: `server/cloud-send-kinds.ts` (`putSchema` :379; `applyBotFields` :268-301; `adopt` :329-332; the PUT answer :400)
- Test: `server/default-bot.test.ts`, `server/cloud-send-kinds.test.ts`

**Interfaces:**
- Produces:

```ts
// server/default-bot.ts
/** The MausBot this place made for itself, while nobody has used it: no soul, title, description or picture, one conversation, no line from a person. */
export function unusedStarter(store: Pick<Store, "bot" | "messagesFor">, dataDir: string): BotRecord | null;
/** The place's main MausBot is absent or is that unused starter. */
export function placeMausBotUnused(store: Pick<Store, "bots" | "bot" | "messagesFor">, dataDir: string): boolean;
```
- `PUT /api/cloud-send/kind` accepts `mainIfUnused?: boolean`; for a `bot:` key whose record has `defaultBot`, it answers `{ v: 1, ok: true, mainBot: boolean }`. Rule: when `mainIfUnused` and not `placeMausBotUnused`, the arriving bot does not take over and its `chiefOfStaff: true` is ignored (`mainBot: false`); otherwise today's `takeArrivingDefaultBot` + `retireUnusedStarter` (`mainBot: true`).

- [ ] **Step 1: Write the failing tests**

`server/default-bot.test.ts`, with a real `Store` seeded the way this file seeds MausBot:

```ts
it("counts the place's MausBot unused only while it is the fresh starter nobody wrote to", () => {
  // fresh seed → placeMausBotUnused(store, dir) === true, unusedStarter(store, dir)?.id === seed.id
  // store.appendMessage(seed.threadId, { role: "user", kind: "text", text: "hi" }) → false
  // another fresh place, store.patchBot(seed.id, { soul: "Mine" }) → false
});
```

`server/cloud-send-kinds.test.ts`, with a real seeded `Store` in a temp data folder and an arriving bot `pocket-maus-000001` already created:

```ts
it("with mainIfUnused, a phone's MausBot becomes the main bot over an unused starter, and says so", async () => {
  // PUT { v: 1, key: "bot:pocket-maus-000001", dataDir: "/phone", record: { defaultBot: {}, chiefOfStaff: true }, mainIfUnused: true }
  // → 200 { v: 1, ok: true, mainBot: true }; arriving bot has defaultBot {}; the seed is hidden and no longer defaultBot
});
it("with mainIfUnused, a phone's MausBot arrives beside a MausBot someone uses, which stays main and Chief", async () => {
  // seed has a user line; same PUT → 200 { v: 1, ok: true, mainBot: false }
  // seed keeps defaultBot {} and chiefOfStaff true and is not hidden; arriving bot has no defaultBot and no chiefOfStaff
});
it("without mainIfUnused, an arriving MausBot takes over as before", async () => {
  // seed has a user line; PUT without mainIfUnused → 200 { v: 1, ok: true, mainBot: true }; arriving bot has defaultBot {}
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run server/default-bot.test.ts server/cloud-send-kinds.test.ts`
Expected: FAIL, `placeMausBotUnused is not a function`.

- [ ] **Step 3: Implement**

Extract the unused checks of `retireUnusedStarter` into `unusedStarter`, which `retireUnusedStarter` then calls (its result must not change). `placeMausBotUnused`: the bot with `defaultBot` and no `defaultBotPerson` is absent, or is `unusedStarter`. In `applyBotFields`, decide `takes` before applying `chiefOfStaff`, and return `{ mainBot: takes }` when `fields.defaultBot` is set; the route spreads it into its answer.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run server/default-bot.test.ts server/cloud-send-kinds.test.ts server/cloud-send-kinds.e2e.test.ts server/default-bot.e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/default-bot.ts server/cloud-send-kinds.ts server/default-bot.test.ts server/cloud-send-kinds.test.ts
git commit -m "feat(server): a phone's MausBot becomes main only over an unused starter"
```

### Task 6: A ticked API key moves under the grant

**Files:**
- Modify: `server/phone-secret.ts` (`phoneSecretOperationId` :119-130; `PhoneSecretBridge` :354-449)
- Create: `server/testing/phone-secret-seal.ts` (move `keyMaterial` and `seal` out of `server/phone-secret.test.ts:28-70`; `seal` takes the AAD)
- Create: `server/routes/phone-move-key.ts`
- Modify: `server/index.ts`, no new lines: append `createPhoneMoveKeyRoutes({ moving: phoneMoveIn.moving, keys: phoneSecrets, config: () => cfg })` to an existing `ROUTES.push(` after `phoneMoveIn` exists; import on an existing import line
- Modify: `electron/credential-patch.mjs` (`PROVIDER_KEY_PATCH`)
- Modify: `electron/main.mjs` `saveWorkspaceCredential` (:2811-2846), in place, no new lines
- Test: `server/phone-secret.test.ts`, `server/routes/phone-move-key.test.ts` (new), `electron/credential-patch.test.mjs` (new, vitest), `electron/provider-key-save.node-test.mjs` (new)

**Interfaces:**
- Consumes: `phoneMoveIn.moving` (Task 3).
- Produces:

```ts
// server/phone-secret.ts
/** "openmausbot-phone-move-key-v1\n{keyId}\n{deviceId}\n{target}\n{requestKey}", checked as phoneSecretAAD checks its fields. Its own first line keeps a card's envelope from opening here. */
export function phoneMoveKeyAAD(envelope: Pick<PhoneSecretEnvelope, "keyId" | "deviceId" | "target" | "requestKey">): Uint8Array;
export function sealedOperationId(aad: Uint8Array, sealed: Pick<PhoneSecretEnvelope, "version" | "encapsulatedKey" | "ciphertext">): string;
// PhoneSecretBridge gains:
provideMoveKey(envelope: PhoneSecretEnvelope): Promise<void>; // open with phoneMoveKeyAAD, then the existing save through the private parent
// server/routes/phone-move-key.ts
export interface PhoneMoveKeyDeps {
  moving(auth: RequestAuth): string | null;
  keys: Pick<PhoneSecretBridge, "provideMoveKey">;
  config(): CredentialConfig;
}
export function createPhoneMoveKeyRoutes(deps: PhoneMoveKeyDeps): RouteHandler; // POST /api/phone-move/key
// electron/credential-patch.mjs
export const PROVIDER_KEY_PATCH; // { [providerTarget]: (value) => patch }, equal to credentialConfigPatch for every PROVIDER_CREDENTIAL_TARGETS id
```
- Route order of checks: `moving(auth)` null → `403 { error: "Allow this move on the computer first." }`; body fails `phoneSecretEnvelopeSchema.omit({ threadId: true })` → 400 `{ error: "The encrypted key is invalid" }`; `envelope.deviceId !== moving(auth)` → 403 `{ error: "This encrypted key belongs to another phone." }`; target not a `CREDENTIAL_TARGETS` id or `onePasswordToken` → 400 `{ error: "Add this key on the computer." }`; `credentialIsConfigured(config(), target)` → `200 { v: 1, saved: false, kept: true }` with no decrypt; else `provideMoveKey` → `200 { v: 1, saved: true }`, a `PhoneSecretError` → its status and message.
- `phoneSecretOperationId(context)` becomes `sealedOperationId(phoneSecretAAD(context), context)` with identical output.
- Electron main, `saveWorkspaceCredential`: a name in `PROVIDER_KEY_PATCH` goes to `PUT /api/config` with that patch and no `?secretStorage=external`, never to `credentials.bin`, the way Settings → Keys saves it. Edit in place: `const provider = PROVIDER_KEY_PATCH[name], patchFor = provider ?? CREDENTIAL_PATCH[name];`, `!provider &&` in the encryption check and in `secretStorage`, `if (!app.isPackaged || provider) return applyToHarness();`.

- [ ] **Step 1: Write the failing tests**

`server/phone-secret.test.ts` (helpers now from `server/testing/phone-secret-seal.ts`):

```ts
it("opens a move key sealed for this computer and the paired phone, and saves it through the private parent", async () => {
  // bridge.receive(identity message); envelope = seal(phoneMoveKeyAAD({ keyId, deviceId: "phone-1", target: "anthropicApiKey", requestKey: "move-key-1" }), "sk-ant-fake-123")
  // await bridge.provideMoveKey(envelope) after answering the save result → sent deep-equals
  //   [{ type: "openmausbot:phone-secret-save", requestId: sealedOperationId(aad, envelope), target: "anthropicApiKey", value: "sk-ant-fake-123" }]
});
it("never opens a card's envelope as a move key", async () => {
  // an envelope sealed with phoneSecretAAD for a card → provideMoveKey rejects "The encrypted credential could not be verified"; nothing sent
});
it("gives a move key's exact retry one stable desktop operation id", () => {
  // sealedOperationId(aad, envelope) is the same twice and differs when ciphertext differs
});
```
The existing "gives an exact encrypted retry one stable desktop operation id" stays unchanged and green.

`server/routes/phone-move-key.test.ts` (a real `PhoneSecretBridge` whose send spy answers success through `bridge.receive`; `vi.spyOn` on `console.log`, `console.warn`, `console.error`, `process.stdout.write`, `process.stderr.write`):

```ts
const KEY = "sk-ant-fake-move-7f3a";
it("saves a ticked key under the live move grant and never echoes or logs it", async () => {
  // POST sealed anthropicApiKey as phone-1 under the grant → 200 { v: 1, saved: true }; one save message with value KEY
  // JSON.stringify of the answer and of every spied call does not contain KEY
});
it("refuses a key without a live move grant, before opening it", async () => {
  // auth without companionMove → 403 { error: "Allow this move on the computer first." }; no save message
});
it("refuses an envelope sealed for another phone", async () => {
  // envelope.deviceId "phone-2" under phone-1's grant → 403 { error: "This encrypted key belongs to another phone." }; no save
});
it("keeps the computer's own key and says so", async () => {
  // config() → { anthropic: { key: "sk-ant-here" } } → 200 { v: 1, saved: false, kept: true }; no save
});
it("refuses a key the computer keeps elsewhere or does not know", async () => {
  // target "onePasswordToken" → 400 { error: "Add this key on the computer." }; target "geminiApiKey" → 400 same; no save
});
it("refuses an envelope whose target was swapped in transit", async () => {
  // sealed for anthropicApiKey, sent as openaiApiKey → 400 { error: "The encrypted credential could not be verified" }; no save
});
```

`electron/credential-patch.test.mjs`:

```js
it("saves each provider key where Settings → Keys saves it", () => {
  expect(Object.keys(PROVIDER_KEY_PATCH).sort()).toEqual([...PROVIDER_CREDENTIAL_TARGETS].sort());
  for (const target of PROVIDER_CREDENTIAL_TARGETS) expect(PROVIDER_KEY_PATCH[target]("v")).toEqual(credentialConfigPatch(target, "v"));
});
```

`electron/provider-key-save.node-test.mjs` (slice `saveWorkspaceCredential` out of `main.mjs` and run it with `vm`, as `companion-browser.node-test.mjs` does; `app.isPackaged: true`, `safeStorage.isAsyncEncryptionAvailable` → false, a `fetch` spy, an `updateSecureCredentialDocument` spy):

```js
test("a phone's provider key reaches the server's settings, never the encrypted store", async () => {
  // saveWorkspaceCredential("anthropicApiKey", " sk-ant-fake ") → one fetch to `http://127.0.0.1:${SERVER_PORT}/api/config`, method PUT,
  //   body { anthropic: { key: "sk-ant-fake", everyClaudeBot: false } }; updateSecureCredentialDocument never called
});
test("a desktop slot key still goes through the encrypted store", async () => {
  // isAsyncEncryptionAvailable → true; saveWorkspaceCredential("xaiApiKey", "xai-fake") → updateSecureCredentialDocument called once,
  //   fetch URL ends with "/api/config?secretStorage=external"
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run server/phone-secret.test.ts server/routes/phone-move-key.test.ts electron/credential-patch.test.mjs && node --test electron/provider-key-save.node-test.mjs`
Expected: FAIL, `phoneMoveKeyAAD is not a function`, missing module, `PROVIDER_KEY_PATCH` undefined, "Unsupported credential".

- [ ] **Step 3: Implement**

`PhoneSecretBridge`: one private `openSealed(envelope, aad)` (today's `openWithinLimit` body with the AAD passed in) and one private `save(requestId, target, value)`; `provide`, `open` and `provideMoveKey` call them inside `withinLimit`. The route module follows `server/routes/README.md`.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run server/phone-secret.test.ts server/routes/phone-move-key.test.ts electron/credential-patch.test.mjs server/routes/secret-cards.test.ts && node --test electron/provider-key-save.node-test.mjs electron/phone-secret-identity.node-test.mjs && wc -l server/index.ts electron/main.mjs`
Expected: PASS; `15711` or fewer and `3245` or fewer.

- [ ] **Step 5: Commit**

```bash
git add server/phone-secret.ts server/testing/phone-secret-seal.ts server/routes/phone-move-key.ts server/index.ts electron/credential-patch.mjs electron/main.mjs server/phone-secret.test.ts server/routes/phone-move-key.test.ts electron/credential-patch.test.mjs electron/provider-key-save.node-test.mjs
git commit -m "feat: a phone's ticked API key moves to its paired computer under the move grant"
```

### Task 7: The owner's yes on the computer

**Files:**
- Create: `electron/move-in-ask.mjs`
- Modify: `electron/lending-words.mjs:265-276` (export `wordsIn(table, locale)`; `wordsFor` calls it)
- Modify: `electron/companion.mjs` (in `start()` after the fork: relay `openmausbot:companion-move-ask`; `setCompanionMoveAskListener`; `companionMoveAccess`; re-export `createMoveInAsks`)
- Modify: `electron/main.mjs`, no new lines: add `companionMoveAccess, setCompanionMoveAskListener, createMoveInAsks` to the existing `./companion.mjs` import list (:468-475); append to the `const lendingDialogs = createLendingDialogs(…);` line (:2710): `setCompanionMoveAskListener(createMoveInAsks({ dialog, locale: () => { try { return jsonFile(path.join(app.getPath("userData"), "desktop-prefs.json")).read()?.language || app.getLocale(); } catch { return app.getLocale(); } }, answer: companionMoveAccess }).ask);`
- Modify: `src/locales/en.json`, `pt-br.json`, `zh.json`, `zh-tw.json`; `src/locales/everyday-words.test.ts` (a group `"a phone moving its bots here": ["moveIn."]`)
- Test: `electron/move-in-ask.node-test.mjs` (new), `electron/companion-browser.node-test.mjs`

**Interfaces:**
- Consumes: the parent-port ask and `POST`/`DELETE /devices/:id/move` (Tasks 1, 2).
- Produces:

```js
// electron/move-in-ask.mjs
export const MOVE_IN_WORDS; // { [locale]: { "moveIn.ask.one", "moveIn.ask.other", "moveIn.ask.detail", "moveIn.ask.allow", "moveIn.ask.deny" } }, one entry per src/locales pack
export function decodeMoveAsk(raw) /* → { deviceId, deviceName, bots } | null */;
export function createMoveInAsks({ dialog, locale, answer }) /* → { ask(request): Promise<boolean> } */;
// electron/companion.mjs
export function setCompanionMoveAskListener(listener);
export async function companionMoveAccess(deviceId, allowed); // control(allowed ? "POST" : "DELETE", `/devices/${deviceId}/move`), ids /^[\w-]{1,128}$/ only
```
- `decodeMoveAsk` accepts `type === "openmausbot:companion-move-ask"`, `deviceId` `^[\w-]{1,128}$`, `deviceName` a non-empty string of at most 80 characters, `bots` an integer 1–200.
- The dialog: `dialog.showMessageBox({ type: "question", message, detail, buttons: [allow, deny], defaultId: 1, cancelId: 1, noLink: true })` with no parent window, so it shows with the window closed; one at a time; `answer(deviceId, response === 0)`.
- Copy (en): `"moveIn.ask.one": "Your {device} wants to move {count} bot here. Allow?"`, `"moveIn.ask.other": "Your {device} wants to move {count} bots here. Allow?"`, `"moveIn.ask.detail": "Their chats, memory, skills and routines come too, with any AI keys you picked on the phone. Nothing else here changes. The phone has 30 minutes to finish."`, `"moveIn.ask.allow": "Allow"`, `"moveIn.ask.deny": "Don't Allow"`.
- pt-br: `"Seu {device} quer mover {count} bot para cá. Permitir?"`, `"Seu {device} quer mover {count} bots para cá. Permitir?"`, `"As conversas, a memória, as habilidades e as rotinas vêm junto, com as chaves de IA que você escolheu no celular. Nada mais muda aqui. O celular tem 30 minutos para terminar."`, `"Permitir"`, `"Não permitir"`.
- zh: `"你的 {device} 想把 {count} 个机器人移到这里。允许吗？"` (one and other), `"它们的聊天、记忆、技能和例行任务会一起过来，还有你在手机上选的 AI 密钥。这里的其他内容不会改变。手机有 30 分钟完成。"`, `"允许"`, `"不允许"`.
- zh-tw: `"你的 {device} 想把 {count} 個機器人移到這裡。要允許嗎？"` (one and other), `"它們的聊天、記憶、技能和例行工作會一起過來，還有你在手機上選的 AI 金鑰。這裡的其他內容不會改變。手機有 30 分鐘可以完成。"`, `"允許"`, `"不允許"`.

- [ ] **Step 1: Write the failing tests**

`electron/move-in-ask.node-test.mjs`:

```js
test("asks with the phone's name and how many bots, and Don't Allow is the default", async () => {
  // fake dialog records its arguments and answers { response: 1 }; ask({ deviceId: "phone-1", deviceName: "iPhone", bots: 4 })
  // one call, its only argument has message "Your iPhone wants to move 4 bots here. Allow?", buttons ["Allow", "Don't Allow"],
  //   defaultId 1, cancelId 1; answer calls deep-equal [["phone-1", false]]
});
test("says bot for one", async () => { /* bots 1 → "Your iPhone wants to move 1 bot here. Allow?" */ });
test("answers yes only for Allow", async () => { /* response 0 → answer("phone-1", true) */ });
test("asks one at a time", async () => {
  // two asks at once; the second showMessageBox starts only after the first resolves
});
test("speaks the app's language", async () => { /* locale "pt-BR" → "Seu iPhone quer mover 4 bots para cá. Permitir?" */ });
test("reads only a well-formed ask", () => {
  // null for: wrong type, deviceId "../x", bots 0, bots 201, bots 2.5, deviceName "", deviceName of 81 characters
  // { deviceId: "phone-1", deviceName: "iPhone", bots: 4 } for the good message
});
test("says what every language pack says, word for word", async () => {
  // as lend-automatically.node-test.mjs:546: keys of en.json starting "moveIn." equal Object.keys(MOVE_IN_WORDS.en);
  // for every pack file, MOVE_IN_WORDS[locale][key] === (pack[key] ?? en[key])
});
```

`electron/companion-browser.node-test.mjs`:

```js
test("move access reaches only the fixed sidecar path and refuses bad ids", async () => {
  // slice companionMoveAccess as the browser-control test slices its function
  // calls deep-equal [["POST", "/devices/phone-1/move"], ["DELETE", "/devices/phone-1/move"]]; ids "../other", "a".repeat(129), "" make no call
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test electron/move-in-ask.node-test.mjs electron/companion-browser.node-test.mjs`
Expected: FAIL, missing module and `companionMoveAccess` not found.

- [ ] **Step 3: Implement**

`move-in-ask.mjs` keeps a promise chain for one-at-a-time and fills `{device}` and `{count}`. Put the keys in `en.json` and the three packs, then copy every pack's value (or English where a pack lacks it) into `MOVE_IN_WORDS`.

- [ ] **Step 4: Run them, the copy checks and the ratchet**

Run: `node --test electron/move-in-ask.node-test.mjs electron/companion-browser.node-test.mjs electron/lend-automatically.node-test.mjs && pnpm i18n:check && pnpm vitest run src/locales scripts/testing/file-size-ratchet.test.ts && wc -l electron/main.mjs`
Expected: PASS; `3245 electron/main.mjs` or fewer.

- [ ] **Step 5: Commit**

```bash
git add electron/move-in-ask.mjs electron/lending-words.mjs electron/companion.mjs electron/main.mjs src/locales/en.json src/locales/pt-br.json src/locales/zh.json src/locales/zh-tw.json src/locales/everyday-words.test.ts electron/move-in-ask.node-test.mjs electron/companion-browser.node-test.mjs
git commit -m "feat(desktop): ask the owner before a paired phone moves its bots in"
```

### Task 8: End to end through the companion path

**Files:**
- Modify: `server/testing/desktop-parent.mjs` (`OMB_TEST_DESKTOP_COMPANION_TOKEN` → `companionToken` in the same `openmausbot:desktop-mutation-token` message)
- Create: `server/phone-move-in.e2e.test.ts`

**Interfaces:**
- Consumes: everything above. The test plays the companion: each call carries `host: 127.0.0.1:<port>`, `x-openmausbot-companion: 1`, `x-openmausbot-companion-device: phone-1`, `x-openmausbot-companion-auth: <companion token>` and, under the grant, `x-openmausbot-companion-move: 1` (the proxy side of the grant is Task 2's).

- [ ] **Step 1: Write the failing tests**

Spawn the server as `server/session-credentials.e2e.test.ts:64` does, with `--import server/testing/desktop-parent.mjs`, `OMB_DESKTOP_PARENT=1`, `OMB_TEST_DESKTOP_OWNER_TOKEN` and `OMB_TEST_DESKTOP_COMPANION_TOKEN` (each `randomBytes(32).toString("base64url")`), and a temp data folder and home. The pocket home: MausBot `pocket-maus-000001` (thread `pocket-maus-main-01`) and Scout `pocket-scout-00001` (thread `pocket-scout-main-1`); per bot a user line and a bot reply with `parentId`; Scout's reply names attachment `/phone/attachments/3f2a-map.png`; Scout's skill `trip-planner`; Scout's routine `pocket-routine-01`, on; Scout's `MEMORY.md`; Scout's file `workspaces/pocket-scout-00001/notes.md`. `moveAll()` runs the call order of "Interface for the phone" (no keys). `snapshot()` reads, as the owner over loopback, bot ids and `defaultBot`/`hidden`, each thread's message ids, routine ids and `enabled`, Scout's skill names, Scout's `MEMORY.md` and the file's sha256.

```ts
it("moves a pocket home's bots in under the grant, and a resend adds nothing twice", async () => {
  await moveAll();
  const first = await snapshot();
  // first: pocket-maus-000001 has defaultBot {}; the computer's starter is hidden; Scout's thread has the two lines;
  //   pocket-routine-01 present and enabled; trip-planner listed; memory and file as sent
  await moveAll();
  expect(await snapshot()).toEqual(first);
  // the second chats answer has messages: 0; the second POST /api/bots answers 409 for both ids
});
it("a phone without the grant gets today's refusals, and the move never touches the computer's own bots", async () => {
  // without the move mark: POST /api/cloud-send/chats → 403 "forbidden: invalid companion request";
  //   POST /api/phone-move/key → 403 "forbidden: invalid companion request";
  //   PATCH /api/bots/<starter> { approvalMode: "full" } → 403 matching /a paired device may change how a bot looks/
  // with the mark: PATCH /api/bots/<starter> { soul: "x" } → 403 matching /a paired device may change how a bot looks, not "soul"/;
  //   PUT kind routine:r-x { botId: <starter>, target: "bot" } → 403 PHONE_MOVE_REFUSAL;
  //   GET /api/bots/<starter>/skills → 403 PHONE_MOVE_REFUSAL
  // the starter's record and routines are unchanged
});
```

- [ ] **Step 2: Run them to see them fail, then pass**

Run: `pnpm vitest run server/phone-move-in.e2e.test.ts`
Expected before `desktop-parent.mjs` forwards the companion token: FAIL with 403 on the first call. After: PASS.

- [ ] **Step 3: Run every check this branch touches**

Run: `pnpm lint && pnpm typecheck && pnpm i18n:check && pnpm vitest run companion server/phone-move-in.test.ts server/phone-move-in.e2e.test.ts server/request-auth.test.ts server/routes/bot-patch.test.ts server/routes/phone-move-key.test.ts server/phone-secret.test.ts server/cloud-send-arrived.test.ts server/cloud-send-kinds.test.ts server/default-bot.test.ts server/own-home.test.ts server/cloud-send-move.e2e.test.ts src/locales scripts/testing electron/credential-patch.test.mjs && pnpm test:electron`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/testing/desktop-parent.mjs server/phone-move-in.e2e.test.ts
git commit -m "test: a phone's move into its paired computer, end to end and resent"
```

## Open questions

1. With no desktop app (a headless companion), the ask answers 409 and no move happens. Fine, or should the control page offer Allow?
2. Times: the ask waits 5 minutes, the grant lasts 30. Right?
3. Approval level, tools and per-conversation settings stay the computer's defaults; only profile, look, model, voice and memory settings come with a bot. Right?
4. A moved key never replaces a key the computer already has (`kept: true`). Right?
5. Decided (Ruling Q5): the bots a phone brought are tied to their ids alone, not to the pairing. Each stays open to any phone's move under a live grant until `arrived` names it or for 24 h, so a phone re-paired halfway through can finish. Cost: during an unfinished move a second approved phone could also write to those half-moved bots.
6. `arrived` adds no chat line for a phone (its only lines are about webhooks). Is a per-bot "I moved here from your iPhone" line wanted? It would be new copy.
7. Decided (Ruling Q7, as built): the dialog closes itself when its ask expires (on macOS it is a sheet on the app's window, brought forward), and a click at or after expiry sends nothing. When the phone ends its ask first, the dialog stays up until that ask's expiry: Allow then grants nothing, and Don't Allow makes the phone's next ask read `refused` for 5 minutes.
