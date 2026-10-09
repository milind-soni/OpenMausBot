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
platform model gateway. The one exception is a free trial's Claude credit, a
small one-time amount the Admin meters on its own relay, used only until the
person connects their own AI ([Trial Claude credit](#trial-claude-credit)).

This page is the OpenMausBot half of a contract with three parties:

- **the home machine**: this repository's `cloud-home` image (`Dockerfile`, `deploy/fly/`);
- **the Admin** (openmaus-cloud, `docs/consumer-cloud.md` there): provisions
  the app, holds the machine's signing secret, and answers the desktop's Cloud
  session;
- **the desktop app**: signs in to Cloud, lists the machine under Servers,
  and offers **Open My Cloud**.

Contract version: `1` (`cloudContractVersion` on the wire).

## What the person sees

1. They subscribe on the Cloud site. The Admin creates the Fly app and machine.
2. They open the desktop app, go to **Settings → OpenMausBot Cloud** and sign in (the
   existing device sign-in). A **Your Cloud** card says **Setting up** until
   the machine is up.
3. When it is ready, the machine appears under **Servers** as **My Cloud**, and
   the card offers **Open My Cloud**. One click opens the machine in the
   app window, signed in. There is no second confirmation.
4. The first thing the Cloud asks is **What should your Cloud do while you're
   away?** (`src/components/CloudIntent.tsx`, `src/lib/cloud-intent.ts`): a box
   drawn like the composer, with `/setup` fixed in front of the text, four
   ideas that fill it in (a news digest, watching a page, a research roundup,
   a daily plan); hovering one previews its full text in the box. It is never a
   gate: **Skip for now** sits in plain view under the ideas, Escape skips while
   the box is empty, and picking another bot in the sidebar goes to that bot,
   leaving the question to the setup card's **Give it a job**. The answer is sent as `/setup <job>`
   (server/setup-mode.ts), so the bot asks at most four questions and sets
   itself up for the job in the chat. With an engine already able to run, it
   is sent at once; the box becomes the composer on the way (a named View
   Transition) and the request is the chat's first message. Otherwise the job
   waits on this device (`omb.cloudIntent.pending` in browser storage) and
   the engine sign-in shows it at the top, with **Edit**. The Cloud keeps
   that the question was answered (`cloud-intent-asked`) and that a job was
   given (`cloud-intent-given`) in its onboarding record, so no device asks
   again; a Cloud where a bot has already finished a turn is never asked.
   The question is asked only of the owner's own session on a Cloud home.
5. Then, with no engine signed in, the engine sign-in
   (`src/components/CloudEngineSignIn.tsx`): provider tiles side by side (two,
   or three where the image carries the Grok CLI), where the picked one opens
   its sign-in in a panel underneath, and an API key below them:
   - **Claude**: the existing paste-code flow (open Anthropic's
     page, paste the code back);
   - **ChatGPT**: the existing Codex device-code flow;
   - **Grok**: the same device-code flow for Grok Build on a grok.com
     subscription (`grok login --device-auth`, run on the Cloud computer),
     offered only when the image carries the Grok CLI;
   - **Use an API key**: the existing model-provider keys in **Settings →
     API keys** (Anthropic, xAI, or an OpenAI-compatible key such as
     OpenRouter).

   It says plainly that the person's AI plan limits apply to bots that work
   around the clock, and that Anthropic's Claude Max plan or an API key works
   best for heavy use.
   When a waiting job's engine can run, the screen says **Connected. Starting
   your job…** for a moment, the choices step back, and the job goes to the
   chat as above.
6. Until one of those engines can run, every bot on the Cloud, including the
   default one, shows this sign-in rather than a chat that fails its first
   turn. Once one can run, the chat takes its place. Sign-ins stay on the
   machine's volume (`~/.claude`, `~/.codex`, `~/.grok`, the server's own
   config). On an older image without the Grok CLI, Grok's setup card says
   so in one line and offers an xAI key instead.

The Cloud's `GET /api/auth/session` answers `"cloudHome": true` for a paired
session; that is how the web UI knows to open the engine sign-in instead of
the welcome flow, which describes the person's own computer (it can still be
replayed from Settings).

### Use My Cloud on your phone

1. Get the phone app: the menu under your name → **Get the phone app** (App
   Store for iPhone, APK for Android).
2. The same menu → **Connect your phone · to your Cloud (always on)**, or
   **Settings → OpenMausBot Cloud → Use My Cloud on your phone**. The Cloud opens in
   the app window at its phone pairing.
