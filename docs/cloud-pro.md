# OMB Cloud: the home machine

OMB Cloud (the Personal, Pro and Max plans) gives one person an always-on
OpenMausBot server of their own. The plans differ in machine size, disk and
included allowances; everything on this page applies to all of them. Each
customer gets one Fly app with one `home` machine that is always on, a volume
at `/data`, and TLS at `https://<app>.fly.dev`. The desktop app, the phone and
the web are windows onto it. Local use of the app is unchanged and free.

OMB Cloud includes no AI usage. The person signs in on their machine with their
own Claude or ChatGPT subscription, or an API key, through the same sign-in
flows as any OpenMausBot server. Nothing on a Cloud home is routed to a
platform model gateway.

This page is the OpenMausBot half of a contract with three parties:

- **the home machine**: this repository's `deploy/fly/` image;
- **the Admin** (openmaus-cloud, `docs/consumer-cloud.md` there): provisions
  the app, holds the machine's signing secret, and answers the desktop's Cloud
  session;
- **the desktop app**: signs in to Cloud, lists the machine under Servers,
  and offers **Connect to my Cloud**.

Contract version: `1` (`cloudContractVersion` on the wire).

## What the person sees

1. They subscribe on the Cloud site. The Admin creates the Fly app and machine.
2. They open the desktop app, go to **Settings → OMB Cloud** and sign in (the
   existing device sign-in). A **Your Cloud** card says **Setting up** until
   the machine is up.
3. When it is ready, the machine appears under **Servers** as **My Cloud**, and
   the card offers **Connect to my Cloud**. One click opens the machine in the
   app window, signed in. There is no second confirmation.
4. The first thing the Cloud shows is its engine sign-in
   (`src/components/CloudEngineSignIn.tsx`), with three choices:
   - **Sign in to Claude**: the existing paste-code flow (open Anthropic's
     page, paste the code back);
   - **Sign in to ChatGPT (Codex)**: the existing device-code flow;
   - **Use an API key**: the existing model-provider keys in **Settings →
     Connections** (Anthropic, or an OpenAI-compatible key such as OpenRouter).

   It says plainly that the account's plan limits apply to bots running 24/7,
   and that a Claude Max plan or an API key is recommended for heavy use.
5. Until one of those engines can run, every bot on the Cloud, including the
   default one, shows this sign-in rather than a chat that fails its first
   turn. Once one can run, the chat takes its place. Sign-ins stay on the
   machine's volume (`~/.claude`, `~/.codex`, the server's own config).

The Cloud's `GET /api/auth/session` answers `"cloudHome": true` for a paired
session; that is how the web UI knows to open the engine sign-in instead of
the welcome flow, which describes the person's own computer (it can still be
replayed from Settings).

### Only your own devices

A Cloud home is personal (`server/cloud-owner.ts`): only the owner's own
devices connect (the desktop app, a phone, a browser signed in from the Cloud
page), each with an admin session that the Admin's signed pairing, or one of
those devices, gave it. The server mints and accepts nothing else, and says
so in one line, "OMB Cloud is personal: only your own devices can connect.":

- `POST /api/auth/pairing` refuses a window without admin scope (Remote
  access offers no chat-only choice there), and `POST /api/auth/pair` and
  `POST /api/pair` never redeem one;
- email sign-in (`/api/auth/email/start`, `/api/auth/email/verify`) is off,
  and Settings' People section, with its invites, is gone (a `signIn` list in
  `PUT /api/config` is refused);
- a session without admin scope does not authenticate (nor its event-stream
  tickets), and the paired devices list shows only the owner's.

At every start, any stored session without admin scope is revoked (the log
says how many), and what it opened or wrote is nobody's. Its key is written
to `cloud-owner.json` before anything else happens, so no crash or failed
save can ever make it the owner's.

Before, every device carried its own key (v0.1.91), so a device the owner
unpaired made the owner's own conversations read as someone else's. Once, at
the first start of a personal Cloud home, and again after a restore, the
keys named until then are settled, in two tiers:

- **Adopted:** every key that opened a conversation, wrote a line or
  answered a card, except a revoked one. Its conversations and rooms are the
  owner's for who opened them, their approval level (Auto or Full stay) and
  their folder. A device that only ever wrote a line counts too.
- **Proven:** only a key with proof it was the owner's: a device of theirs
  still paired at that start, or one that answered a card (on a Cloud home
  only the owner's devices can). Only proven keys' words reach the lent Mac,
  memory capture, recall and the recent-work brief.

This is honest about what cannot be known. A guest the owner unpaired before
the upgrade (or whose session expired) cannot be told apart from an owner's
old device, so their conversations are adopted: they run at the bot's level,
in its folder. Their lines never reach lending or memory, though, and any
conversation holding one is kept out of both. A guest still paired at the
upgrade is revoked and stays nobody's.

Routines fail closed. A routine is the owner's only with proof: the owner's
key as its writer, the owner's fingerprint on it (a routine they wrote
from their own device), or a restore the owner started (Move to Cloud, or a
backup restored in Settings); a routine made from the owner's bot template,
or a proposal the owner approved, is recorded as theirs when it is made.
Every other routine is nobody's: it runs confined, like a guest's, and
reports into a conversation that is nobody's. An owner's routine reports
into a conversation that is the owner's.

The routines a revoked session wrote are paused at that start, and the
conversations it opened lose their working folder: their next turn works in
a folder of their own, never the owner's project.

A routine that ends up nobody's though it is the owner's (for example one a
v0.1.91 bot template made on the server, which recorded no writer) runs
confined, and a run that cannot says so: open it and save it once, and it is
the owner's again, with full access. A routine the owner approved on a bot's
proposal card is theirs (the card records who allowed it, and what it
showed: a routine from before counts only while it still runs exactly that,
the same instructions, bot, schedule and place, with no attachment), and so
is one created at once in the owner's own Full-access conversation, or by a
run of one of the owner's routines. Approving a change (an edit, a pause, a
resume) keeps a routine the owner's only if it already was: it never makes
anyone else's routine theirs. One a bot creates or changes at once from any
other conversation is nobody's, like anyone else's edit. Resuming, moving or
retiming a routine keeps it the owner's when they are its writer and no
fingerprint of theirs is on it yet (a template, a restore); a fingerprint
that no longer matches what it runs is renewed only by the owner rewriting
its instructions. Each run of a routine works in a conversation opened like
its results conversation, so a nobody's routine's run is confined to a
folder of its own.

A key that is adopted but not proven still costs something: its lines keep
that conversation out of lending and memory, and if a turn there changes the
bot's memory files, the bot as a whole cannot use the Mac until the owner
reviews the change (the bot's **Memory** panel, **Mark reviewed**). Starting
new conversations avoids it.

At the first personal start the log also says to review **Settings → Remote
access → Paired devices**, which now shows only admin devices, and to sign
out any that isn't the owner's: a device paired with full access before is
the owner's from then on, and nothing can tell otherwise.

`cloud-owner.json` is this machine's alone: it is never in a backup, and a
restore leaves it in place and settles what it brought (it records the last
restore it settled, so one applied at a start that ended early is settled at
the next). A restore is proof only for routines that report into a
conversation that names nobody yet or the owner: a backup from before can
hold a guest's routine, which stays nobody's. The guest rules below stay,
fail-closed, for what a guest left behind.

The card shows one of: **Setting up**, **Ready**, **Stopped**, **Payment
problem**, **Could not be set up yet**. Only Ready can be connected to.
Signed out of Cloud, the app makes no Cloud request and nothing on this page
runs.

### Setup checklist

On a Cloud home a small card, **Set up your Cloud**, sits at the bottom left
until its steps are done or the person hides it (`src/components/CloudSetup.tsx`,
`src/lib/cloud-setup.ts`). Only the owner's own devices (an admin session on a
Cloud home) see it; desktop and self-hosted installs never do and keep their
welcome flow. Each step's state comes from the Cloud or the app, never from a
box the person ticks:

