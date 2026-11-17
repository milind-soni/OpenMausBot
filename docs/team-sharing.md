# Sharing a bot or a department

A bot or a whole department can be shared as a **template**: a small folder anyone can add to their own MausBot.

- **A bot.** Ask it in chat ("publish yourself to GitHub", "export yourself"), or use **Share → Share as template**.
  The app sends the bot "Create a public template of yourself that I can share with somebody else"; the bot makes the
  folder, takes personal details out of it, and shows one card with **Publish** and **Details**.
- **A department.** The department's **…** → **Share** shows its card at once, with **Publish to community** and
  **Save folder…**. A Chief can also be asked in chat to share its department.
- **Adding one.** **+** → **Import…**: paste a GitHub link or choose a folder, look at what it brings, then **Add**.
  A bot can also add one when you paste the link or folder path in your own message ("import <link>").

## What the folder holds

```
<name>/
  bot.md or team.md          the bots, their instructions, group chats, the Chief, routines and apps by name
  skills/<name>/SKILL.md     every skill, as standard Agent Skills
  avatars/<key>.webp         pictures, at most 64 KB each
```

`bot.md` and `team.md` are BotMRR Markdown v2: YAML frontmatter with the template's fields, and a readable body any AI
agent can follow when the file is pasted in. Older files (BotMRR v1 Markdown, `team.mausteam.json`, package JSON) still
import.

Never in a template: chats, memory, keys, passwords, tokens, connection addresses, models, approval levels, folders,
computers or who may see a bot. Every text is checked for key- and password-shaped values, which are replaced; the card
says how many. Routines always arrive paused, and each app is connected with the new owner's own account.

## Publishing

**Publish** sends the folder to the MausBot Admin, which opens a pull request on the community repository
(`milind-soni/openmausbot-teams`); nobody needs a GitHub account. The card then has **Copy link**, a GitHub folder link
that **Import…** accepts, and **View on GitHub**. Publishing needs a MausBot sign-in; without one, the card offers
**Save folder…** and **Upload on GitHub**, the repository's own upload page.

Backups are separate: Settings → Backup saves everything, chats included.

## Moving from Grok Bot

**Settings → Import & export → Move from Grok Bot** opens one dialog. It needs no sign-in
and the import makes no network call. Grok Bot has no export button, so each Bot
writes down its own setup.

1. Copy the message and send it in the Bot's chat. The Bot saves
   `grok-bot-export-<name>.json` or replies with it.
2. Bring that back: paste the whole reply (chat text and code fences are fine),
   drop the file or choose it. In the desktop app, on the computer running
   OpenMausBot, files named `grok-bot-export*` in Downloads are offered in one
   tap; a split or re-saved export joins up.
3. The preview names the Bot and counts its skills, routines and memories. Nothing
   is written yet.
4. Import, then the same counts in the past tense and the one next step: turn each
   routine off in Grok Bot, then on here.

**Move another Bot** goes round again; each Bot exports itself.

### Connect Grok Bot