3. **Create pairing code**, and scan the QR code with the phone app.

How it fits together (`src/lib/phone-pairing.ts`):

- **Connect your phone** opens Settings → Remote access at the pairing that
  fits the window, with focus on the button that shows the code: this
  computer's phone flow in the desktop app on its own computer, the Cloud's
  own pairing code (`ServerPairingCard`) on a Cloud home, and any other
  server's pairing code only for a session that may make one (the owner on
  that machine or an admin session, where pairing codes are on).
- On this computer, when the verified snapshot shows a paid plan (any tier)
  and a Ready Cloud, the menu has two **Connect your phone** lines: *to your
  Cloud (always on)* first, which does what **Use My Cloud on your phone**
  does, then *to this computer*. A paid plan whose Cloud is not Ready keeps
  the single *to this computer* line, with a note that the Cloud will show
  there. A failed switch opens Settings → OpenMausBot Cloud.
- **Use My Cloud on your phone** shows for a paid plan. With a Ready Cloud it
  calls `cloud-account:connectHomeForPhone`, which takes no arguments and
  connects as **Open My Cloud** does, adding the one fixed request
  `?desktop-settings=phone` (on `/pair` too, which carries it on once paired).
  The Cloud's page opens Settings on its phone pairing. It never makes a code
  by itself. Before the Cloud is Ready, or if opening it failed, the card
  lists the two steps instead. On the Cloud itself, Settings → OpenMausBot Cloud
  offers the same button and opens the pairing directly.

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
from their own device), or a restore the owner started (Copy this computer
here, or a backup restored in Settings); a routine made from the owner's bot template,
or a proposal the owner approved, is recorded as theirs when it is made.
Every other routine is nobody's: it runs confined, like a guest's, and
reports into a conversation that is nobody's. An owner's routine reports
into a conversation that is the owner's: the bot's main thread, unless
someone else opened that one.

A webhook is the owner's: only their own devices can create, edit or rotate
one, so its runs work at the bot's own level, in its project folder, with its
shell, as on the desktop. What a webhook brings in still never reaches the
lent Mac, whether it starts a run or posts to chat (below).

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

On a Cloud home a small card, **Set up My Cloud**, sits at the bottom left
until its steps are done or the person hides it (`src/components/CloudSetup.tsx`,
`src/lib/cloud-setup.ts`). Only the owner's own devices (an admin session on a
Cloud home) see it; desktop and self-hosted installs never do and keep their
welcome flow. The step to do now leads the card, with its explanation and
action, under a segment per step that fills as each finishes. Every other step
sits below it on one line; one not done becomes the lead with a click. The
chevron minimizes the card to its segments on this device only
(`omb.cloudSetup.collapsed` in browser storage), which is not hiding it. When
the last required step finishes in the session that is open,
the card gives way once to **Your Cloud is ready**, with the guide mascot;
a Cloud that opens already done shows nothing. Each step's state comes from
the Cloud or the app, never from a box the person ticks:

1. **Create your Cloud**: done from the start; the Cloud exists.
2. **Give it a first job**: done once a job is given to the first question
   (`cloud-intent-given`), or once a bot's turn has finished on the Cloud: the
   server records `onboarding.firstTurnAt` once, on a Cloud home only, for a
   turn that finished (not a failed or stopped one) in a bot's conversation or
   a room. The onboarding record never travels with a copy, so copied-in chats
   do not count. **Give it a job** asks the question again.
3. **Connect your AI**, the one required step: done when any engine on the
   Cloud can run. From another view, its **Connect** returns to the engine
   sign-in above.
4. **Approve its plan**: listed once a first job is given. The bot asks its
   questions in the chat and proposes a routine; done once that routine
   exists, the job's bot's and made after the job was sent (this device
   remembers which bot got it, `omb.cloudIntent.sent`; another device counts
   any routine). **Open the chat** goes to that bot.
5. **Bring your bots from your computer**: only in the desktop app, while the
   Copy this computer here card would be offered (an empty Cloud, a computer
   with work to bring; docs/copy-workspace.md). **Copy to My Cloud** opens that
   offer in place (the size, what stays, **Copy** and **Not now**). Done after
   a copy; skipped after **Not now**,
   which the Cloud keeps (`cloud-setup-move-skipped` in its onboarding record)
   and which also hides the one-time card.