1. **Sign in to Claude or ChatGPT**, the one required step: done when any
   engine on the Cloud can run. From another view, its **Sign in** returns to
   the engine sign-in above.
2. **Bring your bots from your computer**: only in the desktop app, while Move
   to Cloud's card would be offered (an empty Cloud, a computer with work to
   bring). **Move to Cloud** opens that offer in place (the size, what stays,
   **Move** and **Not now**). Done after a move; skipped after **Not now**,
   which the Cloud keeps (`cloud-setup-move-skipped` in its onboarding record)
   and which also hides the one-time card.
3. **Try something that runs while you're away**: one example, a daily
   routine. **Try it** puts it in the chat's composer, unsent. Done when a bot's
   turn first finishes on the Cloud: the server records `onboarding.firstTurnAt`
   once, on a Cloud home only, for a turn that finished (not a failed or
   stopped one) in a bot's conversation or a room. The onboarding record never
   travels with Move to Cloud, so moved-in chats do not count.
4. **Optional: Let your Cloud use this Mac**: only in the desktop app on
   macOS. **Choose what to lend** opens Settings → OMB Cloud on this Mac,
   leaving the Cloud's page as the menu-bar item's **Lending settings…** does
   (`cloudLending.open()`: no arguments, answered only for the verified Cloud
   page or the app's own window). Done when `GET /api/shared-computers` lists
   a computer.

**Hide setup** is the only dismiss. The Cloud keeps it (`cloud-setup-hidden`
in its onboarding record), so it holds on every device and after browser
storage is cleared, and it is the move's **Not now** too. The card also goes
away by itself once steps 1 and 3 are done. Nothing asks for confirmation.
After the card, Move to Cloud's one-time card behaves as before.

While a window shows a Cloud home, the sidebar's server switcher reads **My
Cloud · always on**; in a browser, a plain label says the same.

### Where bots work

A Cloud home is a headless Linux server, so its bots have two places: the
built-in browser and cloud computers. It never offers **This computer** (that
would be the server itself) or a **Local VM** (a Fly machine has no container
runtime). The person's own Mac is reached only when they lend it (**Let my
Cloud use this Mac**, below), through the shared-computer tools.

- Neither place is listed in the Computer panel, the composer's place chip, a
  bot's Works on setting or Settings → Computers (the config answers
  `"cloudHome": true`), nor in `select_computer`, which also drops `vm_exec`.
  Auto never lands on either.
- A bot still set to either (an older or imported setting) has each task
  refused with a sentence saying so, suggesting Auto, Cloud or Browser and,
  for This computer, lending the Mac.
- Every turn's system prompt says the bot runs in the cloud. Asked about the
  person's own computer, a bot with the shared-computer tools checks for a lent
  Mac and, finding none, says so and how to lend one; a bot without them says
  it cannot reach it. Either offers the browser and cloud computers, never a
  place that cannot exist.
- The built-in browser is on unless the person switches it off in Settings.
  The desktop turns it on in its first-run welcome, which a Cloud home skips.

`shared/cloud-home.ts` decides which places are offered, for the server and
the app alike.

### Open in the app: `openmausbot://cloud`

The Cloud page (`https://cloud.openmausbot.com/cloud`) can offer **Open in the
app** as a link to exactly `openmausbot://cloud`. The app accepts that string
and nothing else: no path, query, fragment or trailing slash, and it ignores
any other form. Like `openmausbot://organization`, it is an action, not a
router. It never carries an address, a pairing code or a credential; the app
decides everything from its own verified state (`electron/cloud-entry.mjs`).

1. The link starts the app, or brings it forward if it is already running
   (launch argument, a second instance, or macOS `open-url`, including one
   that arrives before the app is ready). If the window already shows
   **My Cloud**, coming forward is all it does.
2. Otherwise the window returns to this computer (a hosted server that was
   showing stays saved under **Servers**) and opens **Settings → OMB Cloud**.
   Before that view acts, the app gives a saved Cloud sign-in up to five
   seconds to finish restoring, so it is never mistaken for signed out.
3. Opened this way, the view acts on its own, with no confirmation:
   - signed out: it starts the existing device sign-in at once, which opens
     the browser approval page with the code filled in
     (`/cloud/desktop?code=…`);
   - signed in and the Cloud is **Ready**: it connects to **My Cloud**,
     exactly like **Connect to my Cloud**;
   - after that sign-in completes, or when the Cloud becomes **Ready** while
     the view is still open, it connects then;
   - anything else: the card shows the status and the person decides.

It starts at most one sign-in (only when signed out on arrival; a later
sign-out in that view starts nothing) and one automatic connection per link.
A failed connection shows the card's error; clicking the link again retries.
Closing Settings or choosing another section ends it. While it is open, the
first-run welcome waits, as it does for Organization settings. A normal visit
to **Settings → OMB Cloud** never signs in or connects by itself.

The link does nothing in development builds, and in companion client mode it
explains that the app must be disconnected from the other computer first.
The `openmausbot` scheme belongs to the installed app: on macOS through the
app bundle, on Linux through the `.deb`'s desktop entry, and on Windows (and
for an AppImage) once the installed app has started at least once, since it
registers itself at startup. Before that, or if the app is not installed, the
browser has nothing to open (it shows nothing or an error), so the Cloud page
should keep a download link next to the button.

### Use in your browser: `/pair#signin=…`

For people without the desktop app, or on another computer, a Chromebook or an
iPad, the Cloud page's **Use in your browser** opens the Cloud's own web UI in
a new tab, signed in after one **Continue**, with nothing to copy.

1. The Cloud page opens a blank tab from the click itself (so no pop-up blocker
   stops it) and cuts it off from the page (`opener` set to null).
2. The Admin sends the machine a signed pairing request with
   `"purpose":"browser"` and `"owner":"<the account's email>"` (below). The
   machine opens a **browser sign-in** window: single use, admin and client
   scopes, at most two minutes, redeemable only by its 256-bit credential
   through a browser sign-in, and recording its owner. The answer has no
   typeable code and says `"purpose":"browser"` back.
3. The tab goes to `https://<app>.fly.dev/pair#signin=omb_pair_…`. The
   credential is only in the fragment, which never reaches a server, a proxy
   log or a `Referer`.
4. Before anything renders, the web UI takes the fragment off the address bar
   and replaces the tab's history entry (`takeBrowserSignInFromLocation`,
   `src/lib/session.ts`). It asks the machine whose Cloud this is
   (`POST /api/auth/pair` with `{code, browser: true, preview: true}`, which
   redeems nothing and counts toward no lockout) and shows **Signing in to
   <owner>'s Cloud** with one **Continue** and a quiet *Not your email? Close
   this tab.* (`src/pair/BrowserSignInPage.tsx`). Nothing is redeemed until the
   person continues, so a link someone else sent never signs a browser in to
   their Cloud unseen.
5. **Continue** posts `{code, label, cookie: true, browser: true, attemptId}`
   to `POST /api/auth/pair`, always, whether or not this browser is already
   connected. The server redeems it into a session and sets this browser's
   `HttpOnly`, `SameSite=Lax`, `Secure` session cookie, replacing (and
   revoking) any session this browser already had here. The tab then goes to
   `/`. A retry after a lost answer reuses the page's attempt id and gets the
   same session. `browser` without `cookie: true` is a `400`.