In the desktop app, on the computer running OpenMausBot, the dialog can also take
every Bot in one go. **Get the link** gives an address to add in Grok Bot as a
custom connector (Connect apps → Add a custom connector → Server URL). The
[MausBot bot in Grok Bot](https://x.ai/bot/3i4Tvjckmdk05UwntFeNo) then sends each
Bot's export through it, and the dialog lists the Bots as they arrive. They go
through the same preview as a file, and nothing is imported until you choose
Import.

Grok Bot runs connectors from its own cloud computer, which cannot reach yours,
and it cannot change a connector's address once added. So the link's address is on
MausBot's connected-apps service (`cloudflare/composio-broker`), and it never
changes: you add it in Grok Bot once, and it keeps working across restarts,
updates and networks.

- The address is `https://<service>/mcp/move/<key>`. It serves an MCP server
  with four tools: `move_status`, `send_export`, `hand_off_task` and
  `task_status`.
- While the link is on, the app keeps one outbound connection to the service.
  The service passes each tool call down that connection, the app runs it and
  answers, and the service passes the answer back to Grok Bot. Nothing listens on
  your computer, and the app's own API is never exposed.
- The work runs in the app. While MausBot is closed or the computer sleeps, Grok
  Bot still sees the tools, and a call answers that MausBot isn't open. Open it
  and the same link works again; nothing needs adding again.

The link stays on until you turn it off (**Grok Bot connector → Turn off**, under
Move from Grok Bot). Importing what arrived does not end it; the link only stops
offering what you imported. While it is on, its secret is kept in the data folder
(`grok-connector-key`, readable only by you), which backups and Cloud sends leave
out. The key in the address is a one-way hash of that secret, so someone who has
the address can call the tools but cannot take the link over. Turning the link off
forgets the secret and the old address stops answering; turning it on again makes
a new address, to add in Grok Bot again.

What Grok Bot sends passes through the service on its way to your computer and is
not stored there: the service keeps a hash of the link's key, when the app last
connected, and the tool list and standing answers the app gave it. What arrives is
held in the app's memory until you import it, turn the link off or the app quits.
Tasks handed off before a restart can no longer be read back with `task_status`;
their conversations stay in MausBot. A copied data folder holds the same secret:
the copy of the app that connected last has the link, and the other one says so
and offers **Use it here**. The link needs the connected-apps service, so it is
offered in the built desktop app and not while `OMB_COMPOSIO_BROKER=off`; it needs
no connected-apps account and works with your own Composio key.

Whoever holds the link can send exports, read how many Bots have arrived and the
names and one-line jobs of your bots, and hand your main bot a task and read that
task back. No tool reads an export back, and a link reads only the tasks it handed
off, at most 30 an hour. A sent document goes through the same checks as a pasted
one before it is kept, and a link holds at most 100 documents and 16 MB.

### Handing MausBot a task from Grok Bot

With the link added, a Bot in Grok Bot can hand MausBot a task (`hand_off_task`).
It opens a new conversation on your main bot, titled "From Grok Bot: …", and the
main bot does it or hands it to the right teammate. The task arrives as an outside
event, the way a webhook's task does: it is labelled as coming from Grok Bot and is
information only. It approves nothing, hands no level down and never gets an
automation's address, and anything that needs your approval or answer is asked of
you in MausBot. `task_status` tells Grok Bot whether the task is being worked on,
needs you, is done (with the main bot's last reply), failed or was stopped. The
Grok Bot connector part in Settings lists the last five tasks; click one to open
its conversation. `server/grok-move-mcp.ts` is the MCP
server, `server/grok-link.ts` the app's connection to the service and
`cloudflare/composio-broker/src/grok-link.ts` the service's side.

Everyone who can add a bot also sees a popup once, after the welcome on a new
install and at the next launch otherwise: the two marks, **Let's start**, which
opens this dialog, and **Not now**. It goes first in the queue of once-only
notices (`GROK_MOVE_NOTICE`) and may interrupt a first chat, though not a turn, a
dialog or a call. It reads nothing on this computer. It stays away from a Team
Cloud, a hosted member, a branded build and a desktop an organization runs.

| In Grok Bot | Here |
| --- | --- |
| Name, title, instructions | A new bot in its own section, through the `openmaus.package` import |
| Skills | That bot's skills, switched on. One the skill scan flags stays off, and the dialog names it |
| Memories and facts about you | That bot's `MEMORY.md`, repeats dropped |
| Routine on a schedule | A routine named `<Bot>: <routine>`, paused, with its schedule and time zone and the skills it uses named in its prompt |
| Routine on an event (Slack, GitHub, Linear, Sentry, PagerDuty, email, webhook) or with a schedule that can't be read | Not created: its trigger and instruction are saved in that bot's `memory/grok-bot-event-routines.md`, and the dialog counts them |
| App with a remote `https` MCP address | That bot's MCP server, switched off, with values stripped |
| Other apps | Not carried: their logins stay in Grok Bot. The dialog counts every app to connect again |

Chat history, app logins and the model never come over.

The export text is untrusted. A document with credential-looking keys is refused
whole; token-shaped text elsewhere is redacted before anything uses it. An
address carrying a key in its query loses it, and one with a key in its path is
not carried at all. Importing grants nothing else: the package path sets every
privilege-bearing field itself. A server name you already have is skipped, and a
Bot already moved is not added twice. One file or item that can't be read costs
the rest nothing.

The earlier `openmaus.grok/1` export still reads.

After the button is pressed, and on the computer running OpenMausBot only, the
desktop app reads through `GET /api/setup-import/grok` (its own window only, never
a paired device, a browser, a bot's shell, a Cloud or a hosted server) those
Downloads files and one slice of the Grok Bot app's UI cache in
`<user data>/sand-client-persistence/`: `roster.last-roster`, for the names of the
Bots on this computer. Nothing else in that folder is opened, nor `~/.grokbot`.

A `cursor-session.json` left in the data folder by an older version is deleted at
start.

The mapping lives in `shared/grok-import.ts`, the local look in
`server/grok-local.ts`, the dialog in `src/components/GrokMoveDialog.tsx`, the
popup in `src/components/GrokMovePopup.tsx`.