A job counts as given the moment it is sent, before the Cloud's record
answers, so no step flickers back. When the main pane already shows the step that leads (the question, or the
sign-in in the chat view), the card says **You're on this step** instead of
repeating it. With every listed step done but no turn finished yet, the card says the bot
is setting itself up in the chat. Lending this Mac to the Cloud is not a step;
it stays in Settings → OpenMausBot Cloud and the menu-bar item's **Lending
settings…**.

**Hide setup** is the only dismiss. The Cloud keeps it (`cloud-setup-hidden`
in its onboarding record), so it holds on every device and after browser
storage is cleared, and it is the move's **Not now** too. The card also goes
away by itself once an engine can run and the Cloud has done something: with
a first job given, its routine exists (the bot's first turn only asks its
questions, so a finished turn is not enough); without one, a bot has finished
a turn there. With a routine, **Your Cloud is ready** names it and its next
run, and **Run it now** starts it at once so the first result need not wait
for the schedule. Nothing asks for confirmation.
After the card, the one-time Copy this computer here card behaves as on any
other server.

While a window shows a Cloud home, the sidebar's server switcher reads **My
Cloud · always on**; in a browser, a plain label says the same.

### Where bots work

A Cloud home is a headless Linux server, so its bots have two places: the
built-in browser and cloud computers. It never offers **This computer** (that
would be the server itself) or a **Local VM** (a Fly machine has no container
runtime). The person's own Mac is reached only when they lend it (**Let My
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

### Live calls

A Cloud is personal, so in the desktop app its own page may use the
microphone for a Live call, as this computer's own page does. That is the
microphone only, never the camera or screen capture, and only for the main
frame of the app's window at the exact origin of the person's Cloud
(`electron/app-permissions.mjs`, `appPermissionHandlers`). One rule says which
Cloud that is, for the microphone and the Cloud page's Settings → Plan alike
(`electron/cloud-home.mjs`, `myCloudOrigin`): the machine the Cloud sign-in
verified or, failing that, the one this same account last verified in this
app session. That last one counts while a check is pending or has failed, and
also after the sign-in has ended or expired, when Settings → Plan on the Cloud
says "sign in again on your computer". A check that names no machine for the
account ends it (a stopped machine named without its address does not). A
call placed while a saved sign-in is still restoring, in the first seconds
after launch, waits for it (at most 5 seconds) rather than being refused.
Signing out of OpenMausBot Cloud takes it away at once, and so do another
account, companion client mode and restarting the app before a check succeeds
(the last verified Cloud is kept in memory only); every other server's page
stays refused. In a web browser, the browser asks for the microphone for
the Cloud's address.

- **The key is the person's own.** No Cloud plan includes Live calls: the
  person pastes an OpenAI API key from a project with GPT-Live access. It is
  saved on the Cloud (`PUT /api/config`, as a server page has no credential
  store), and the Live copy says so.
- **The voice knows where it runs.** In the bot's own words
  (`CLOUD_HOME_PLACE` in `server/system-prompt.ts`), it is told it runs on
  the person's My Cloud, not on their own computer, and that the bot changes
  things on My Cloud (`liveInstructions` in `server/live-call.ts`).
- **A busy line names the app, never "this computer".** A Cloud is reachable
  from any machine, so a call is named by the app that holds it: a web
  browser (`client: "web"`) or the desktop app (`"desktop"`, on This
  computer or My Cloud). A second call is told "Another Live call is running
  in a web browser. Hang up there first." or "…in the desktop app…", and a
  browser's call shows in other windows' call bars as "Ada is on a Live call
  from a web browser". The phone apps show a client they don't know as
  "another device".
- **Take turns stays on the Mac.** Take-turns calls listen with the Mac app's
  on-device speech recognition, which a Cloud's page can't use. On a Cloud,
  the call with one bot is a Live call, and a room has no call
  (`effectiveCallMode` in `src/lib/call-mode.ts`, `GroupCallButton`).

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
   showing stays saved under **Servers**) and opens **Settings → OpenMausBot Cloud**.
   Before that view acts, the app gives a saved Cloud sign-in up to five
   seconds to finish restoring, so it is never mistaken for signed out.
3. Opened this way, the view acts on its own, with no confirmation:
   - signed out: it starts the existing device sign-in at once, which opens
     the browser approval page with the code filled in
     (`/cloud/desktop?code=…`);
   - signed in and the Cloud is **Ready**: it connects to **My Cloud**,
     exactly like **Open My Cloud**;
   - after that sign-in completes, or when the Cloud becomes **Ready** while
     the view is still open, it connects then;
   - anything else: the card shows the status and the person decides.