6. A spent, expired or unknown sign-in shows the pair page with *This sign-in
   link has expired or was already used* and never shows the credential.

**Scope:** the session has admin and client scopes, the same as the desktop
app gets from its own Cloud pairing: the owner, who can sign engines in and
manage the Cloud. It is labelled with the browser (for example "Safari on
iPad") in the Cloud's paired devices, where it can be revoked; a session whose
answer never arrived is listed and revocable the same way. The sidebar's
**My Cloud · always on** adds *<owner>'s Cloud* under it (`GET
/api/auth/session` answers `owner`).

What keeps the credential safe is where it travels and that it works once: it
is only ever in the URL fragment (never sent to a server, a proxy log or a
`Referer`, and removed from the address bar before the page renders), it is
single use, and it lives at most two minutes. The session's own rules are
defence in depth on top of that, not the protection itself. It is
**cookie-only**: its token is accepted as this browser's cookie (never readable
by scripts) and refused as `Authorization: Bearer`. Its changes (any request
other than `GET`, `HEAD` or `OPTIONS`) must also say they come from this
Cloud's own page, with an `Origin` equal to the Cloud's origin or
`Sec-Fetch-Site: same-origin`, which every current browser (and the desktop
app's Chromium) sends; a request with neither is a `403`. Anyone holding the
token can still set those headers themselves. A browser sign-in window is never redeemed by
`/api/pair`, by an app, or by `/api/auth/pair` without `browser: true`; a
browser sign-in never redeems an ordinary pairing window or a typed code. So an
ordinary pairing link is still one click on the pair page.

Anyone with a Cloud can make a sign-in link for their own Cloud and send it to
someone else. The page says whose Cloud it is before anything happens, and
nothing is redeemed without **Continue**.

The fragment leaves the tab's address bar and its history entry, but the
browser's global history may still list the address it opened. By then the
credential is spent (single use) or expires within two minutes.

The web UI's pages are sent with `Content-Security-Policy: frame-ancestors
'none'`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`
(`serveStatic`, `server/index.ts`): no other page can frame them. Nothing
frames the web UI: the desktop app shows it in its own window.

## Let my Cloud use this Mac

The Cloud is home: bots and chats live there. The person's Mac is a computer
the Cloud can borrow while it is awake. Lending is off until the person turns
it on, and it exists only between their own desktop app and their own Cloud
home. Other users (desktop only, self-hosted, hosted team workspaces) keep
computer sharing exactly as before: off unless a maintainer sets
`features.sharedComputers` by hand.

### What the person sees

In **Settings → OMB Cloud**, the **Your Cloud** card has a **Let my Cloud use
this Mac** switch under **Connect to my Cloud** (it is part of connecting, not
a dialog). Turning it on shows what can be lent; each change applies at once,
with no confirmation. The switch and the chosen scopes are the consent.

- **Folders**: chosen with the folder picker. Read-only by default; **Can
  edit** lets bots create files and overwrite them, but only after reading the
  current version (the overwrite is checked against its hash). Nothing is ever
  deleted. At most 256 KiB per file, no symbolic or hard links. The home folder
  and anything above it cannot be chosen.
- **Apps and screen**: bots see the screen and use apps as the person, through
  this app's own computer control (the signed app holds Accessibility and
  Screen Recording; the Cloud never does). This is broad by nature, since it
  reaches anything those apps can, and the switch says so. It needs local
  computer control set up first.
- **No terminal.** The shell grant of maintainer sharing is never offered here.

The switch can be turned on before the first **Connect to my Cloud**; lending
starts once this Mac is signed in to the Cloud. Lending runs while the app is
open: quitting it (or the Mac sleeping) only pauses lending, and it resumes
when the app runs again with the switch still on. Below the choices, **Activity
on this computer** lists every request the Cloud made, refused ones included.

While lending is on, a menu-bar item shows it (**In use** while the Cloud is
running something on this Mac) with **Stop lending**. Turning the switch off or
choosing **Stop lending** stops at once: the Cloud is told, a running action
is cancelled (the computer-control transport is closed and the screen lease
released), and nothing more runs. An action an app had already started may
still finish.

### How it is enforced

On the Mac (the authority; `electron/computer-sharing.mjs`,
`electron/shared-computer-access.mjs`):

- **Outbound only.** Electron main dials the Cloud's HTTPS address with this
  app's own session cookie and a per-grant 256-bit secret; there is no
  listening port. The Cloud can only answer the Mac's long poll.
- **Bound to the account and the machine.** The grant records the Cloud
  account id and the machine's origin from the verified Cloud session
  (`cloud-account.mjs`), and the Cloud home's environment id on first contact.
  Signing out of OMB Cloud, another account signing in, the Cloud moving to
  another machine, or another server answering at that address ends lending
  and switches it off (turning it back on is the person's choice). A Cloud
  sign-in that must be renewed pauses lending; a minute's re-verification or an
  unreachable Admin does not. The server must say it is a Cloud home
  (`cloudHome: true`) and this Mac's session there must be one of the owner's
  admin devices. Lending never reads the maintainer flag and it never goes to
  any other server.
- **Every operation is checked against the grant here**, whatever the server
  says: the folder must be lent, writes need **Can edit**, screen actions need
  apps and screen. Jobs are validated against the server's schema first.
- **What folders never reach**, read-only or not: this app's data and grants,
  keys and sign-in stores (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`,
  `~/.claude`, `~/.codex`, keychains, browser profiles and cookies…) and places
  that run code (`~/Library/LaunchAgents`, git and shell configuration,
  `~/.local/bin`), decided by filesystem identity rather than spelling. Writes
  inside any `.git` directory are refused.
- **Screen tools and their arguments are an allow-list**
  (`electron/lent-screen-tools.mjs`), derived from the local driver's own
  schemas: observation and input only. The driver's tools that work outside
  the screen (uploading a file by path, recording or replaying to a path,
  configuration, installing, DevTools, killing a process, raising permission
  prompts) are refused and hidden, and so is every argument that names a path,
  a command line or a port: screenshots come back inline (never
  `screenshot_out_file` or `debug_image_out`), `launch_app` takes no extra
  arguments or inspector port and opens only `http`/`https` addresses, and a
  cursor image cannot be read from a path. Any other argument is refused, and
  the tool list the Cloud sees shows only what is accepted.
- **Activity log**: `lending-activity.jsonl` in the app's data folder, owner
  only: time, action, folder and relative path or tool name, and whether it
  ran. Never contents, output or typed text. The app only ever appends to it
  (never through a link); a full file of 500 entries is moved to
  `lending-activity.jsonl.1` intact. No folder or screen argument reaches it.

On the Cloud home (`server/shared-computers.ts`, `server/index.ts`):

- Lending is on for every Cloud home, with no maintainer flag.
- Only the owner's admin sessions (the Admin's signed pairing gives the
  desktop one) can lend.
- The server refuses operations outside the scopes the Mac registered before
  queuing them, never retries an operation with an unknown outcome, and never
  substitutes its own files for an offline Mac.
- Only turns that provably act for the owner may use the lent Mac
  (`server/cloud-lending.ts`): a conversation the owner started from one of
  their own devices (a live session with admin scope), a scheduled run of a
  routine the owner wrote or last rewrote from one of those devices, or a run
  of it the owner started by hand. Never a webhook-started run (its payload
  comes from outside), a guest's conversation or routine (a device paired
  with chat-only access), a routine someone else rewrote, a room, a bot's
  delegated or peer turn, a local process on the Cloud, or anything the
  harness cannot trace. A conversation qualifies only while the owner opened
  it and it holds nobody else's words, anywhere in it, before or during the
  turn: one line from a guest, a teammate bot or a local process (sent,
  queued, steered or handed in, or history imported with a move), one card
  answer from someone else, or one report of a routine the owner did not
  write, takes that conversation out of lending for good, because a resumed
  session carries everything said in it. A conversation a guest opened (and
  named) is never the owner's, whoever writes in it. The bot is told "Someone else wrote in this
  conversation, so it can't use your Mac. Start a new conversation to use it."
  and the lending switch says the same. The owner's own edits count as theirs,
  and the harness's own automatic card settlements do not count. A
  routine stops being the owner's once anyone else edits it in any way (its
  instructions, schedule, results destination or whether it is on); the
  owner rewriting its instructions makes it theirs again. A bot whose
  **Computer** setting is off cannot use lent apps and screen.
- On a Cloud home only the owner's own devices (admin sessions) can answer a
  card or remember an approval; a guest can read along but never answer.
- A guest writes only in conversations it opened: it cannot send into the
  owner's conversations (not even steer a line into a running turn), and it
  renames, edits, compacts, switches versions of or deletes only its own. Only
  the owner's own devices change a bot's name, title, description, standing
  instructions or notifications (a guest keeps its picture and voice), rename
  the owner's rooms or change their bulletin, change a conversation's approval
  level or a bot's default model, or point a routine's results at the owner's
  conversations. On a guest's device (or one of the owner's paired with
  chat-only access) the composer of any other conversation is replaced by a
  **New conversation** button.
- A conversation a guest opened (or a guest's routine opened for its
  results, or a room a guest opened) runs in Ask whatever the bot's own
  level: no Auto reviewer, no Full access, no saved command answers for it
  (judged by the conversation the turn runs in, a room's for a room turn,
  never by whichever of the bot's conversations is active).
  So does a room turn whose latest line from a person is a guest's, and any
  work a guest's turn hands a teammate (delegation, coordination, a room
  handoff), however deep. A delegation or a question to a teammate runs in a
  new conversation of the guest's own on that teammate, never in the owner's
  conversation with it, and is never folded into a turn running there. It
  works in a folder of its own, never the bot's
  project folder the owner's conversations share, and a card it raises
  never offers "always allow". One that already ran in another folder keeps
  it, except a conversation a revoked session opened: it is unpinned at boot,
  so its next turn works in a folder of its own.
- A guest's turn gets no shell and reads nothing outside its own folder, on
  every engine; an engine that cannot run it that way refuses it with one
  line, before anything is recorded. On a personal Cloud that line speaks to
  the owner, since only what came before is confined: for a routine, "This
  routine was made before this update. Open it and save it once to run it
  with full access."; for a conversation, that it is from before the Cloud
  was only theirs, and to start a new one:

  | Engine | A guest's turn |
  | --- | --- |
  | Claude Code (2.1.257 or newer) | `--restricted` and only Read, Grep, Glob, Edit, Write and WebSearch: no Bash, PowerShell or WebFetch; reads outside its folder refused outright (`blockReadsOutsideWorkingDirectories`, plus deny rules); the folder's own `.mcp.json` and settings never load; only the harness's own MCP tools are pre-allowed, every other call asks the owner. The session's `init` must list no command-running tool, or the turn stops. An older Claude Code refuses. |
  | Codex / ChatGPT (codex-cli 0.159) | no environment (`environments: []`: no `exec_command`, `apply_patch` or `view_image`, and calls to them are refused), `features.shell_tool`, `unified_exec` and `view_image` off and web search disabled, proven in `config/read` before the turn starts, or the turn refuses. |
  | API models (OpenAI-compatible, MiniMax, Mistral, Grok API) | no shell or file tool on the machine at all; every MCP call asks the owner. |
  | Cursor, Qwen, Gemini, Hermes, Pi, OpenCode, Grok Build, Antigravity, Droid, Kimi, a custom ACP engine, Boat | refused: each runs its own shell or reads files outside its folder without asking in Ask (Qwen, Gemini, OpenCode and Pi could have it switched off; that needs a separate process per guest conversation, a follow-up). |
- Everything the owner's own devices write carries one owner identity, so
  pairing a device again (or revoking one) never makes the owner's earlier
  conversations someone else's. A guest never carries it.
- On a Cloud home a request from the machine itself without a session (a
  bot's shell, any local process) is only a service, whatever
  `OMB_LOOPBACK_TRUST` says: it may reach the health check, the Slack
  worker's guarded routes and a turn's own capability routes, decline a card
  and nothing else. It cannot open a pairing window, change a setting or a
  bot, answer a card or review memory.
- A bot's memory and its other conversations reach every one of its turns,
  so on a Cloud home nothing a conversation the owner did not write produces
  flows into them (`server/lending-memory.ts`):
  - memory capture skips such conversations, and they leave no line in the
    bot's daily log;
  - the bot's memory tools (`memory_update`, `memory_log`) refuse to write from
    them;
  - recall, the recent-work brief and, in a turn that may use the Mac, the
    session tools (`session_search`, `session_read`, `list_threads`) draw
    only on conversations the owner alone opened and wrote in (a title is
    words too);
  - a change while such a turn runs flags the bot: to MEMORY.md, a topic file
    or a daily log, or to an instruction file its engine reads in the folder
    of a conversation the owner opened, the bot's own folder, or a folder
    above one (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`,
    `.claude/settings.json`, skills, agents and commands). A guest's own
    folder is not watched: nothing there reaches the owner's turns. A skills,
    agents or commands folder of more than 200 entries is judged as a whole
    (any entry added or removed there, or an edit to an entry or its
    `SKILL.md`, is a change). A working folder, `.claude` folder or skills
    folder that is a link is read through it, and a folder that could not be
    read is looked at again next time. A
    line someone else steers into the owner's running turn makes that turn
    count as theirs from then on. A link is judged by where it points, and
    on a Cloud home memory is never read through one. A flagged bot's turns
    cannot use the Mac, and the bot says "This bot's memory was changed in a
    conversation you didn't write. Review it in Memory to use your Mac
    again." The bot's **Memory** panel shows the same notice, lists the files
    that changed, and **Mark reviewed** (one click, only from one of the
    owner's own devices, never a local process) accepts exactly what was
    shown: if anything changed since, the panel shows it again. The owner's
    own turns, their edits in the Memory panel (save, delete, undo), upkeep
    on their conversations and the tidy-up never flag it. A damaged record
    (`lending-memory.json`) flags every bot that existed when it was found
    until the owner reviews each; a bot created later starts clean.
- What this cannot stop: any conversation whose bot can run commands without
  the owner approving (Auto or Full access, or a remembered command), a
  guest's included, controls the Cloud machine: it can change other bots'
  files and these records.
- Not covered yet: a bot whose memory changed can still pass its words to
  other bots through rooms, `ask_bot` and delegation, and a turn that may use
  the Mac can still read room names and routine listings through its tools.

### What the Cloud can see: `GET /api/shared-computers`

For the Cloud UI and the next step (placing a step on the Mac, "Waiting for
your Mac"). Client scope; on a Cloud home only the owner's own devices (admin
sessions) see the lent Mac and a guest sees an empty list; elsewhere a session
sees only its own person's. No secrets, no local paths.

```json
{ "computers": [ {
  "id": "5b3e…", "name": "MacBook-Pro",
  "online": true, "busy": false, "lastSeenAt": 1790000000000,
  "scopes": { "folders": [ { "id": "9f1c…", "name": "Plans", "write": false } ], "terminal": false, "screen": true }
} ] }
```

`online` is false once the Mac has not polled for 40 seconds (asleep, app
closed, offline); the entry stays until lending is stopped, the Mac's session
ends, or 14 days pass. The list is in memory and empty after the Cloud
restarts, until the Mac registers again (within seconds of being online).
Server code can call `sharedComputers.status(principal)` directly. Bots use
the `list_shared_computers` and `shared_computer` tools.

## The image

`deploy/fly/Dockerfile` builds on the published server image
(`ghcr.io/milind-soni/openmausbot`) and adds:

- the engine CLIs from `ENGINES` (default Claude Code and Codex; the base
  image already carries agent-browser and its Chrome);
- Caddy, as the only listener the network can reach (`0.0.0.0:8080`);
- `server/cloud-home-start.ts` (bundled to `dist-server/cloud-home-start.js`)
  as the entry point.

```sh
docker build -t openmausbot .
docker build -f deploy/fly/Dockerfile --build-arg BASE_IMAGE=openmausbot -t omb-cloud-home .
```

At boot the launcher, running as root, hands the volume's mount point to the
`maus` user, binds the volume to this machine as `maus`
(`/data/.omb-cloud-home.json`; another machine's volume, or an unmarked
volume with data on it, is refused), and runs two children as `maus`: the
server on `127.0.0.1:8799` (webhooks on `127.0.0.1:8800`) and Caddy on
`:8080`. It stays a small root supervisor: if either child exits, both stop
and Fly restarts the machine. The one exception: after a restore commits
(Move to Cloud, below), the server exits with code 75 and the launcher starts
only the server again.

The machine's secrets (`OMB_CLOUD_BOOTSTRAP_SECRET` and the relay tokens
`OMB_CLOUD_BOAT_TOKEN`, `OMB_CLOUD_VOICE_TOKEN`, `OMB_CLOUD_DECIDER_TOKEN`)
arrive as the launcher's environment, from the Fly app secrets the Admin
sets. The launcher never puts them in a child's environment, because
`/proc/<pid>/environ` keeps a process's starting environment for anything
running as the same user to read. It writes them to the server over an
inherited pipe (`OMB_CLOUD_SECRETS_FD`). The server reads it and closes it
as its very first step (`server/cloud-secrets-boot.ts`, its first import),
before any other module loads, so no process it starts inherits the pipe.
The server's environment is built from an allow-list: the process basics,
what the image sets and the parts of the boot contract that are not secret
(`serverEnvironmentAllowed`). Anything else, a secret the platform adds
later included, never reaches it; the launcher logs the names it left out,
never their values. The launcher's own environment and memory belong to
root, out of `maus`'s reach. A server started without the pipe (tests,
development) reads them from its environment and says so in its log.