It starts at most one sign-in (only when signed out on arrival; a later
sign-out in that view starts nothing) and one automatic connection per link.
A failed connection shows the card's error; clicking the link again retries.
Closing Settings or choosing another section ends it. While it is open, the
first-run welcome waits, as it does for Organization settings. A normal visit
to **Settings → OpenMausBot Cloud** never signs in or connects by itself.

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

## Let My Cloud use this Mac

The Cloud is home: bots and chats live there. The person's Mac is a computer
the Cloud can borrow while it is awake. Lending is off until the person turns
it on, and it exists only between their own desktop app and their own Cloud
home. Other users (desktop only, self-hosted, hosted team workspaces) keep
computer sharing exactly as before: off unless a maintainer sets
`features.sharedComputers` by hand.

### What the person sees

In **Settings → OpenMausBot Cloud**, the **My Cloud** card has a **Let My Cloud use
this Mac** switch under **Open My Cloud** (it is part of connecting, not
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

The switch can be turned on before the first **Open My Cloud**; lending
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
  answer from someone else, one report of a routine the owner did not
  write, or one message a webhook posted (a webhook that posts to chat
  writes into the bot's Updates conversation), takes that conversation out
  of lending for good, because a resumed session carries everything said in
  it. A conversation a guest opened (and
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

The `Dockerfile`'s `cloud-home` target shares the server image's runtime
layers (Node, Chrome's libraries, agent-browser and its Chrome) and adds:

- Caddy (`deploy/fly/Caddyfile`), as the only listener the network can reach
  (`0.0.0.0:8080`);
- Grok Build (`/usr/local/bin/grok`) from xAI's own installer, pinned by
  `GROK_VERSION` to the version the Grok driver is verified against. The
  build fails if the installer cannot be reached, rather than shipping an
  image whose Grok sign-in cannot run; `--build-arg GROK_VERSION=` leaves it
  out on purpose;
- the engine CLIs from `CLOUD_HOME_ENGINES` (default Claude Code and Codex);
- the app files, root's, with `server/cloud-home-start.ts` (bundled to
  `dist-server/cloud-home-start.js`) as the entry point. The build fails if
  any file under `/app`, or Caddy, is not root's or is writable by others.

```sh
docker build --target cloud-home -t omb-cloud-home .
```

The app files are the last layers, so an image built from a later commit
differs from the previous one only in those (a few MB) unless Chrome, an
engine, Grok's pin, or the Node base image changed in between.

At boot the launcher, running as root, hands the volume's mount point to the
`maus` user, binds the volume to this machine as `maus`
(`/data/.omb-cloud-home.json`; another machine's volume, or an unmarked
volume with data on it, is refused), and runs two children as `maus`: the
server on `127.0.0.1:8799` (webhooks on `127.0.0.1:8800`) and Caddy on
`:8080`. It stays a small root supervisor: if either child exits, both stop
and Fly restarts the machine. The one exception: after a restore commits
(Copy this computer here, below), the server exits with code 75
(`server/restart.ts`) and the launcher starts only the server again.

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

`HOME=/data`, so `~/.claude`, `~/.codex`, `~/.grok` and OpenMausBot's own
data (`/data/.openmausbot`) persist on the volume.

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
- no `included.*` or other read-only instance is served, apart from a free
  trial's Claude credit (below); the person's own engines are otherwise the
  only way to a model.

### Included Boat computers, voice and decisions

Pro includes Boat cloud computers, ElevenLabs voice and the decision model
(TypeSafe's Jev, [decision-model.md](decision-model.md)) with no key to paste.
For each service the Admin has configured, it also sets:

| Variable | Fly | Value |
| --- | --- | --- |
| `OMB_CLOUD_BOAT_URL` | env | `https://cloud.openmausbot.com/api/cloud/services/boat/api/box/v1`, the Admin's Boat relay. It keeps Boat's own `/api/box/v1` ending. Bots use it only for cloud computers, as a tool on their own engine; no turn runs on Boat's own agent, so nothing calls its `/prompt`, `/events`, `/prompts/{id}` or `/interrupt` routes. |
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

### Trial Claude credit

A free trial may come with a one-time Claude credit (the Admin's
`OMB_CLOUD_TRIAL_CREDIT_USD`). While it lasts, and only while the person has
no AI of their own on My Cloud, bots run on Claude through the Admin's relay,
which holds the provider key and meters the credit. For an account with a
credit, the Admin also sets:

| Variable | Fly | Value |
| --- | --- | --- |
| `OMB_CLOUD_AI_URL` | env | `https://cloud.openmausbot.com/api/cloud/services/ai/v1`, an OpenAI-compatible base URL with its `/v1` (as the Admin sends it): `POST {url}/chat/completions` and `GET {url}/models` only. Nothing Anthropic-shaped (no `/v1/messages`) answers a credit token. |
| `OMB_CLOUD_AI_TOKEN` | secret | This machine's credit token (`omb_ai_…`), sent as `Authorization: Bearer`. It works only through the relay, only for this account's credit, and not at all once it is spent or the Cloud is deleted. |

- **OpenMausBot's own chat engine, nothing else.** `server/cloud-credit-provider.ts`
  adds one read-only **Trial credit · Claude** engine: the OpenAI-compatible
  driver (`openai-compat`, the same chat engine and tools as any API key) with
  the relay as its address and the token as its own key, on the models the
  relay lists, cheapest first (OpenRouter's `provider/model` ids too). Never Claude Code and never Codex: the
  platform's key is never used to run another product's agent for anyone, and
  no `ANTHROPIC_*` variable or Claude config folder ever holds the token. It
  is never saved to `config.json` and has no sign-in. The token is held like
  the included tokens (pipe, memory, the credential lists) and reaches only
  the relay; it is never shown, saved or logged. The address must be HTTPS and
  the token the Admin's shape, or there is no credit.
- **Out of the box.** A new Cloud's first bot runs on it when nothing of the
  person's own can run there (the first start waits up to 15 seconds for the
  relay's model list), so My Cloud opens on the chat, not the engine sign-in.
- **Their own always wins.** A new bot gets the person's own engine whenever
  one can run. From the moment one can (a sign-in, a key), each bot and
  conversation still on the credit moves to it, with one line in each, and the
  credit is not offered to bots any more.
- **Used up or gone.** The relay's refusal reads as one plain sentence that
  names the next step, never the API's JSON (`server/trial-credit.ts`), told
  apart by the relay's own error `code`, which it puts first in its error
  object (the chat engine keeps only the start of an error body): `402`
  `trial_credit_used_up` is used up, `402` `trial_credit_ended` or `401`
  `invalid_api_key` (a token it no longer knows) is no longer on this Cloud.
  The engine then stops offering itself until another token arrives (kept
  across restarts), and with no AI of their own My Cloud opens on its engine
  sign-in, saying why. A `401`, `402` or `403` without the relay's code (a
  proxy's page) is an ordinary failed turn. `429` (paused for now: the day's
  ceiling, a Cloud being stopped, or the Admin's own account with Anthropic)
  and `400` `trial_credit_too_low` (too little left for this chat; a new chat
  still runs) are only failed turns. A background call (a title, a summary)
  the relay refuses for good ends the credit the same way. Chat words each
  refusal again in the reader's language (`shared/trial-credit.ts`).

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
  to. Only with it does a copy to the Cloud count on a larger disk (and ask the
  Admin to grow it, below). Without it the app assumes nothing: a copy is measured
  against the Cloud's free space today, and one larger than the Cloud's whole
  disk says "tell us and we'll make room", never "remove files" or "try again".
  The Admin should send it together with `POST /api/cloud/desktop/disk`.
- `cloud.purchase: {state: "confirming" | "held", plan, paidAt}`: a payment
  received but not yet linked to this account. While it is there, the app shows
  "payment received" and offers nothing to buy. It never activates anything.
- `cloud.trial: {state, tier, endsAt, amount, chargeAt, holdUntil, deleteAt, keep, personalAmount?}`:
  a free trial on this account's Cloud (`electron/cloud-home.mjs`
  `parseCloudTrial`). `state` is `active`, `ending` (renewal off, or cancelled),
  `processing` (the first charge is being taken), `late` or `ended`; `endsAt`
  is when the first charge is due, `amount` that charge before tax in US cents,
  `deleteAt` when the Cloud's files are deleted if nobody subscribes, and
  `keep` what keeps the Cloud on the Cloud page: `portal` (turn renewal back
  on; for `ending`, renewal is off), `checkout` (subscribe again once ended),
  or `none` (nothing: renewing, or, for `ending`, cancelled outright).
  `personalAmount`, while it runs on a plan above Personal, is Personal's price
  in US cents, so the way down reads the same on every page of the app. An
  unknown state is no trial; a malformed date or amount is left out. It is
  display only: the entitlement still decides everything.
- `cloud.credit: {grantedUsd, remainingUsd, state}`: the trial's Claude
  credit (`active` or `used_up`), shown in Settings here and on the Cloud.
- `offer` (top level, beside `cloud`): what this account may buy now, only
  while it can (no plan, no Cloud, no payment being linked). See
  [Add a Cloud](#add-a-cloud) for its fields.

#### The free trial's notice

`lib/cloud-plan.ts` `cloudTrialView` is the one place that words a trial, for
the notice and for Settings (here and on My Cloud), with the same facts as the
Cloud page. Each state has one message and at most one next step, which opens
the Cloud page (`openDashboard`): **Manage subscription** (active, with the
date, the price after it and how to cancel; in its last two days on a plan
above Personal, also how to step down to Personal, with its price when the
app knows it), **Subscribe to keep it** (ending with renewal off, `keep`
`portal`, or ended: when My Cloud stops and when its files are deleted),
**Check payment status** (late), or nothing to do (processing; a trial
cancelled outright, `ending` with any other `keep`, which offers nothing to
buy until it has ended, because a new checkout would stop the running
Cloud).

Main decides when a notice is due and remembers it was shown
(`electron/cloud-trial-notice.mjs`, a small file in the app's data folder
holding only today's hashed keys), so it shows at most once a day per state,
on whichever page shows it first: an active trial only in its last two days,
a processing payment only after an hour (most cards settle at once), and
ending, late or ended whenever the Admin says. The page says it showed one
with `cloud-plan:notice-seen`, which names nothing. It is an entry in the
notice queue (below), on this computer's page and on My Cloud's own page.

#### One card at a time: the notice queue

`components/AppNotices.tsx` is the one place for the cards at the bottom left
(`lib/notices.ts`), asked in order, one on screen at a time, and none after
one closes until another launch:

1. **The card after the update** (`CloudTrialIntro`, id `cloud-trial-intro-v1`):
   OpenMausBot Cloud's free trial for someone signed out or with no plan who
   has used the app before this launch, only while the Admin offers a trial
   (it waits for one). Its numbers are the Admin's: the trial's days, the
   lowest monthly price, the Claude credit and money-back. At most once a
   calendar day, on at most three days (one for someone who closed the
   earlier Pro card), kept in browser storage and the workspace's hint record;
   any button, its X or Escape end it for good. **Start free trial** opens the
   Add a Cloud dialog, **Show me how** lights the server menu (below), **Sign
   in to your Cloud plan** (signed out) only hides it for now. Never on a
   branded build or a desktop signed in with an organization.
2. **The free trial's notice** (above), on this computer's page and on My
   Cloud's own page (its only entry there, after its engine sign-in and setup
   checklist).
3. **This computer's My Cloud card** (`CloudNotice`): a ready My Cloud for
   someone with a plan, or **Sign in again** where the sign-in ended (Not now
   kept per card).
4. **Star us on GitHub**, asked once.

None of them shows over setup (the welcome flow, the tour), a dialog, Settings,
the Add a Cloud dialog or its tip, busy work, or an update being offered; none
takes focus, and each is announced once to a screen reader.

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
**Open My Cloud** (no pairing code to type); when it cannot, the app
opens **Settings → OpenMausBot Cloud**, which says the next step. In the desktop app a
`/pair#code=` link connects without a second click; a browser still asks. On a
Cloud home the pairing page says where its connection starts (the environment
descriptor's `capabilities.cloudHome`).

On the person's own Cloud, open in the app's window, **Settings → OpenMausBot Cloud**
shows the plan read only (`cloud-plan:*`: its name and whether it is active,
**Manage in your browser** and **Switch to this computer**). It is listed only
on an OMB Cloud home (`config.cloudHome`), never on another server open in the
window. Main answers it for the Cloud this account verified, or last verified
while a check is failing or the sign-in has ended (`myCloudOrigin`, the rule
the Cloud's microphone uses too), so that page says
"checking" or "sign in again on your computer" rather than an error; where the
app cannot vouch for the Cloud it only says the plan is managed in the app on
the computer.

**Open My Cloud** first asks the machine whether this app is already
signed in there (`GET <origin>/api/auth/session` with its cookie). If not, it
calls `POST /api/cloud/desktop/pairing` (same device token) and expects
`{"cloudContractVersion":1,"origin":…,"code":…,"expiresAt":…}` for the same
origin, with `expiresAt` at most ten minutes away. It then adds or selects the
**My Cloud** server entry and opens `<origin>/pair#code=<code>`, the same
pairing-link flow as Connect to a server. The code stays in main-process
memory for that one navigation: never on disk, never in a renderer. A
malformed session summary or grant is treated as none.

## Add a Cloud

The one way to buy OpenMausBot Cloud in the app, the same for every way in:
the card after the update, **Show me how**, **Add a Cloud…** in the server
menu (the sidebar's and the menu bar's Server menu), Settings (the Cloud card
in General, and OpenMausBot Cloud), and the routine screen's note.

- **The menu item.** Main adds **Add a Cloud…** under the saved servers only
  for the installed app on this computer (never a dev build, companion mode or
  a branded build, read once from the local `/api/brand`), and decides on a
  click with nothing from the page: someone with a Cloud (paying or in a
  trial) gets a native "You already have My Cloud" box (**Email me when it's
  ready** registers interest once per account, `POST /api/cloud/desktop/interest`);
  anyone else gets the dialog on this computer's page, which the window
  switches to first. My Cloud's line in both menus (`electron/cloud-account.mjs`
  `cloudMenuSublabel`) says **Free trial until <date>** while a trial's end is
  ahead, **Always on** while it is paid for (a first charge processing
  included), **Stopped** when it isn't (a trial that ended, a payment problem,
  a subscription that ended), and nothing while this computer can't say
  (signed out, its sign-in ended).
- **Show me how.** One spotlight on the sidebar's server menu
  (`data-tour="server-switcher"`); the menu opened from it counts as reached
  from the tip, and the tip ends when the menu closes, or on Skip or Escape.
  With the menu off screen, the dialog opens instead with a line saying where
  the menu is.
- **The dialog** (`components/CloudAddDialog.tsx`, one state→view function,
  `lib/cloud-plan` `cloudAddView`) covers the buying journey only: the offer
  (the Admin's plans, Pro preselected and marked most popular, each row
  leading with cloud computers at once and storage; the trial's timeline with
  the reminder line only while the Admin sends one; the Claude credit;
  money-back beside the button; prices plus tax), the sign-in (its last step
  names the checkout only when the sign-in is on the way to one), the next
  step in the browser (the checkout open there, or, signed in on the way to
  one, the Admin's page after approval, which leads to it), the payment
  received, My Cloud starting, and My Cloud ready (**Open My Cloud**; never
  for someone who already had My Cloud before this sign-in). When a step
  ended without going on (the sign-in code expired or the sign-in ended, a
  checkout already being prepared), the offer says why. The plan picker is a
  radio group with one tab stop and arrow keys, and each new step takes focus
  at its heading. A payment problem, an ended sign-in or a Cloud that can't
  be reached go to Settings → OpenMausBot Cloud instead.
- **Checkout runs in the default browser, never the app.** Signed in, main
  asks the Admin for this account's checkout (`POST /api/cloud/desktop/checkout`
  with the plan and where it was opened) and opens the address only when it is
  Dodo Payments' own checkout page (`https://checkout.dodopayments.com`, no
  credentials, no fragment; its test origin only for a fixture Admin). An
  Admin before that route gets its Cloud page's
  `/cloud?checkout=start&plan=<plan>&src=<source>` instead. Signed out, the
  browser signs in first: main opens the Admin's own verified sign-in link
  with `&next=checkout&plan=<plan>&src=<source>` added (older Admins ignore it).
  The app follows its own session, never the return page: every 15 seconds
  for 30 minutes after it opened a checkout, and at once when the window comes
  back or `openmausbot://cloud` arrives (which then opens the dialog).
- **Ready.** When My Cloud is ready after a checkout this app opened and the
  window is elsewhere, one system notification says so.

### What the app reads (contract v1, additive)

- **Desktop session** `GET /api/cloud/desktop/session`, beside `cloud`:
  `offer: {plans, recommended?, trialDays?, creditUsd?, reminderDays?, refundDays?, checkout?}`,
  only while this account can buy. `plans[]` are the catalog entries on sale
  (`{tier, label, price: {currency: "USD", amount, interval: "month"}, allowances?, trialDays?}`):
  a plan's own `trialDays` is its trial; with none on any plan, a top-level
  `trialDays` is every plan's. `creditUsd` and `reminderDays` (days before the
  end that the reminder email goes out, sent only while it does) count only
  with a trial; `refundDays` only while this person can still have a
  money-back refund; `checkout: {plan, openUntil}` a checkout of theirs still
  open. A malformed offer is no offer; an Admin without `offer` gets the
  public plans with no trial (this account's own trial isn't known).
- **Public config** `GET /api/public/config` (signed out, no sign-in or
  cookie, at most every 10 minutes): `plans` as above, `trial: {days, holdDays,
  creditUsd?, reminderDays?}` and `refundDays`.
- **Device checkout** `POST /api/cloud/desktop/checkout`
  `{plan, source}` → `{cloudContractVersion: 1, url}`; `409` reads the session
  again, `429` says to use the open checkout or wait, anything else says
  nothing was charged; `404`/`405`/`501` is an Admin before the route.
  `source` is one of `app_card`, `app_howto`, `app_menu`, `app_settings`,
  `app_routines` (main refuses any other, and any plan the offer doesn't sell).
- **Interest** `POST /api/cloud/desktop/interest` `{kind: "another_cloud"}` → `{ok: true}`.
- Every signed-in request carries this app's version in `x-openmausbot-version`.

Nothing in the app is a price: with the Admin's trial switch off, no card is
shown, and the dialog offers today's plans at the Admin's prices, charged
today. Analytics (the app's existing, optional PostHog) register `app_version`
and `surface` (`local` or `server`) on every event, and count the card, its
actions, the tip, the dialog's views and checkouts opened, with no content.

## Copy this computer to your Cloud

The Cloud receives this computer's workspace the way every server the person
adds does: **docs/copy-workspace.md** is the one reference (where it is, what
moves and what stays, how it copies, Swap back, the restart, security). This
section is only what the Cloud adds.

- **The Admin's grant.** Main signs in to the Cloud through the Admin: it
  opens a single-use pairing window for the signed-in owner
  (`POST /api/cloud/desktop/pairing`, `pairHome`), so **Settings → OpenMausBot Cloud**
  can copy before the Cloud was ever opened in this app. No session in the
  window yet is therefore not a block on the Cloud, as it is on other servers.
  A saved "My Cloud" entry that is not this account's verified Cloud is copied
  to like any other server.
- **Settings → OpenMausBot Cloud**, under My Cloud once it is Ready, opens the same
  panel as Settings → Servers, named "My Cloud".
- **The setup checklist.** While the Cloud's setup checklist is up, the copy
  offer is its second step instead of a card (Setup checklist, above).
- **Its own page starts the copy.** Because main verified this Cloud through
  the Admin (`cloudPageSenderAllowed`), not on the Cloud's own word, its card
  and checklist step start the copy at once, only into an empty Cloud. Any
  other server's page leads to this computer's Settings instead
  (docs/copy-workspace.md, Security).
- **Disk growth.** Every Cloud starts at 10 GB; a plan whose disk grows grows
  it as it fills, up to the plan's maximum. Before anything is exported the app
  measures the copy (`moveFit`, with the Cloud's own `volumeBytes` from
  `GET /api/cloud-move`) against the plan's largest disk only when the Admin
  says how far it grows (`cloud.disk`): if it fits only once the disk grows, it
  asks the Admin to grow it now (`POST /api/cloud/desktop/disk {sizeGb}`,
  answered `{disk: {gb, maxGb}}`; `404` means this Admin cannot, so the app
  says "tell us and we'll make room" with no "try again"; `409`/`422` over the
  plan) and waits until the Cloud reports the room (only a timeout or no answer
  says "try again"). Not enough room says "make room on your Cloud" when the
  disk could hold it, "a plan with a larger disk" only when the copy is larger
  than the plan's whole disk, and never that on Max, the largest. No other
  server's disk is grown or measured against a plan.
- **The restart.** The Cloud's launcher (`server/cloud-home-start.ts`) starts
  only the server again on exit 75, and startup settles who owns what came
  (`server/cloud-owner.ts`): a copied routine is the owner's.
- **Older Clouds.** A Cloud from before Copy to My Cloud answers `404` and the app
  says it has not updated yet; one from before any server could receive a copy
  still receives one from this app (its routes are the same).

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
  scopes the person chose, which the Mac itself enforces (see "Let My Cloud use
  this Mac").

## Published image

Every push to `main` and every release tag publishes the home machine image as
`ghcr.io/milind-soni/openmausbot-cloud-home`, tagged `latest` (main only), `sha-<commit>` and the release tag.
It is the `Dockerfile`'s `cloud-home` target for the same commit, with Grok and the current Claude Code and
Codex installed. The Docker workflow's summary prints the digest. Set it in the Admin as
`OMB_CLOUD_HOME_IMAGE=ghcr.io/milind-soni/openmausbot-cloud-home@sha256:…`; changing it rolls the new image
out to existing machines one at a time, reverting automatically on a failed health check.