The launcher runs and trusts only code `maus` cannot change: the image
makes `/app` root's and not writable by anyone else, and the launcher
refuses to start if Node, itself, the server's entry point, Caddy or its
config (or any folder above them) is not root's, is writable by others, or
is on the volume. Only the `/data` volume is `maus`'s.

`HOME=/data`, so `~/.claude`, `~/.codex` and OpenMausBot's own data
(`/data/.openmausbot`) persist on the volume.

### Why the server stays on loopback

`server/request-auth.ts` treats an unproxied loopback request on a Cloud
home as a service, never the owner (see above), and the server never binds
a public interface. Caddy
(`deploy/fly/Caddyfile`) forwards every request with `X-Forwarded-Proto:
https` and `X-Forwarded-For`, so the server sees each one as remote: it needs
a paired session, whatever `Host` it claims. Caddy trusts `Fly-Client-IP`
only from Fly's private ranges; that address feeds the pairing lockout, never
authorization. Apart from `/api/health`, Caddy answers only for the machine's
own name (`OMB_PUBLIC_URL`) and refuses any other `Host`.

### Fly

The Admin creates the machine through the Machines API; `deploy/fly/fly.toml`
is the same shape for a manual deploy: `internal_port = 8080`, `force_https`,
no auto-stop, one machine always running, a volume `omb_home` at `/data`,
restart policy `always`, and an HTTP check on `GET /api/health` (it answers
`{"app":"openmausbot"}` with no session). Each customer's app lives in its
own Fly private network, so no machine can reach another's over 6PN.

## Boot contract

Set by openmaus-cloud's provisioner (`server/cloud-machines.ts`). Any of the
first four switches the server into Cloud home mode; then all of them are
required and the whole contract is validated. A partial or invalid contract
stops the server before it serves, with a message that names the variable and
never echoes a secret.

| Variable | Fly | Value |
| --- | --- | --- |
| `OMB_CLOUD_ROLE` | env | `home`. (`desktop` belongs to the Cloud desktop image and is refused here.) |
| `OMB_CLOUD_MACHINE_ID` | env | The Admin's machine id (a UUID). Binds the volume. |
| `OMB_CLOUD_ADMIN_URL` | secret | The Cloud origin, exact `https://`, e.g. `https://cloud.openmausbot.com`. |
| `OMB_CLOUD_BOOTSTRAP_SECRET` | secret | 43 base64url characters (256 bits): the key the Admin signs pairing requests with. |
| `OMB_PUBLIC_URL` | env | The machine's exact `https://` origin, `https://<app>.fly.dev`. |

- The machine must not also carry `OMB_ADMIN_URL`, `OMB_ADMIN_WORKSPACE` or
  `OMB_ADMIN_MEMBERSHIP`: a Cloud home is a personal server with pairing codes
  on, not a hosted team workspace with portal membership.
- `HOME=/data` and `OMB_DATA_DIR=/data/.openmausbot` are set by the image.
- The server keeps the secret in memory and removes it from its environment at
  startup; no engine or tool it starts ever inherits it.

### No model gateway

OMB Cloud includes no AI, so the contract has no model gateway. If a Cloud
home is ever given `OMB_HOSTED_MODEL_URL`, `OMB_HOSTED_MODEL_TOKEN` or
`OMB_HOSTED_MODELS` (an Admin from before this decision set all three), it
still boots, logs one warning naming the variables (never their values), and
ignores them:

- the launcher drops them from the server's environment, and the server drops
  them from its own at startup, so no engine or tool ever sees them;
- the portal workspace model policy (`server/hosted-models.ts`) stays off on a
  Cloud home whatever they hold, so no instance is routed to a gateway;
- no `included.*` or other read-only instance is served; the person's own
  engines are the only way to a model.

### Included Boat computers, voice and decisions

Pro includes Boat cloud computers, ElevenLabs voice and the decision model
(TypeSafe's Jev, [decision-model.md](decision-model.md)) with no key to paste.
For each service the Admin has configured, it also sets:

| Variable | Fly | Value |
| --- | --- | --- |
| `OMB_CLOUD_BOAT_URL` | env | `https://cloud.openmausbot.com/api/cloud/services/boat/api/box/v1`, the Admin's Boat relay. It keeps Boat's own `/api/box/v1` ending, so the Computer engine's model catalog (`<root>/api/provider-models`) resolves through the relay too. |
| `OMB_CLOUD_BOAT_TOKEN` | secret | This machine's Boat relay token (`box_omb_…`). It is not a Boat key and works only through the relay. |
| `OMB_CLOUD_VOICE_URL` | env | `https://cloud.openmausbot.com/api/cloud/services/voice/v1`, the Admin's voice relay. |
| `OMB_CLOUD_VOICE_TOKEN` | secret | This machine's voice relay token (`omb_voice_…`). |
| `OMB_TTS_DEFAULT_VOICE` | env | An ElevenLabs voice id, used until the person picks a voice or another speech provider in Settings. |
| `OMB_CLOUD_DECIDER_URL` | env | `https://cloud.openmausbot.com/api/cloud/services/decider`, the Admin's Jev relay. It is a Jev base URL, used as it is: the decider adds `/v1/systemone`, the relay's only route, so every included decision goes to exactly `<OMB_CLOUD_DECIDER_URL>/v1/systemone`. |
| `OMB_CLOUD_DECIDER_TOKEN` | secret | This machine's decision relay token (`omb_decide_…`). It is not a Jev key and works only through the relay. |

A service is included only when both its URL and its token are set
(`server/included-services.ts`). The real Boat, ElevenLabs and Jev keys stay
on the Admin, which checks the subscription, the monthly caps and which
computers belong to this machine on every request.

- **The person's own key always wins.** An included token is a fallback, used
  only while the person has no key of their own: none saved in Settings
  (`box.token`, `tts.key`, `decider.key`) and no `BOX_TOKEN`, `OMB_TTS_KEY`
  or `OMB_JEV_API_KEY` in the environment. Adding a key switches to it at
  once; removing it falls back to the included service again (for Boat, once
  that key's cloud computers are deleted: removing a Boat key that still has
  computers is refused). The choice is made on every request.
- **Each credential goes to one place.** The relays know only the Admin's
  accounts, so an own key goes only to the provider (`OMB_BOX_API`,
  `OMB_ELEVENLABS_API` or `decider.baseUrl` when set, for development and
  tests, else Boat's, ElevenLabs' and Jev's own APIs) and an included token
  only to its relay, whatever those settings say.
- **The decision relay takes two requests, and the app sends it nothing
  else.** Through the included token the app sends only room routing's
  request (one question `answer`, a choice with the fixed instructions in
  `server/decider/room-routing.ts`, and state keys `room`, `humans_in_room`,
  `bots_in_room`, `new_message` and, when there are recent lines,
  `recent_messages`) and the Settings key check's fixed request, within the
  relay's caps (a body of at most 64 KiB, a state of at most 24,000 bytes as
  JSON). `server/decider/relay.ts` checks each request before it is sent; one
  that does not fit is not sent, and the room falls back as for any other
  decision-model failure. Any other decision job, now or added later, uses
  only the person's own Jev key until the relay accepts it too.
- **Included decisions are on until switched off.** While the decision model
  runs on the included token, its master switch counts as on unless the person
  switched it off in **Settings → Decision model**; an explicit off always
  wins, and switching it back on needs no key. The per-job switches keep their
  defaults, so rooms set to Auto ask who answers, and new rooms start on Auto,
  as with a saved key. An own Jev key is on once saved, as anywhere else, and
  clearing it falls back to the included decisions without switching them
  off.
- **An included token is never the person's key.** It is never written to
  `config.json`, never sent to a client (Settings sees `configured` and
  `included: true`, and says "Included with your Cloud plan"), and Settings never
  verifies, rotates or clears it. The decision model's **Test** button, with
  no key pasted, makes one tiny call through the relay, never to Jev
  directly. Boat's account-change rules still apply: adding an own Boat key
  while included cloud computers exist is refused until they are deleted,
  because the new account cannot reach them.
- **What holding the tokens does and does not do.** The server receives the
  tokens over the launcher's pipe, never its environment, keeps them in
  memory, and they are on the credential list. So no process the server
  starts inherits them, including tools that copy its environment as it is
  (the browser, docker, ssh, MCP bridges), and no process finds them in the
  server's `/proc/<pid>/environ`. They are still in the server's memory, and
  that is the remaining exposure: the server runs as `maus`, like every
  engine, so a process running as the same user that may trace it (the
  kernel's ptrace policy, `kernel.yama.ptrace_scope`, decides) could read
  them there. That is why a guest's turn gets no shell (above); the complete
  fix is engines under a user of their own. A relay token is only this customer's own OMB Cloud
  allowance: it works only through the Admin, only on this machine's cloud
  computers, voice and decisions, and only up to the monthly caps.
- A refusal from the Boat or voice relay (for example, the month's cloud
  computer hours are used up) is shown as the relay's own message. A resume
  that fails with a server error is retried on the next poll, as Boat asks.
- A refusal from the decision relay (401 for an unknown token, 402 without an
  active subscription, 429 over the month's cap or a rate limit, 502 or 503
  upstream) never reaches a turn: as with any decision-model failure, the room
  does what it would without it (its lead answers). Only **Test** shows it,
  as a fixed sentence.

## Pairing: the Admin's signed request

`POST https://<app>.fly.dev/api/cloud/pairing`

```http
POST /api/cloud/pairing
Content-Type: application/json
x-omb-cloud-timestamp: 1790000000
x-omb-cloud-nonce: <base64url, 16–128 characters>
x-omb-cloud-signature: v1=<base64url HMAC-SHA256(OMB_CLOUD_BOOTSTRAP_SECRET, canonical)>

{"label":"OpenMausBot app (Cloud)","ttlSeconds":300}
```

where `canonical` is

```text
v1\n<timestamp>\n<nonce>\nPOST\n/api/cloud/pairing\n<base64url SHA-256 of the raw body>
```

`200`:

```json
{ "code": "ABCD-EFGH-JKLM", "credential": "omb_pair_…", "expiresAt": 1790000300000 }
```

`code` and `credential` are two encodings of **one ordinary pairing window**
(`server/sessions.ts`): single use, admin and client scopes, redeemed at the
machine's existing `POST /api/auth/pair`.

With `"purpose":"browser"` and `"owner":"<the account's email>"` in the body
(the Cloud page's **Use in your browser**, above), the machine opens a browser
sign-in window for that owner instead and answers

```json
{ "credential": "omb_pair_…", "expiresAt": 1790000120000, "purpose": "browser" }
```

`ttlSeconds` then defaults to and is capped at 120. Only
`POST /api/auth/pair` with `browser: true` and `cookie: true` redeems it, and
only by `credential`. A machine from before this ignores `purpose` and answers
with an ordinary window and no `purpose`; the Admin then discards it and does
not open the browser.

| Status | Body | Meaning |
| --- | --- | --- |
| `401` | `{"error":"invalid_signature"}` | Wrong key, tampered request, or malformed headers. Counts toward the per-source pairing lockout. |
| `401` | `{"error":"stale_request"}` | Timestamp more than 300 s from the machine's clock. |
| `401` | `{"error":"replayed_request"}` | Nonce already used in the last 10 minutes. |
| `429` | `{"error":"rate_limited","retryAfterSeconds":n}` | Too many bad signatures from this source. |
| `400` | `invalid_body`, `invalid_label`, `invalid_ttl`, `invalid_purpose`, `invalid_owner` | Not a JSON object; label not plain text of 80 characters or fewer; TTL not a positive integer; `purpose` present and not `"browser"`; `owner` missing on a browser sign-in, or not one email address of 254 characters or fewer in printable ASCII with exactly one `@` and no `<` or `>`. |
| `405`, `415` | | Not a POST; not JSON. |

Rules the machine enforces: the signature is checked first, in constant time;
the timestamp within ±300 s; each nonce refused for 10 minutes; `ttlSeconds`
defaults to 300 and is capped at 600; nothing about the request (headers, body
or code) is logged. Nonces live in memory, so a restart forgets them; a
captured request is still bounded by its five-minute timestamp window and TLS.

## What the desktop reads from the Admin

The desktop polls `GET /api/cloud/desktop/session` with its personal device
token (`Authorization: Bearer omc_…`). Contract version 1 adds:

```json
"cloud": { "state": "ready", "origin": "https://omb-u-1a2b3c4d5e6f.fly.dev", "pairingAvailable": true }
```

- `null` or absent when the account has no machine; the app then shows nothing new.
- `state` is `setting_up`, `ready`, `stopped`, `payment_problem` or `failed`.
  `origin` is required for `ready`. Any other state (including the retired
  `allowance_used`) is treated as no machine. Other fields, such as a retired
  `allowance`, are ignored.

Optional, additive fields the app reads when the Admin sends them (an Admin
without them works as before; a malformed one is dropped, never the machine):

- `cloud.setup: {step, slow}` while `setting_up` (`step` is `reserving`,
  `storage`, `starting` or `checking`): the app shows the same four steps as
  the Cloud page, and says when setup is slow.
- `cloud.retryAt` (ms) when `failed`: the time of the next automatic try.
- `cloud.disk: {gb, maxGb}`: the volume now and the most the plan lets it grow
  to. Only with it does Move to Cloud count on a larger disk (and ask the Admin
  to grow it, below). Without it the app assumes nothing: a move is measured
  against the Cloud's free space today, and one larger than the Cloud's whole
  disk says "tell us and we'll make room", never "remove files" or "try again".
  The Admin should send it together with `POST /api/cloud/desktop/disk`.
- `cloud.purchase: {state: "confirming" | "held", plan, paidAt}`: a payment
  received but not yet linked to this account. While it is there, the app shows
  "payment received" and offers nothing to buy. It never activates anything.

How the app holds the answer (`electron/cloud-account.mjs`): it asks every
minute (every 15 seconds while the Cloud is set up or a payment is linked),
and an answer counts for 15 minutes, never past the plan's own `expiresAt` or
the device token's. A failed check keeps the last verified answer, so the plan,
the Cloud card and Connect never blink; after two failures in a row the
snapshot says `checking`. Only a longer outage makes it `unavailable`, and even
then the plan last verified is named (`lastPlan`, display only, kept beside the
encrypted credential as `planHint`; it activates nothing). When the device
token reaches its `expiresAt`, or the Admin itself answers `401`/`403` with
its JSON `{error: "invalid_token"}`, the app asks the person to **Sign in
again** (one step, the plan unaffected) instead of offering a plan. A `401` or
`403` page from anything in between (Cloudflare's bot check, a proxy), or any
other refusal, is a failed check like a dropped connection: it never ends the
sign-in. Nobody signed in with a paid plan, in payment trouble, with a payment
being linked, or whose state is unknown is offered a plan anywhere in the app.

In the Server menu, **My Cloud** goes through the same connection as
**Connect to my Cloud** (no pairing code to type); when it cannot, the app
opens **Settings → OMB Cloud**, which says the next step. In the desktop app a
`/pair#code=` link connects without a second click; a browser still asks. On a
Cloud home the pairing page says where its connection starts (the environment
descriptor's `capabilities.cloudHome`).

On the person's own Cloud, open in the app's window, **Settings → OMB Cloud**
shows the plan read only (`cloud-plan:*`: its name and whether it is active,
**Manage in your browser** and **Switch to this computer**). It is listed only
on an OMB Cloud home (`config.cloudHome`), never on another server open in the
window. Main answers it for the Cloud this account verified, or last verified
while a check is failing or the sign-in has ended, so that page says
"checking" or "sign in again on your computer" rather than an error; where the
app cannot vouch for the Cloud it only says the plan is managed in the app on
the computer.

**Connect to my Cloud** first asks the machine whether this app is already
signed in there (`GET <origin>/api/auth/session` with its cookie). If not, it
calls `POST /api/cloud/desktop/pairing` (same device token) and expects
`{"cloudContractVersion":1,"origin":…,"code":…,"expiresAt":…}` for the same
origin, with `expiresAt` at most ten minutes away. It then adds or selects the
**My Cloud** server entry and opens `<origin>/pair#code=<code>`, the same
pairing-link flow as Connect to a server. The code stays in main-process
memory for that one navigation: never on disk, never in a renderer. A
malformed session summary or grant is treated as none.

## Move to Cloud

One action copies everything from the person's own computer to their Cloud:
bots, chats and their messages, attachments, memory, routines, skills, rooms
and teams, and the settings a workspace backup carries. It is a copy; nothing
on the computer changes. Chat history travels between machines here, and only
here, because the person asked for it. Secrets never travel.

### Where it is

- **Settings → OMB Cloud**, under Your Cloud once it is Ready: **Move to
  Cloud** (`src/components/CloudMove.tsx`). Before anything starts it shows the
  size and the counts (`GET /api/cloud-move/estimate` on the computer's own
  server), and says that API keys and sign-ins stay on the computer and that
  the person signs in to Claude or ChatGPT on the Cloud (the Cloud's first-run
  engine sign-in above).
- When the Cloud already has bots or chats, the button reads **Replace my
  Cloud with this computer's workspace**, and the card says that what the
  Cloud holds is replaced, backed up on the Cloud first, and put back by **Swap
  back to previous Cloud**. There is no confirmation dialog. Without a session
  on the Cloud yet (never connected), it says the same thing conditionally.
- The first time the app shows an empty Cloud (its starter bot at most, no
  rooms, nobody has chatted) and the computer has work of its own, the Cloud's
  page shows a card: **Bring your bots and chats from this Mac** ("this
  computer" elsewhere), with **Move** and **Not now**. Not now hides it for that
  Cloud for good; it never blocks anything. Only the desktop app shows it, and
  main answers the Cloud page only when it is the verified Cloud (the origin the
  Cloud session reports) open as the window's active server. That page can
  start a move only from the person's own click (`navigator.userActivation`)
  and cannot swap back to the previous Cloud. While the Cloud's setup
  checklist is up, the same offer is its second step instead of a card.

### What moves, and what stays

Exactly what a workspace backup carries (`server/workspace-backup.ts`,
`server/workspace-backup-policy.ts`). Never: API keys, provider and MCP
connections, engine sign-ins (`~/.claude`, `~/.codex`, the server's
`providers/`), saved credentials, pairing, paired devices and sessions (the
session registry's open marker included: a restore leaves the destination's
own marker in place, so a crash just before it still ends account sign-ins),
the server's identity, caches,
downloaded tools and runtime files. Never this app's Cloud sign-in or what
it lends (Let my Cloud use this Mac, above): both live in the desktop app's
own storage, not in the workspace, and a lent Mac reconnects once the Cloud
has restarted. Unsent drafts and window preferences stay on the computer.

The Cloud keeps its own: every connection section of its config (engine and
API keys, the included Boat and voice relays, sign-in allow-lists), its
sessions and pairing, its engine sign-ins, its computer-sharing switch
(`features.sharedComputers` always stays with the machine a backup is restored
on), and its boot contract (the environment, and the volume marker outside the
data folder). As with any restore, routines, webhooks and scheduled calls
arrive paused and nothing queued runs; the person turns routines on in the
Cloud when they want them to run there instead. A bot that used an engine or
API key the Cloud does not have asks for one there, and a bot pointed at a
project folder outside the workspace keeps that path, which the Cloud does not
have: the files inside the workspace move, folders elsewhere on the computer
do not.

### How it moves (`electron/cloud-move.mjs`, `server/cloud-move-http.ts`)

1. Main opens a session of its own on the Cloud. The Admin opens a single-use
   pairing window for the signed-in owner (`POST /api/cloud/desktop/pairing`),
   and main redeems it at `/api/auth/pair` for a bearer token held only in
   memory. That session is labelled "Move to Cloud" and signed out when the
   move ends.
2. The computer's server exports its encrypted backup with a random password,
   under the usual rule that bots finish their turns first, and main copies it
   to a private temporary file, hashing it.
3. `POST /api/cloud-move/upload {sha256, bytes, files}`. The Cloud refuses more
   than 10 GB of data or 100,000 files (`413`), and checks its free space: the
   upload three times over (the upload, its decrypted copy and its staged
   files), plus twice its own workspace (the backup it takes first, briefly
   with its snapshot), plus 256 MB. A part stored by an earlier upload, of any
   file, counts as free: a new upload replaces it. Every Cloud starts at
   10 GB; a plan whose disk grows grows it as it fills, up to the plan's
   maximum. Before anything is exported the app measures the move the same
   way (`moveFit`, with the Cloud's own `volumeBytes` from
   `GET /api/cloud-move`), against the plan's largest disk only when the
   Admin says how far it grows (`cloud.disk`): if it fits only once the disk
   grows, it asks the Admin to grow it now (`POST /api/cloud/desktop/disk
   {sizeGb}`, answered `{disk: {gb, maxGb}}`; `404` means this Admin cannot,
   so the app says "tell us and we'll make room" with no "try again";
   `409`/`422` over the plan) and waits until the Cloud reports the room
   (only a timeout or no answer says "try again"). Not enough room is `507`
   with `freeBytes` and `neededBytes`, and the app shows both, with the next
   step: "make room on your Cloud" when the disk could hold it; "a plan with a
   larger disk" only when the move is larger than the plan's whole disk, and
   never on Max, the largest. A move that cannot fit says so before it
   starts, and the Cloud's own card offers no move it would refuse. Nothing has been moved at that
   point. A new upload also deletes whatever an earlier attempt staged.
4. Parts of 16 MB (at most 64): `PUT /api/cloud-move/upload/<sha256>?offset=n`.
   A part already stored is accepted again without being written; any other
   offset answers `409` with `received`; a part that fails is cut back off.
   Main retries with backoff and continues from where the Cloud stands. An
   upload that keeps failing keeps its archive for 30 minutes, so moving again
   continues it rather than starting over; the Cloud keeps a stored part for a
   day, and its startup deletes an older one.
5. `POST /api/cloud-move/preview {sha256, password}`: the Cloud checks the
   SHA-256 and stages the file as an ordinary backup, which authenticates the
   whole file before parsing anything. Anything that is not a valid backup is
   refused and the upload discarded.
6. `POST /api/cloud-move/restore {id}`, inside the maintenance gate: the
   Cloud's workspace is backed up first (below), then the restore is committed
   and the server exits with code 75. The launcher
   (`server/cloud-home-start.ts`) starts only the server again, and startup
   installs the restore before anything else loads. Preview, restore and undo
   can take minutes, so each answers `202` and runs as a job the app follows
   in `GET /api/cloud-move`. A Cloud that answers `409` (another step still
   running) is asked again with the same staged workspace. A restore that
   fails on the Cloud (bots that stay busy past a few tries of the gate, for
   one) deletes what it staged and the backup it took.
7. Main waits until the Cloud reports that restore installed
   (`lastRestoreId`), signs its session out, and opens My Cloud in the window.

Stopping before step 6, or any failure before it, asks the Cloud to drop what
the move staged (`POST /api/cloud-move/discard`; a preview still running drops
its result when it ends). A stored upload part stays, for moving again.

### Swap back to previous Cloud

Before a move replaces the Cloud's workspace, that workspace is backed up to
`.backups/cloud-previous` on the Cloud's own volume, which no backup includes
and no restore replaces. Its random password is kept beside it: the same volume
holds the same data unencrypted anyway. It is offered as **Swap back to
previous Cloud** unless it is a fresh Cloud's (its starter bot at most, no
rooms, nobody has chatted).

Swapping back (`POST /api/cloud-move/undo`) is the same restore the other way
round: the workspace the Cloud has now is backed up first and becomes the
previous Cloud, so a swap back can itself be swapped back, and nothing done on
the Cloud since the move is lost. It needs room for the previous Cloud staged
and installed plus that backup (`507` otherwise).

That archive is the one undo point kept. A new backup waits in
`.backups/cloud-previous.next` and replaces it only once startup has installed
the restore it was made for (a restore that never commits or rolls back leaves
the previous Cloud as it was). Once a move's or swap's restore is installed,
startup deletes its safety copy (`.backups/safety-<id>`) and its staged files,
so `.backups` holds about one workspace, not four. `GET /api/cloud-move`
reports the previous Cloud's size (`previous.bytes`, shown in Settings) and
everything `.backups` holds (`heldBytes`). A restore made from Settings →
Backups keeps its safety copy as before.

### Move security

- Every Cloud route needs a paired session with admin scope. A client-scope
  device is refused, and so is a bare loopback request: on a Cloud home a
  process on the machine (a bot's shell) is only a service and cannot pair
  itself as the owner. It still runs as the server's user and can read and
  write `/data` directly, which is why a bot that runs commands without the
  owner approving is trusted with the machine (above). Only a Cloud home
  receives a workspace; any other server answers `404`, except for sizing its
  own (`/api/cloud-move/estimate`).
- The upload is bounded by its declared size, the per-part limit and the
  backup's own limits on size and file count.
- The bundle is the workspace backup: credentials are left out by path and by
  a config allowlist, and checked again at staging (a config with connection
  settings or webhook secrets is refused). Staging never decompresses: tar is
  told not to, and gzip or zstd payloads are refused. `server/cloud-move.e2e.test.ts`
  gives the desktop keys, a driver environment, workspace credentials and a
  provider login, scans the exported bundle for them, moves it to a real Cloud
  home, and scans every file on the Cloud's volume.
- Nothing logs a request body, the password, a file name or bundle contents.

## Security summary

- The server never listens on the network; only Caddy does, and nothing it
  forwards is the loopback owner.
- Pairing windows are opened only for a request signed with the machine's
  secret, fresh and never replayed; each window is single use and short lived.
  A browser sign-in window lives at most two minutes, shows whose Cloud it is
  and is redeemed only on **Continue**, and travels only in a URL fragment the
  web UI removes from the address bar before it renders. Its session is
  cookie-only and makes changes only from requests its browser marks as
  same-origin: defence in depth, not the protection itself.
- The web UI's pages cannot be framed and send no `Referer`.
- Device names are stored without control or bidirectional-formatting
  characters.
- The signing secret is removed from the server's environment at startup and
  is never passed to engines or to Caddy.
- There is no platform model gateway: stray `OMB_HOSTED_*` settings are
  ignored with one warning and never reach the server's environment or an
  engine. Every model call uses the person's own sign-in or key.
- A volume binds to one machine and is never adopted by another.
- Each customer's app lives in its own Fly private network.
- A lent Mac is reached only through its own outbound connection, within the
  scopes the person chose, which the Mac itself enforces (see "Let my Cloud use
  this Mac").

## Published image

Every push to `main` and every release tag publishes the home machine image as
`ghcr.io/milind-soni/openmausbot-cloud-home`, tagged `latest` (main only), `sha-<commit>` and the release tag.
It is built from `deploy/fly/Dockerfile` on top of the server image for the same commit, with Claude Code and
Codex installed. The Docker workflow's summary prints the digest. Set it in the Admin as
`OMB_CLOUD_HOME_IMAGE=ghcr.io/milind-soni/openmausbot-cloud-home@sha256:…`; changing it rolls the new image
out to existing machines one at a time, reverting automatically on a failed health check.
