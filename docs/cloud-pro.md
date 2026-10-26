# OMB Cloud: the home machine

OMB Cloud (the Starter, Pro and Max plans) gives one person an always-on
OpenMausBot server of their own (a plan may instead sleep when idle: see
[Sleeping homes](#sleeping-homes-the-power-read-and-the-sleep-handshake)). The plans differ in machine size, disk and
included allowances; everything on this page applies to all of them. Each
customer gets one Fly app with one `home` machine that is always on, a volume
at `/data`, and TLS at `https://<app>.fly.dev`. The desktop app, the phone and
the web are windows onto it. Local use of the app is unchanged and free.
Customers read its name as **MausBot Cloud** wherever they meet it (the
app, the Admin's pages, emails); "OMB Cloud" is this page's shorthand, and
the app itself is still OpenMausBot.

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
2. They open the desktop app, go to **Settings → MausBot Cloud** and sign in (the
   existing device sign-in). A **Your Cloud** card says **Setting up** until
   the machine is up.
3. When it is ready, the machine appears under **Servers** as **My Cloud**, and
   the card offers **Open My Cloud**. One click opens the machine in the
   app window, signed in. There is no second confirmation.
4. The first thing the Cloud shows is its welcome
   (`src/components/cloud-welcome/`, `src/lib/cloud-welcome.ts`): **Welcome to
   {name}** (the name this app keeps for the server, **My Cloud** where it has
   none), three steps on the left and the step on the right. It is only for the
   owner's own session on a Cloud home, and never for a Cloud set up before it
   (one that answered the first-job question, or where a bot has finished a
   turn, before the welcome ever showed there). The first time it shows, it
   says so in the Cloud's record (`cloud-welcome-shown`), so a chat that
   finishes before its first step (from a phone, say) does not end it.
   1. **Bring your stuff** comes first, before anything starts a chat. In the
      desktop app, this computer's things come over by themselves with the
      one-time move: while they come, the step says so in one line and the
      welcome moves on to the AI, ticking the step once they arrived. Otherwise
      it offers **Start fresh** (the team library in Advanced mode, the
      assistant in Simple mode); **Skip for now** is kept
      (`cloud-setup-move-skipped`). An older desktop app that still copies by
      hand is told to update, so it brings the bots by itself. In a browser, on
      a phone, or in a desktop app that is another server's client, it offers
      Start fresh and says that the desktop app brings bots from a computer. On
      a Cloud that already has bots or chats of its own (a chat from a phone,
      say), it says **Your bots are already here**, and **Continue** moves on.
      A backup file is imported from Settings → Backups, as on any server.
   2. **Connect your AI**: the engine sign-in's own tiles and sign-in panel
      (below), with **Connected** on one that can run. While the trial's Claude
      credit lasts and nothing of the person's own can run, a line says so
      (with the amount where the desktop app knows it), and **Use my credit for
      now** moves on.
   3. **Files and apps**, optional: **Share folders** opens Settings → MausBot
      Cloud in this computer's window, one click from Files (a browser is told
      to use the desktop app), and **Connect apps** opens Connected apps on the
      Cloud.
   4. **{name} is ready**: **Say hi to your Chief of Staff** (or to the first
      bot) opens its chat, and **Give it a job** asks the first-job question.

   Each finished step is kept in the Cloud's onboarding record
   (`cloud-welcome-bring`, `cloud-welcome-engine`, `cloud-welcome-files`),
   which never travels with a copy, so the welcome opens where it was left on
   any device; the steps can be visited in any order from the left. It ends for
   good at its last step or with **Skip setup** (`cloud-welcome-done`), and
   with Hide setup. A save the Cloud refuses (a 409 while provider settings
   are being changed, say) is tried once more; an end that still cannot be
   saved is kept on this device (`omb.cloudWelcome.done`), so the welcome does
   not come back on the next launch, and a small keeper beside the setup card
   (`WelcomeKeeper.tsx`) sends it again when the Cloud answers.
   The main pane and the setup card read the record the same way, with the
   hints written here and not saved yet. Picking another bot or room in the
   sidebar steps it aside for the session; **Continue setup** on the setup card
   brings it back.
5. The first-job question, **What should your Cloud do while you're away?**
   (`src/components/CloudIntent.tsx`, `src/lib/cloud-intent.ts`), is asked
   only when asked for: from the welcome's last step, or the setup card's
   **Give it a job** on a Cloud set up before the welcome. It is a box drawn
   like the composer, with `/setup` fixed in front of the text, four
   ideas that fill it in (a news digest, watching a page, a research roundup,
   a daily plan); hovering one previews its full text in the box. It is never a
   gate: **Skip for now** sits in plain view under the ideas, Escape skips while
   the box is empty, and picking another bot in the sidebar goes to that bot.
   The answer is sent as `/setup <job>`
   (server/setup-mode.ts), so the bot asks at most four questions and sets
   itself up for the job in the chat. With an engine already able to run, it
   is sent at once; the box becomes the composer on the way (a named View
   Transition) and the request is the chat's first message. Otherwise the job
   waits on this device (`omb.cloudIntent.pending` in browser storage) and
   the engine sign-in shows it at the top, with **Edit**. The Cloud keeps
   that the question was answered (`cloud-intent-asked`) and that a job was
   given (`cloud-intent-given`) in its onboarding record.
6. With no engine signed in, the engine sign-in
   (`src/components/CloudEngineSignIn.tsx`; the welcome's second step shows the
   same tiles and panel while it is open): provider tiles side by side (two,
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
7. Until one of those engines can run, every bot on the Cloud, including the
   default one, shows this sign-in rather than a chat that fails its first
   turn. Once one can run, the chat takes its place. Sign-ins stay on the
   machine's volume (`~/.claude`, `~/.codex`, `~/.grok`, the server's own
   config). On an older image without the Grok CLI, Grok's setup card says
   so in one line and offers an xAI key instead.

The Cloud's `GET /api/auth/session` answers `"cloudHome": true` for a paired
session; that is how the web UI knows to open the Cloud's welcome and engine
sign-in instead of the welcome flow, which describes the person's own computer
(it can still be replayed from Settings).

### Use My Cloud on your phone

1. Get the phone app: the menu under your name → **Get the phone app** (App
   Store for iPhone, APK for Android).
2. The same menu → **Connect your phone · to your Cloud (always on)**, or
   **Settings → MausBot Cloud → Use My Cloud on your phone**. The Cloud opens in
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
  there. A failed switch opens Settings → MausBot Cloud.
- **Use My Cloud on your phone** shows for a paid plan. With a Ready Cloud it
  calls `cloud-account:connectHomeForPhone`, which takes no arguments and
  connects as **Open My Cloud** does, adding the one fixed request
  `?desktop-settings=phone` (on `/pair` too, which carries it on once paired).
  The Cloud's page opens Settings on its phone pairing. It never makes a code
  by itself. Before the Cloud is Ready, or if opening it failed, the card
  lists the two steps instead. On the Cloud itself, Settings → MausBot Cloud
  offers the same button and opens the pairing directly.

### Only your own devices

A Cloud home is personal (`server/cloud-owner.ts`): only the owner's own
devices connect (the desktop app, a phone, a browser signed in from the Cloud
page), each with an admin session that the Admin's signed pairing, or one of
those devices, gave it. The server mints and accepts nothing else, and says
so in one line, "My Cloud is personal: only your own devices can connect.":

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
from their own device), a routine the one-time move brought, or a restore the
owner started (a backup restored in Settings); a routine made from the owner's bot template,
or a proposal the owner approved, is recorded as theirs when it is made.
Every other routine is nobody's: it runs confined, like a guest's, and
reports into a conversation that is nobody's. An owner's routine reports
into a conversation that is the owner's: the bot's main thread, which only
a conversation the owner opened can be.

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
run of one of the owner's routines. A bot's own change applied with an Undo
receipt (a skill it authored, a team it set up) is nobody's answer, so it
never takes a conversation out of being the owner's own. Approving a change
(an edit, a pause, a resume) keeps a routine the owner's only if it already
was: it never makes anyone else's routine theirs.

A Cloud only its owner has ever used has nobody to confine. While no trace of
a second person exists anywhere on it (no session other than the owner's own
devices, current or revoked; no earlier key that was never proven the owner's;
no line, card answer, conversation or routine recorded under anyone else's
key; and a record that can be read), every routine and conversation runs at
its bot's own level, whatever writer it has on record. Only what came in from
outside stays confined: a routine a bot made or changed in a conversation a
webhook drove (its run, a payload posted into it, or work it handed on) is
recorded as the outside's, and runs without full access until the owner opens
it and saves it once. Routines from before this that a webhook-driven
conversation made or changed are recorded the same way, once. The first trace
of a second person makes the Cloud shared for good: cloud-owner.json records
when, nothing clears it, and a restore never brings or removes it. If that
happens after a start found only the owner, every routine a bot made in a
conversation only the owner spoke in (lines copied from the owner's desktop
count) is recorded as the owner's at that moment; from then on the rules below
apply.

A routine runs at the level of the conversation it was made in. One a bot
creates at once, or changes while it is the owner's, in a conversation where
only the owner spoke (it was opened, written in and answered only by proven
keys, the owner's own devices, and nothing came in by webhook; what bots
posted there, such as receipts and routine reports, does not count) is the
owner's for its level, so its runs keep the bot's own level, Full access
included. It is proven for lending and memory only when that conversation also
holds no report of anyone else's routine. One a bot creates or changes at once
from any other conversation (someone else's line or answer, an adopted key's,
another bot's message, a webhook's post or run) is nobody's, like anyone
else's edit. At each start, a nobody's routine a bot made is the owner's again
when its creating card is still in that conversation, only the owner spoke
there before it, and the routine still runs exactly what that card showed;
proven too when no report of anyone else's routine came before the card. A
confined routine run's approval card says why: open it and save it once to run
it with full access. Resuming, moving or
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
the Cloud or the app, never from a box the person ticks.

It is the welcome's steps in short, never a second checklist beside it: while
the welcome fills the window the card does not show. When the person steps
away from the welcome, the card lists **Create your Cloud** (done from the
start), **Bring your stuff** (done once this computer's things came over or
after a team from the library, skipped after Start fresh or Skip for now), **Connect your AI** (done once the welcome's step was
passed with an engine that can run, the trial's credit included; skipped when
passed without one) and **Files and apps**, and the step that leads offers
**Continue setup**, which opens the welcome on that step. After the welcome
ends, the card stays only while no engine can run, or while a job given at
the welcome's end waits for its routine (the steps below), and then gives way
once to **Your Cloud is ready**.

A Cloud set up before the welcome (it answered the first-job question, or a
bot has finished a turn there) keeps the first-job checklist:

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

A job counts as given the moment it is sent, before the Cloud's record
answers, so no step flickers back. When the main pane already shows the step that leads (the question, or the
sign-in in the chat view), the card says **You're on this step** instead of
repeating it. With every listed step done but no turn finished yet, the card says the bot
is setting itself up in the chat. Lending this Mac to the Cloud is not a step;
it stays in Settings → MausBot Cloud and the menu-bar item's **Sharing
settings…**.

**Hide setup** is the only dismiss. The Cloud keeps it (`cloud-setup-hidden`
in its onboarding record), so it holds on every device and after browser
storage is cleared, and it is the welcome's end too. The card also goes
away by itself once an engine can run and the Cloud has done something: with
a first job given, its routine exists (the bot's first turn only asks its
questions, so a finished turn is not enough); without one, the welcome has
ended, or on a Cloud set up before it, a bot has finished a turn there. With a routine, **Your Cloud is ready** names it and its next
run, and **Run it now** starts it at once so the first result need not wait
for the schedule. Nothing asks for confirmation.

While a window shows a Cloud home, the sidebar's server switcher reads **My
Cloud · always on**; in a browser, a plain label says the same.

### Where bots work

A Cloud home is a headless Linux server, so its bots have two places: the
built-in browser and cloud computers. It never offers **This computer** (that
would be the server itself) or a **Local VM** (a Fly machine has no container
runtime). The person's own computer is reached only when they lend it (**Let My
Cloud use this computer**, below), through the shared-computer tools.

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
- The built-in browser never opens Reddit (`reddit.com`, `redd.it`,
  `redditmedia.com`, `redditstatic.com`, `reddit.app.link` and their
  subdomains): Reddit blocks bots that browse from data-centre addresses and can
  ban the person's account. The egress gate refuses those names, whether the
  page was typed, linked, redirected to or framed, and a bot's call that would
  open one is told so and pointed at the Reddit connected app or the person's
  own computer (`server/browser/egress/reddit.ts`). A cloud computer's
  `open_url` refuses them the same way. The desktop's and a self-hosted
  server's browsers are not limited.

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
Signing out of MausBot Cloud takes it away at once, and so do another
account, companion client mode and restarting the app before a check succeeds
(the last verified Cloud is kept in memory only); every other server's page
stays refused. In a web browser, the browser asks for the microphone for
the Cloud's address.

- **The key is the person's own.** No Cloud plan includes the key, and no plan
  is needed for Live calls: they use the OpenAI key in Settings → API keys, or
  a separate Live key, from a project with GPT-Live access. It is saved on the
  Cloud (`PUT /api/config`, as a server page has no credential store), and the
  Live copy says so.
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
   showing stays saved under **Servers**) and opens **Settings → MausBot Cloud**.
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
to **Settings → MausBot Cloud** never signs in or connects by itself.

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

## Use my Mac: Let my bots use this Mac

The Cloud is home: bots and chats live there. The person's Mac or PC is a computer
the Cloud can borrow while it is awake: its folders, its screen and apps, and its
home internet connection. The switch reads **Let my bots use this Mac** on a Mac,
**this PC** on Windows and **this computer** on Linux. Lending is off until the
person turns it on (or until the move to My Cloud turns it on with the default
grant below), and it exists only between their own desktop app and their own Cloud
home. Other users (desktop only, self-hosted, hosted team workspaces) keep
computer sharing exactly as before: off unless a maintainer sets
`features.sharedComputers` by hand.

### What the person sees

In **Settings → MausBot Cloud**, the **My Cloud** card has a **Let my bots use
this Mac** switch under **Open My Cloud** (it is part of connecting, not
a dialog). Turning it on shows what can be lent; each change applies at once,
with no confirmation. The switch and the chosen scopes are the consent.

- **Internet connection**: the sites that turn away data centres (Instagram,
  YouTube, Google sign-in) open for the bots' browser on My Cloud through this
  computer, so they see the person's home connection; every other site loads
  straight from My Cloud (see "The internet connection" below). It can be the
  only thing lent.
- **Folders and drives**: chosen with the folder picker. A whole drive can be chosen too (an external disk under /Volumes on macOS, a drive letter on Windows, a mounted data disk such as /data or /mnt/backup on Linux). Read-only by default; **Can
  edit** lets bots create files and overwrite them, but only after reading the
  current version (the overwrite is checked against its hash). Nothing is ever
  deleted. A read takes a file of up to 2 MiB (text whose escaping would not fit
  the Cloud's 4 MB request body is refused with "read it as base64"); a write is
  at most 256 KiB. No symbolic or hard links. The home folder itself can be
  chosen after a warning, and is always read only: everything in it becomes
  readable, while the places that hold keys, passwords and browser data (see
  "What folders never reach" below) stay private inside it too. The system
  disk and the folders above home cannot be chosen. A lent folder deleted since is left out; the rest keeps working.
- **Apps and screen**: bots see the screen and use apps as the person, through
  this app's own computer control (the signed app holds Accessibility and
  Screen Recording; the Cloud never does). This is broad by nature, since it
  reaches anything those apps can, and the switch says so. It needs local
  computer control set up first.
- **Terminal** (off by default): bots run commands on this computer as the person, on macOS, Linux and Windows, with no
  limit on what a command can do. It is a separate checkbox in this computer's own Settings (never from My Cloud's page,
  never in the default grant), it asks before turning on, and it is not kept when the switch is turned off. Every command is
  listed under Activity.

The switch can be turned on before the first **Open My Cloud**; lending
starts once this Mac is signed in to the Cloud. Lending runs while the app is
open: quitting it (or the Mac sleeping) only pauses lending, and it resumes
when the app runs again with the switch still on. Below the choices, **Activity
on this computer** lists every request the Cloud made, refused ones included,
and each website opened through this computer's internet connection
(**Opened a website** with its name, once per site and outcome every 10
minutes, so a page's many connections are one line).

The switch always says where lending stands, whichever way it got there:

- **Off, and why.** When lending stops (the person turned it off, signed out
  of MausBot Cloud, another account signed in, or My Cloud moved to another
  machine) the reason and the time are kept with the grant, so after a restart
  the switch still says "Off since 7 Oct, 14:02, when you signed out of MausBot
  Cloud." The folders and apps-and-screen choice are kept too: **Lend the same
  again** restores them in one click.
- **One control for My Cloud.** **Settings → Servers** no longer offers
  **Computer access** for My Cloud's entry (it wrote the same record with a
  terminal option this switch never offers, so the switch could read off while
  that panel showed apps and screen lent). That entry links here instead. A
  Computer access grant saved for My Cloud before shows here as lent, terminal
  included, and when it cannot run (that panel follows the maintainer flag) it
  says so. Stopping or choosing here replaces it.
- **Last used.** "My Cloud last used this computer 3 minutes ago", from the
  activity log, so a website opened through it counts too.
- **Reconnects by itself.** Lending already resumed after sleep, a lost
  network or a Cloud restart. When this app's session on the Cloud has ended
  (unused for a month, or signed out there), main now signs the window back in
  to the verified Cloud with a fresh one-time code, as **Open My Cloud** does,
  at most every 15 minutes, instead of waiting for a click. A saved Cloud
  sign-in still being read at startup pauses lending; it never counts as a
  sign-out.

On My Cloud's own page, **Settings → MausBot Cloud** lists **Computers lent to
My Cloud**: each by name and platform, **Online now**, **Offline, last online
…**, or **No longer lent**, what it lends and when My Cloud last used it. In
the desktop app it starts with this computer's own **Let my bots use this Mac**
switch and its one line (electron/cloud-lending-ipc.mjs), so nobody leaves My
Cloud to change it: the page learns only on/off, how it is going and folder
names, never a path; turning it on needs the person's real click on the switch
(the preload bridge checks it), and nothing else asks. While it is on, the page
also has **Apps and screen**: ticking it needs a real click too, and main then
asks in a native dialog of its own, because a page served by the Cloud must
never grant control of the computer alone. Turned on with nothing chosen (here
or on this computer), lending lends the internet connection and Desktop,
Documents and Downloads, read only; other folders and editing wait under
**Choose what's lent** on this computer. A bot that finds apps and screen not
lent is told where to tick it, in the refusal and in list_shared_computers. Where the system
names the home folder itself for one of them (Linux without user-dirs.dirs),
the folder of that name in the home folder is lent instead; one that can't be
found is left out. A refusal a person can act on (the whole home folder or a
disk, a file, more than 20 folders) is said in plain words; only a failure
that trying again can fix says Try again. A computer that lends its internet
connection shows **Shares: internet connection, …**, and while it is away
**While it's away, Instagram, YouTube and Google sign-in open from My Cloud's own
connection and may turn your bots away.**

**The default grant at the move.** The move to My Cloud turns lending on by
itself (`installCloudLending(...).lendByDefault({ projects })`): the internet
connection, Desktop, Documents and Downloads read only, each moved bot's own
project folder with editing, and apps and screen when they were lent before or
computer control already works here for this computer's own bots (on macOS:
Accessibility and Screen Recording already granted, read from computer
control's running state, never by asking macOS). It adds to what is lent
already, never takes away, and never undoes the person's own Off: lending they
turned off (`stopped.reason "you"`) stays off, across restarts too.

**Use my Mac** (`electron/use-my-computer.mjs`). When the move leaves this
computer not fully lent (apps and screen still off because macOS hasn't granted
them yet), main shows one popup of its own, once: **Let your bots use this
Mac?** (this PC, this computer), one plain line, **Use my Mac** and **Not now**.
It waits for a shown window and a few seconds with no typing, so a key meant for
the page never answers it. **Use my Mac** lends every part at once (undoing even
the person's own earlier Off); where apps and screen still need macOS, the same
press starts computer control again, which asks macOS, then opens each
permission still missing in System Settings, Accessibility then Screen
Recording, and starts computer control again whenever the person comes back.
Screen Recording often works only after OpenMausBot restarts: the choice is kept
(`use-my-computer.json`), and apps and screen go on once computer control works.
**Not now** is never asked again on its own. A computer that moved before this
version gets the same popup once, on its first launch after it. When a bot
needs the computer, it gives the person `[Use my Mac](openmausbot://use-my-computer)`;
in the desktop app that opens the same popup (on My Cloud's page only from a
click), and anywhere else it is plain text.

While lending is on, a menu-bar item shows it (**In use** while bots use this
Mac: running something on it or browsing through it) with **Stop sharing**, and the
app opens at login, out of sight (`electron/open-at-login.mjs`: a login item on
macOS and Windows, an XDG autostart entry on Linux; only one this app added is
ever removed, and only such a launch starts hidden). Turning the switch off or
choosing **Stop sharing** stops at once: the Cloud is told, a running action
is cancelled (the computer-control transport is closed and the screen lease
released), and nothing more runs. An action an app had already started may
still finish.

### The internet connection

Every bot browser on a Cloud home already connects through its per-session
SOCKS egress gate (`server/browser/egress/gate.ts`). While the owner's lent
computer is online with the internet connection on, the gate has one more way
out for the sites that turn away data centres, the computer itself
(`server/device-links.ts`, offered by `server/browser/egress/registry.ts` for
the names in `server/browser/egress/home-sites.ts`):

- **The device link.** One WebSocket per lent computer, opened by the desktop's
  main process to `wss://<My Cloud>/api/shared-computers/<id>/link` with the
  same sign-in as the poll (the session cookie plus the grant's secret). It
  carries open, data, credit, end and close frames for many TCP streams, each
  side sending a stream's bytes only while the other has room (a 256 KiB
  window per stream, at most 128 streams), with pings both ways: a link that
  goes silent is dropped within seconds on either side. The Cloud advertises
  `capabilities.deviceLink`; a desktop never dials an older Cloud. The path is
  held like the poll, so it never keeps My Cloud awake, and the desktop never
  dials it while My Cloud sleeps: it waits on the same power gate, and My
  Cloud closes it as asleep (code 4001) the moment it agrees to sleep.
- **What goes through it.** Reddit is refused first, as before. A name for
  this machine (`localhost`) and every address that is not on the public
  internet stay on the Cloud's own way, under its own policy (a bot's dev
  server here still loads; the local network and metadata stay refused). Only
  the sites that turn away data centres become a stream on the link, and the
  computer resolves the name itself: Instagram (its 429), YouTube with its
  videos, which play only for the address that asked for them
  (`googlevideo.com`) and its player's check (`jnn-pa.googleapis.com`), and all
  of Google in every country (sign-in refuses a data centre and search answers
  it with "unusual traffic"; a Google account signed in from home stays on
  home). Every other site loads straight from My Cloud: through a home
  connection on the other side of the world it is much slower (measured in
  PR #3201: in India with My Cloud in Frankfurt, BBC News took 58 s instead of
  2 s and the Python docs 3.6 s instead of 0.6 s), and a site that answers a
  data centre gains nothing from it. The list is My Cloud's alone, so a new
  site needs only a Cloud update.
- **The computer's own check** (`electron/device-egress.mjs`, with the one
  address list both sides use, `electron/egress-addresses.mjs`): only ports 80
  and 443; never loopback, the computer itself, the networks it sits on (its
  own IPv6 prefix included), the private ranges (100.64/10 and fc00::/7
  included), the home's own public address (the address My Cloud sees the link
  come from), link-local, metadata or reserved addresses, after unwrapping NAT64
  and 6to4; every address a name resolves to must pass, and it connects only to
  the addresses it checked. A refusal reaches the bot's page-health line ("the
  person's own computer or home network", "a port other than 80 and 443").
- **When the computer is away**, those sites load from My Cloud's own
  connection at once, a connection in flight ends with the link, and the bot
  is told once, the first time one of them loads that way: "The person's Mac is
  away, so sites that turn away data centres, such as Instagram, YouTube and
  Google sign-in, load from My Cloud's own connection for now and may refuse…".

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
- **What folders never reach**, read-only or not, and with the whole home
  folder lent too: this app's data and grants,
  keys and sign-in stores (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`,
  `~/.claude`, `~/.codex`, `~/.cua`, keychains, browser profiles and cookies…;
  on Windows also Chrome's, Edge's and Brave's user data, Mozilla, the
  credential store and vault with their Protect keys) and places that run code
  (`~/Library/LaunchAgents`, the Windows Startup folder, git and shell
  configuration, `~/.local/bin`), decided by filesystem identity rather than
  spelling. Writes inside any `.git` directory are refused.
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
  only: time, action, folder and relative path, tool name or website name, and
  whether it ran (a refused website keeps the computer's reason). Never contents, output or typed text. The app only ever appends to it
  (never through a link); a full file of 500 entries is moved to
  `lending-activity.jsonl.1` intact. No folder or screen argument reaches it.

On the Cloud home (`server/shared-computers.ts`, `server/index.ts`):

- Lending is on for every Cloud home, with no maintainer flag.
- Only the owner's admin sessions (the Admin's signed pairing gives the
  desktop one) can lend.
- **What it remembers** (`server/lent-computers.ts`, `lent-computers.json`):
  for each computer lent to it, by name, its platform (sent by desktops once
  the Cloud advertises `lendingDetails`), how many folders it lends and whether
  apps and screen or a terminal, when it was last online (written at most once
  a minute) and last used (a page opened through its internet connection
  counts, at most once a minute), and whether its owner turned lending off. Never a
  folder name or path, a secret or anything a job carried; kept 90 days.
- **What bots are told.** `list_shared_computers` lists online computers with
  their `device` ("PC", "Mac" or "computer"). When none is online it adds
  `offline` and a `say` sentence naming the computer, its kind and when it was
  last online ("Their PC ASH-PC is lent to My Cloud but offline (last online
  …)"), or that lending was turned off on it. The Cloud prompt names the
  person's computer the same way and tells bots never to call a PC a Mac; an
  offline `shared_computer` call says the same.
- The server refuses operations outside the scopes the Mac registered before
  queuing them, never retries an operation with an unknown outcome, and never
  substitutes its own files for an offline Mac.
- Only turns that provably act for the owner may use the lent Mac
  (`server/cloud-lending.ts`): a conversation the owner started from one of
  their own devices (a live session with admin scope), a scheduled run of a
  routine the owner wrote or last rewrote from one of those devices, or a run
  of it the owner started by hand. Never a webhook-started run (its payload
  comes from outside), a guest's conversation or routine (a device paired
  with chat-only access), a routine someone else rewrote, a room, a turn a
  teammate handed a bot (`coordinate_bots`), a local process on the Cloud, or anything the
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
  work a guest's turn hands a teammate (`coordinate_bots`: work, a question
  with `consult`, a room hand-off), however deep — every hand-off is an
  assignment on the job runtime with the guest's outside lineage
  (docs/runtime-contract.md §4, §9). Work or a question for a teammate runs
  in the work thread the guest's conversation has with that teammate, opened
  as the guest's, never in the owner's conversation with it, and is never
  folded into a turn running there. It works in a folder of its own, never the bot's
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
  | API models (OpenAI-compatible, MiniMax, Mistral, Grok API) | no shell or file tool on the machine at all; only the harness's own agents tools are pre-allowed, every other MCP call asks the owner, and no owner's "Always allow this session" applies or is kept. |
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
  other bots through rooms and `coordinate_bots`, and a turn that may use
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
(a backup restored in Settings), the server exits with code 75
(`server/restart.ts`) and the launcher starts only the server again.

The machine's secrets (`OMB_CLOUD_BOOTSTRAP_SECRET` and the relay tokens
`OMB_CLOUD_BOAT_TOKEN`, `OMB_CLOUD_VOICE_TOKEN`, `OMB_CLOUD_DECIDER_TOKEN`, `OMB_CLOUD_X_TOKEN`)
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

### Memory

A home is one machine, without swap on Pro and Max, and every engine process
(OpenCode, Claude Code, Codex and the other agent CLIs) starts its own copy of
each MCP server: one OpenCode thread measured 361 MB on its own and 623 MB
with six MCP servers before its first prompt. Several at once can fill the
machine, and then the kernel thrashes for a long time before its OOM killer
acts: the health check stops answering and the stalled turns read like a
provider outage. So on a Cloud home (`server/engine-memory.ts`):

- **A turn that needs a new engine process waits for memory.** It starts
  once the machine's available memory (plus half of any free swap), less a
  tenth kept for the server, Chrome and the page cache, and less what engines
  admitted in the last 90 s have yet to take, fits one more engine (the
  average the engines here measure, 700 MB until one is measured). The chat
  says "Waiting for memory: N tasks are running on this Cloud …", again every
  ten minutes (which keeps both stall checks quiet), and the turn starts by
  itself. Stop ends the wait. A thread whose engine is still running never
  waits, and the only task is never held back.
- **OpenCode threads share a process.** Threads whose OpenCode would start
  the same way (same login, approval level and settings) run as sessions of one
  `opencode acp` process, up to six at a time and twelve over its life
  (`server/drivers/acp/host.ts`). Five sessions measured 811 MB in one process
  against 2,381 MB in five. A session joining a running process waits only for
  a session's worth of memory (200 MB). OpenCode 1.19.3 keeps a closed
  session's memory and MCP servers until its process exits, so a process
  holding closed sessions ends once none of its sessions has run a turn for a
  minute, and each thread's next turn loads its session in a new process.
- **An engine nobody is using gives way first.** Engines stay up between
  turns; one that is idle is stopped to make room before anything waits.
- **Idle engines stay up only for the conversation in front of a person**
  (`engineIdleMs` in `server/drivers/session-idle.ts`). A thread a person
  wrote in from any channel, or opened or read in the app, in the last 30
  minutes keeps its engine the configured 10 minutes after a turn, scaled by
  the memory left: all of it with half the machine free above the tenth, down
  to a tenth of it as memory runs out. Any other thread (a teammate's
  delegated work, a routine) keeps its engine 30 seconds.
- **About to run out, the home stops its newest engine** rather than freeze:
  every 2 s while engines run, when free memory falls under 4% (160 MB at
  least), or the memory stall reaches 40% below the tenth, it stops an idle
  engine, else the newest of two or more busy ones, at most every 15 s, and
  not in the tick right after the kernel's own OOM killer acted.
- **The kernel's order** (`server/oom-score.ts`): engines, and everything they
  start, are born with `oom_score_adj` 1000; Chrome scores its tabs 200 and
  up; the server is -800 and Caddy -900, so the health check is the last to
  go.
- **OpenCode reaches OpenMausBot's own tools over HTTP.** The agents,
  browser, computer, Data and HighLevel servers are endpoints of this server
  (`/api/internal/mcp-http/<name>`, `server/routes/own-mcp-http.ts`) with the
  turn's capability in the Authorization header, instead of a Node proxy
  process each (about 20–30 MB PSS apiece) in every OpenCode session. A server
  behind a tool selection keeps its stdio gate; the person's own servers are
  unchanged.
- **The reason is said.** A turn whose engine was stopped for memory, by the
  home or by the kernel (a SIGKILL while `/proc/vmstat`'s `oom_kill` rose),
  fails with "This Cloud ran out of memory while N tasks ran at once, so this
  one was stopped. It was not a problem with the AI provider. New tasks now
  wait until there is memory for them.", and a turn that stalled while memory
  was short says so after "no activity for 20 minutes". The health report
  counts both as `out_of_memory`.

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
| `OMB_CLOUD_BOAT_URL` | env | `https://cloud.openmausbot.com/api/cloud/services/boat/api/box/v1`, the Admin's Boat relay. The app speaks Boat's public API v1 (`/sandboxes`, `sandbox` envelopes); this relay still serves Boat's retired box API (`/boxes`, `box` envelopes), so for a base ending in `/api/box/v1` the app translates paths and answers in one place, `server/boat-relay.ts`. A base ending in `/api/v1` gets v1 as it is. Bots use it only for cloud computers, as a tool on their own engine; no turn runs on Boat's own agent, so nothing calls its `/prompt`, `/events`, `/prompts/{id}` or `/interrupt` routes. |
| `OMB_CLOUD_BOAT_TOKEN` | secret | This machine's Boat relay token (`box_omb_…`). It is not a Boat key and works only through the relay. |
| `OMB_CLOUD_VOICE_URL` | env | `https://cloud.openmausbot.com/api/cloud/services/voice/v1`, the Admin's voice relay. |
| `OMB_CLOUD_VOICE_TOKEN` | secret | This machine's voice relay token (`omb_voice_…`). |
| `OMB_TTS_DEFAULT_VOICE` | env | An ElevenLabs voice id, used until the person picks a voice or another speech provider in Settings. |
| `OMB_CLOUD_DECIDER_URL` | env | `https://cloud.openmausbot.com/api/cloud/services/decider`, the Admin's Jev relay. It is a Jev base URL, used as it is: the decider adds `/v1/systemone`, the relay's only route, so every included decision goes to exactly `<OMB_CLOUD_DECIDER_URL>/v1/systemone`. |
| `OMB_CLOUD_DECIDER_TOKEN` | secret | This machine's decision relay token (`omb_decide_…`). It is not a Jev key and works only through the relay. |
| `OMB_CLOUD_X_URL` | env | `https://cloud.openmausbot.com/api/cloud/services/x`, the Admin's treg relay; the client calls `<OMB_CLOUD_X_URL>/call/<endpoint>` for the X tools' eight endpoints, `/research/search`, `/research/endpoints/<id>` and `/research/call/<id>` for the research tools, and `GET /usage` for the month's calls on the Apps page's X card (`GET /api/x/status`). A person's own treg key (Settings → API keys) wins over it and goes straight to treg. |
| `OMB_CLOUD_X_TOKEN` | secret | This machine's X research relay token (`omb_x_…`). Not a treg key; it works only through the relay, within the plan's monthly X research calls. A signed-in desktop gets its own (`omb_xd_…`) from `POST /api/cloud/desktop/services/x` and hands it to its server in memory. |

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
  accounts, so an own key goes only to the provider (`OMB_BOAT_API`,
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
  only the person's own Jev key until the relay accepts it too. The relay
  speaks Jev's API only: included decisions are Jev's, and with OpenRouter
  selected in **Settings → Decision model** nothing is included (it needs an
  OpenRouter key: one saved there, or the one under **Settings → API keys**).
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
- An included cloud computer goes to sleep through the relay's `POST
  /boxes/{id}/stop` after 10 idle minutes, as one on a person's own key does
  at Boat; a refused stop is retried later, a longer wait each time. A
  computer stays on when a routine that uses it runs within the next 30
  minutes, since every wake counts against the Boat account's shared starts.
- A refusal from the decision relay (401 for an unknown token, 402 without an
  active subscription, 429 over the month's cap or a rate limit, 502 or 503
  upstream) never reaches a turn: as with any decision-model failure, the room
  does what it would without it (its lead answers). Only **Test** shows it,
  as a fixed sentence.

### Included connected apps

Connected apps (Gmail, Outlook, Slack, LinkedIn, Calendly and the rest of the
catalog) come with the plan through OpenMausBot's managed connection service,
the same one the packaged desktop app uses. The Admin sets nothing for it: at
every start the server registers the Cloud's own installation if it has none,
keeps the token owner-only in `/data/.openmausbot/connected-apps-installation.json`
(never in a backup, a move or `config.json`), checks it with the service, and
retries with backoff while the service is down, without holding up the start.
An owner's own Composio project key still wins. The details are in
[composio.md](composio.md#mausbot-cloud). `OMB_COMPOSIO_BROKER_URL` (env, not
secret, optional) points a Cloud at another service, such as a staging one.

For a paid plan the Admin also sets `OMB_CLOUD_CONNECTED_APPS_GRANT` (secret):
a grant it signs for the machine id, which the server presents to the service
once it holds its token. The service then gives this installation a paid
Cloud's app-event limit (2,000 a day instead of a desktop's 500). Without it a
Cloud gets the desktop limit. The grant's format is in
[the broker's README](../cloudflare/composio-broker/README.md#paid-clouds).

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
  relay lists, the default first (the Admin lists Sonnet first, Haiku after;
  OpenRouter's `provider/model` ids too). Never Claude Code and never Codex: the
  platform's key is never used to run another product's agent for anyone, and
  no `ANTHROPIC_*` variable or Claude config folder ever holds the token. It
  is never saved to `config.json` and has no sign-in. The token is held like
  the included tokens (pipe, memory, the credential lists) and reaches only
  the relay; it is never shown, saved or logged. The address must be HTTPS and
  the token the Admin's shape, or there is no credit.
- **Out of the box.** A new Cloud's first bot runs on it when nothing of the
  person's own can run there (the first start waits up to 15 seconds for the
  relay's model list), so My Cloud opens on the chat, not the engine sign-in.
  A bot runs on the credit's default model unless the person picks another;
  when the relay's default changes (Haiku to Sonnet), bots still on the old
  default follow it.
- **Every bot runs.** While nothing of the person's own is signed in, a bot on
  an engine My Cloud can't run (a desktop copy's own Claude or Codex, signed
  out here, or an engine only that desktop has) moves onto the credit when the
  engines are read: at start, when the credit's list arrives, when the app
  reads the engines, and before a message to that bot is sent. Where it came
  from is kept in `providers/trial-credit/moved.json` (it never travels in a
  backup or a move). An engine whose sign-in can't be read yet is left alone
  (`server/cloud-credit-moves.ts`).
- **Their own always wins.** A new bot gets the person's own engine whenever
  one can run. From the moment one is signed in for sure (a sign-in, a key),
  each bot and conversation still on the credit moves to it, with one line in
  each, and the credit is not offered to bots any more. A bot that came from
  another engine goes back to that engine and model when it is the one signed
  in; otherwise it takes the new-bot default among the person's own.
- **Checked once connected.** Right after an engine is connected in the
  welcome's **Connect your AI** step or the engine sign-in, the app sends it
  one tiny real message (`POST /api/instances/:id/check`) and says
  **Claude is working** or what to fix (sign in again, the provider's own
  refusal in plain words), with **Test again**. No step is added; an engine
  already connected is not checked again.
- **Used up or gone.** The relay's refusal reads as one plain sentence that
  names the next step, never the API's JSON (`server/trial-credit.ts`), told
  apart by the relay's own error `code`, which it puts first in its error
  object (the chat engine keeps only the start of an error body): `402`
  `trial_credit_used_up` is used up, `402` `trial_credit_ended` or `401`
  `invalid_api_key` (a token it no longer knows) is no longer on this Cloud.
  The engine then stops offering itself until another token arrives (kept
  across restarts), and with no AI of their own My Cloud opens on its engine
  sign-in, saying why. In a chat, used up or gone is a quiet note with
  **Connect your own AI**, never an error. A `401`, `402` or `403` without the relay's code (a
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

## Health: the Admin's signed read

`GET https://<app>.fly.dev/api/cloud/health?after=<cursor>`, signed like
pairing, with `canonical`

```text
v1\n<timestamp>\n<nonce>\nGET\n/api/cloud/health?after=<cursor>\n<base64url SHA-256 of the empty body>
```

The path and query are signed exactly as sent (`cloudRequestSignature` in
`server/cloud-home.ts`; the same function signs pairing, with `POST` and
`/api/cloud/pairing`). The Admin polls each Ready home every 5 minutes and
passes the `cursor` of its last answer, so it gets only what changed. A
cursor from another boot, or none (`after=0`), reads everything since this
boot. Answered before the session gate, with its own nonces: a bad health
signature never counts toward the pairing lockout. `401` (`invalid_signature`,
`stale_request`, `replayed_request`), `503` (`busy`) and `405` as for pairing.

`200` (`server/cloud-health.ts`, at most 64 KB; incidents that do not fit
wait for the next read, `truncated: true`):

```json
{
  "v": 1, "version": "0.1.110", "image": "registry.fly.io/…@sha256:…", "bootedAt": 1790000000000, "at": 1790000300000,
  "cursor": "1790000000000.12", "truncated": false,
  "incidents": [{ "kind": "turn", "code": "rpc_error", "engine": "codex", "count": 3, "firstAt": 1790000100000, "lastAt": 1790000290000,
    "botId": "<uuid>", "threadId": "<uuid>", "seq": 12 }],
  "turns": { "started15m": 6, "failed15m": 3, "started24h": 40, "failed24h": 5 },
  "routines": [{ "routineId": "<uuid>", "status": "failed", "at": 1790000200000, "consecutiveFailures": 2 }],
  "engines": [{ "kind": "codex", "used": true, "available": true, "authenticated": false, "version": "0.130.0" }],
  "connectors": { "checkedAt": 1790000000000, "failed": false, "items": [{ "slug": "gmail", "connected": false }] },
  "browser": { "available": true, "installing": false, "interrupted": 0 },
  "system": { "totalBytes": 4294967296, "availableBytes": 2147483648, "rssBytes": 314572800, "load1": 0.4, "cpus": 2,
    "disk": { "totalBytes": 10737418240, "freeBytes": 8589934592 }, "eventLogWritable": true }
}
```

**Incidents** come from one tap on the store: every failed-turn row
(`shared/failed-turn.ts`, the only way a server writes one) is counted in a
bucket by `kind` (`place` when the row names a place, else `turn`), `code`
and `engine`, with counts since boot, first and last time, the last bot and
thread ids, and a sequence number the cursor follows; at most 200 buckets,
the one quiet longest dropped first. The code is the first that applies: the
place's state (`shared/place-view.ts`); a cause the server words itself
(`stalled`, `restart`, `could_not_start`, `incident_undelivered`,
`approval_undelivered`, `event_log`); the trial credit's refusal
(`trial_used_up`, …); the turn's stop reason when it says more than "failed"
(`auth_required`, `shutdown_timeout`, `provider_safety`, `update_required`,
`spawn_error`, `quota`); the cause's class (`server/drivers/retry.ts`:
`auth`, `quota`, `rate_limited`, …); the generic stop reason (`rpc_error`);
else `unknown`. A turn that ends in `shutdown_timeout`, `auth_required`,
`update_required`, `spawn_error` or `rpc_error` without a failed row of its own
counts once too. `turns` counts turns started and failed rows per minute;
`routines` keeps each routine's last outcome and its failures in a row.

**What it never carries:** a failure's words, a bot's name, a thread's title,
a prompt, a URL, an email address, a token, or an engine's account
(`ProviderSnapshot.account`). Only fixed codes, counts, times, versions, engine
kinds, random ids, connector slugs, booleans and machine numbers. Connected
apps are looked up in the background at most every 30 minutes, so a slow
provider never holds the answer. `connectors.items` lists only apps the
person set up: connected now, or connected once and since expired or failed.
An app never connected, HighLevel without a saved connection included, is not
listed. Cloud computers are not listed: through the
Admin's Boat relay that would count as using an included service and hold back
updates; a cloud computer that fails a turn arrives as its place's code
(`cc-unavailable`, `cc-no-start`, `cc-provider`, …).

A home from before this answers `404`; the Admin then reads `/api/health`
and shows its health as Unknown.

## Sleeping homes: the power read and the sleep handshake

A plan may let its home **sleep when idle**: the Admin suspends the machine
(Fly keeps its memory, and the first request wakes it in under a second;
measured 0.72 s) or, when Fly can't suspend it, stops it (about 20 s to wake).
The home never stops itself. On every plan that doesn't sleep the Admin never
calls these routes, and nothing below changes how a home behaves.

**What idle means (`server/cloud-power.ts`).** All of:

- no turn running (bots, rooms, delegated work), no routine run queued to start
  now or running (one waiting on a person doesn't count: their answer wakes
  the home), no Live call, no cloud computer on or starting (its idle timer
  lives in this process), no maintenance (backup or restore, Move to Cloud, an
  engine or browser install, a provider sign-in) and no request in progress;
- nobody used the home for 10 minutes (the Admin may ask for another window).
  A use is an authenticated request, except the event stream, `/api/health`,
  `/api/sync/…`, `/api/shared-computers/…` and requests the page marks
  `x-omb-background: 1` (its own polls). A request with no mark counts, so an
  older client can only keep a home awake, never let it sleep under someone;
- work ended 2 minutes ago, the home has been awake 2 minutes, and the next
  scheduled run is at least 5 minutes away.

**`GET /api/cloud/power[?idleMinutes=N]`**, signed like the health read
(`v1\n<timestamp>\n<nonce>\nGET\n<path and query>\n<hash of the empty body>`),
its own nonces. `200`:

```json
{ "v": 1, "at": 1792355000000, "bootedAt": 1792350000000, "wokeAt": 1792354000000,
  "idle": false, "busy": ["recent-activity"], "lastActivityAt": 1792354900000, "lastWorkAt": null,
  "nextDueAt": 1792358600000, "sleeping": false }
```

`busy` holds fixed codes only: `turn`, `run`, `live-call`, `computer`,
`maintenance`, `recent-activity`, `recent-work`, `just-woke`, `due-soon`.
`nextDueAt` is the earliest enabled routine's next run or queued run's retry:
the Admin starts a sleeping home a minute before it. `wokeAt` is the boot, or
the last resume (noticed as a jump of the clock).

**`POST /api/cloud/power/sleep`**, signed over its JSON body
`{"v":1,"idleMinutes":10}`. `409 {"ok":false,"busy":[…]}` while not idle;
`200 {"ok":true,"nextDueAt":…}` once the home agreed. From then on, until a
resume, someone's use, or 120 s (a sleep the Admin never carried out):

- the event stream gets `{"kind":"power","state":"sleeping"}`. The page closes
  its stream, stops its polls, shows "My Cloud is asleep" and stays quiet until
  the person clicks, types or focuses it, which wakes the home
  (`src/lib/cloud-power.ts`): Fly wakes a machine for **any** inbound request,
  so a page that kept polling would keep it awake. The frame is live only: a
  stream that resumes from before it never gets it again. The wake is one
  ordinary request (`GET /api/auth/session`), so it also ends a sleep the
  Admin has not carried out yet;
- held `GET /api/sync/changes` and `POST /api/shared-computers/<id>/poll`
  answer `503 {"error":"asleep"}` with `x-omb-cloud-power: asleep`, and new
  ones get the same, so the desktop's Files sync and lending pause instead of
  waking it;
- `cloud-sleep.json` in the data folder marks the sleep. A boot that finds it
  (the machine was stopped, not suspended) is a wake, not a startup: "run on
  startup" routines don't fire. Any other boot removes nothing and runs them as
  before.

**The edge on a cold wake.** `OMB_CLOUD_EDGE_HOLD` (whole seconds, at most
120, such as `30s`; unset: `0s`, today's edge) makes Caddy hold a request while
the server starts instead of answering 502, so a webhook or the app's first
request after a stop is answered late rather than refused; Caddy dials the
server again every 50 ms, so a held request reaches it within 50 ms of its
listening. The Admin sets it only for a plan that sleeps.

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
- `cloud.unreachable: {cause, since}` while `ready`: the Admin's health checks
  can't reach the Cloud. `cause` is `host` (the server it runs on is being
  restarted by the hosting provider; it comes back by itself) or `no_answer`
  (it missed three checks in a row); `since` (ms) is its first missed check.
  While it is there, Settings says why in place of "My Cloud is ready" and
  hides Open My Cloud, the Cloud link opens nothing, and a connection that fails
  says the same sentence (read from the session again just after the failure)
  instead of "Cloud request failed".
- `cloud.disk: {gb, maxGb}`: the volume now and the most the plan lets it grow
  to. Only with it does a copy to the Cloud count on a larger disk (and ask the
  Admin to grow it, below). Without it the app assumes nothing: a copy is measured
  against the Cloud's free space today, and one larger than the Cloud's whole
  disk says "tell us and we'll make room", never "remove files" or "try again".
  The Admin should send it together with `POST /api/cloud/desktop/disk`.
- `cloud.purchase: {state: "confirming" | "held", plan, paidAt}`: a payment
  received but not yet linked to this account. While it is there, the app shows
  "payment received" and offers nothing to buy. It never activates anything.
- `cloud.trial: {state, tier, endsAt, amount, chargeAt, holdUntil, deleteAt, keep, switchTo?, personalAmount?}`:
  a free trial on this account's Cloud (`electron/cloud-home.mjs`
  `parseCloudTrial`). `state` is `active`, `ending` (renewal off, or cancelled),
  `processing` (the first charge is being taken), `late` or `ended`; `endsAt`
  is when the first charge is due, `amount` that charge before tax in US cents,
  `deleteAt` when the Cloud's files are deleted if nobody subscribes, and
  `keep` what keeps the Cloud on the Cloud page: `portal` (turn renewal back
  on; for `ending`, renewal is off), `checkout` (subscribe again once ended),
  or `none` (nothing: renewing, or, for `ending`, cancelled outright).
  `switchTo: {tier, amount}` is the plan this trial can switch to from its
  Plan page and that plan's price before tax in US cents, sent only while a
  switch is the way down (`{tier: "starter", amount: 1500}` for a Pro or Max
  trial), so the way down reads the same on every page of the app. `tier` is
  one the app knows by name (`starter`, `personal`, `pro`, `max`) and `amount`
  a whole, positive number of cents; anything else drops `switchTo`.
  `personalAmount` is Personal's price in US cents, the only way down an older
  Admin names: with no `switchTo`, the app reads it as `switchTo: {tier:
  "personal", amount}`. An Admin that still sells Personal sends both. With
  neither, the trial says nothing about switching. An unknown state is no
  trial; a malformed date or amount is left out. It is display only: the
  entitlement still decides everything.
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
date, the price after it and how to cancel; in its last two days, while the
Admin names a cheaper plan to switch to, also how to step down to it, with
its price, and nothing about switching when it names none), **Subscribe to keep it** (ending with renewal off, `keep`
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

`components/AppNotices.tsx` is the one place for the Cloud Pro popup and the
cards at the bottom left (`lib/notices.ts`), asked in order, one on screen at a
time, and none after one closes until another launch:

1. **The Cloud Pro popup** (`CloudProPopup`, id `cloud-pro-update-2026-10`):
   one centered dialog, once per installed desktop app whatever its plan (a
   new install once its onboarding is done), on whichever page its window
   shows: this computer's, My Cloud's or another saved server's. A server's
   page shows it only once that server runs this version (My Cloud once the
   Cloud is updated), so a window that only ever shows a server on an older
   version does not get it. It does not wait for This computer's first-run
   welcome there: a window that opens on My Cloud or a saved server may
   never load This computer's page, and an install from before the welcome
   kept a record has no record of finishing it, so waiting would leave those
   desktops without the popup. Showing it never switches the window. Main keeps whether this desktop has seen it
   (`electron/desktop-prefs.mjs`, a small file in the app's data folder,
   written to a temporary file and renamed over the old one, so a failed
   write keeps the last record), and every page and every port the app's own
   page is served on agree. This computer's workspace record counts as seen
   on every page, before its page has loaded on this build (main reads
   `config.json` in its data folder): a close kept there earlier, or the
   welcome's MausBot Cloud step, which also keeps the
   card after the update away; a close kept only in this computer's page's
   storage counts once that page has loaded, and is handed to main. The
   welcome leaves its MausBot Cloud step out once main says this desktop has
   seen the popup. Never in a window connected to another
   computer as its remote client, which has no Cloud sign-in, Add a Cloud
   dialog or Settings → MausBot Cloud to send anyone to, nor on a branded
   build, which sells no Cloud. It waits while main, the plan or the Admin's
   offer is loading; while another dialog (modal or not, the tour's
   spotlight included), My Cloud's setup checklist or the card saying the
   Cloud is set up, or a call is open; and, when the Cloud can't be reached,
   for a later launch. Nothing in it opens a checkout or the browser:
   - **On this computer's page**, with no plan, **Start free trial** (while
     the Admin offers one) or **Upgrade to Cloud Pro** opens the Add a Cloud
     dialog (source `update_popup`), and so does **Compare plans** (the dialog
     lists every plan); on any plan (a trial, Starter, Personal, Pro, Max or
     one that needs attention) **Manage plan** opens Settings → MausBot Cloud, and
     there is no Compare plans. Personal → Pro is not self-serve yet, so
     Personal gets Manage plan rather than an Upgrade that would end at
     "write to us". Its numbers are the Admin's.
   - **On My Cloud's page**, from the plan main tells that page
     (`cloud-plan:state`, asked once main has restored the Cloud sign-in), a
     plan, payment trouble or an ended sign-in gets **Manage plan**. It
     switches the window to This computer, whose page opens at Settings →
     MausBot Cloud (where an ended sign-in can sign in again). A plan still
     being checked waits for a later launch; with none read, it is as on
     another server.
   - **On another saved server's page**, which is told nothing about the
     plan, it shows no plan, price or Compare plans: **Continue on this
     computer** switches the window to This computer, whose page finishes
     the click from the plan it knows itself, without showing the popup a
     second time. Someone who can buy (signed out, or signed in with no
     plan) gets the Add a Cloud dialog (source `update_popup`), which loads
     the Admin's offer itself; a plan, payment trouble, a payment being
     linked or an ended sign-in gets Settings → MausBot Cloud. A sign-in
     still restoring or connecting, or a plan This computer cannot check
     right now, is waited on for ten seconds at most, then it is Settings →
     MausBot Cloud, which says where it stands.

   Main makes either switch only for a popup this desktop has not seen, and
   only when the page asks right after
   a click or a key press on it (the preload checks
   `navigator.userActivation`). It loads This computer's page on the click
   (`?desktop-settings=cloud-settings` for Manage plan, `cloud-add` for
   Continue on this computer, with `source=update_popup` and the page clicked,
   `via=my_cloud` or `server`) and records the popup as seen once that page
   has loaded. The preload and main refuse anything else: `cloud-pro`
   (Continue on this computer) from My Cloud's or another saved server's
   page, and `manage` (Manage plan) only from My Cloud's own page, as main
   verifies it. This computer's page opens it at once, whatever else is
   going on there (a bot at work, an update), and shows no card in the
   corner for the rest of that page load. So another server's page can
   bring the window to This computer and have that page do what its own
   popup's main button would, but it cannot choose what opens there; like any
   page of the window, it can close the popup for this desktop. While main
   switches, the main button is held; a switch main cannot make (This
   computer's server is not ready, another switch is under way, or the
   switch fails) keeps the popup up with a line saying so and the button to
   try again, and leaves the popup for a later launch, as does a page that
   does not load.

   Any button, its X, Escape or a click outside end it for good; until then
   it comes back on a later launch. It takes focus at its title, keeps Tab
   inside, takes Escape only while focus is in it, and gives focus back when
   it closes unless focus has moved on. `cloud_pro_popup`
   ([docs/analytics.md](analytics.md)) counts it as shown at most once a day
   on a desktop, however often it comes back, and names the page each event
   is counted on. Only `upgrade`, `manage` and `see_plans` by someone signed
   in to MausBot Cloud first tie their analytics to their Cloud account's
   email, and only on this computer's page, where the app knows the email;
   My Cloud's Manage plan and a server page's Continue on this computer are
   counted on that page as `continue`, and what they open on this
   computer's page is counted there with the page they came from. While the
   app has kept no analytics choice of its own yet and serves its page on a
   port other than its first, such a click is counted without the email,
   because an opt-out made before may be kept in the first port's storage.
2. **The card after the update** (`CloudTrialIntro`, id `cloud-trial-intro-v1`):
   MausBot Cloud's free trial for someone signed out or with no plan who
   has used the app before this launch, only while the Admin offers a trial
   (it waits for one), and never on a desktop whose first-run welcome
   showed its MausBot Cloud step. Its numbers are the Admin's: the trial's
   days, the lowest monthly price, the Claude credit and money-back. At most
   once a calendar day, on at most three days (one for someone who closed the
   earlier Pro card), kept in browser storage and the workspace's hint record;
   any button, its X or Escape end it for good. **Start free trial** opens the
   Add a Cloud dialog, **Show me how** lights the server menu (below), **Sign
   in to your Cloud plan** (signed out) only hides it for now. Never on a
   branded build or a desktop signed in with an organization.
3. **The free trial's notice** (above), on this computer's page and on My
   Cloud's own page (its only entry there, after its engine sign-in and setup
   checklist).
4. **This computer's My Cloud card** (`CloudNotice`): a ready My Cloud for
   someone with a plan, or **Sign in again** where the sign-in ended (Not now
   kept per card).
5. **Star us on GitHub**, asked once.

None of them shows over setup (the welcome flow, the tour, and on My Cloud its
engine sign-in and its setup checklist until that is done or hidden), a dialog,
Settings, the Add a Cloud dialog or its tip, busy work, or an update being
offered; no card in the corner takes focus, and each is announced once to a
screen reader.

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
The Cloud Pro popup gives a plan, payment trouble and a payment being linked
**Manage plan**; of the states it cannot verify, it waits while the sign-in is
still restoring or connecting, waits for a later launch while the check is
`unavailable`, and gives Manage plan to an ended sign-in (`reauth-required`)
and to one the app could not read and removed (`restore-removed`): Settings →
MausBot Cloud asks both to sign in again.

In the Server menu, **My Cloud** goes through the same connection as
**Open My Cloud** (no pairing code to type); when it cannot, the app
opens **Settings → MausBot Cloud**, which says the next step. In the desktop app a
`/pair#code=` link connects without a second click; a browser still asks. On a
Cloud home the pairing page says where its connection starts (the environment
descriptor's `capabilities.cloudHome`).

On the person's own Cloud, open in the app's window, **Settings → MausBot Cloud**
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

### A Cloud that sleeps: what the desktop does

A plan may let My Cloud sleep when idle (the Admin suspends its machine; Fly starts it again for **any** request through
its proxy). The session's `cloud.power` (additive, only for such a plan) says `{state: "awake"|"asleep"|"waking", since,
sleeps: true}`; `cloud.state` stays `ready`. Without `cloud.power`, nothing below happens (`electron/cloud-power.mjs`).

- **Files sync and lending pause** while the session says `asleep`, and also at once when My Cloud answers a held poll
  `503` with `x-omb-cloud-power: asleep` (it does just before it sleeps). They make no request to My Cloud then, not even
  a retry, and the session is read every 15 s instead of 60 s while they wait. They resume when it says awake. Files and
  lending show "My Cloud is asleep" meanwhile.
- **Opening My Cloud while it sleeps** asks the Admin to wake it first (`POST /api/cloud/desktop/wake`), shows "Waking
  your Cloud…" after 1.5 s, and gives its sign-in check 30 s instead of 5 (a stopped machine takes about 20 s), so a slow
  wake never causes a needless new pairing.
- **Copy:** the menu and the server switcher say "Sleeps when idle" instead of "Always on" for such a Cloud; the buy sheet
  shows the line for a plan whose allowances say `sleeps`.
- **App events:** the connected-apps broker asks the Admin to wake a Cloud when it queues an event for one that isn't
  polling (`cloudflare/composio-broker`, off until `CLOUD_ADMIN_URL` and `CLOUD_GRANT_SECRET` are set).

### Usage meter: how close the plan is to its limits, and Upgrade

The session's `cloud.usage` (additive; the Admin's `server/cloud-usage.ts`) says, for an active plan whose Cloud is
ready: the plan (`tier`), when the monthly allowances start over (`resetsAt`, the first of next month UTC; `trialEndsAt`
during a free trial), each included allowance as `{kind, used, max, usedUp?}` (`computerHours` in hours, `voice` in
characters, `decisions`, `x` in calls, `research` in dollars, `storage` in GB of the most the disk grows to), and the bigger
plans the app can move to itself (`upgrades: [{tier, amount}]`, US cents a month; empty on Max, a team's plan, or while
the Admin's `OMB_CLOUD_APP_UPGRADES` is off). `electron/cloud-home.mjs` `parseCloudUsage` drops anything malformed (an
unknown kind, an allowance of nothing, a plan it doesn't know); it is display only and never grants or limits anything.
Main keeps it on the account's state, and `cloudPlanSnapshot` hands it to this computer's page and the person's own Cloud
page alike (`ogb.cloudPlan`), so the meter reads the same on both (`src/components/CloudUsageMeter.tsx`,
`src/lib/usage-meter.ts`).

- **The sidebar card**, above the person's name (not in the icon rail), only while an allowance is at 80% or more: the
  one or two fullest, used of included with a bar (amber from 80%, red at 100%), when they start over, **Upgrade to
  <next plan>**, and **See all usage** (Settings → General). **Hide for now** keeps it hidden on this computer for this
  month at this level: it comes back when one reaches 100%, and next month. Never shown in a browser, without a paid plan,
  or on a Team Cloud unless the plan whose usage it is is that team's (only the person who pays for a team sees its usage;
  its members never do).
- **Settings → General → MausBot Cloud usage**, while there is a paid plan: every allowance with its meter, when they
  start over, and Upgrade to the next plan (the others as links), "You're on the top plan" on Max, or "To change your
  team's plan, write to us" on a team's plan.
- **Upgrade, one tap and a confirm.** Upgrade asks main for a preview (`ogb.cloudPlan.upgradePreview(plan, source)`,
  only from a click, only for a plan the verified session lists), which asks the Admin
  (`POST /api/cloud/desktop/upgrade/preview`): Dodo's own numbers for this change, nothing changed. The confirm says them
  in plain words: "Max is $99 a month and starts right away. Today you pay $23.40, the difference for the rest of this
  billing month. From Nov 18 it's $99 a month, plus any tax." (a free trial: nothing today, the new price at its first
  payment). The preview's confirmation stays in main, never in a page. Only the confirm's own **Upgrade to Max**
  (`ogb.cloudPlan.upgrade(plan, source)`, which needs a click) sends `POST /api/cloud/desktop/upgrade` with it; without a
  preview of that very plan, still good (ten minutes), main sends nothing. The Admin changes the plan in Dodo (the prorated
  difference now, the billing date kept; `on_payment_failure: prevent_change`), refuses if Dodo would now charge more than
  the confirm said, and reads the plan back, so the session (read again at once) shows the new plan and allowances. Plain
  lines for what happened: on the new plan; still going through; the card was declined, nothing changed; the price
  changed, nothing charged; couldn't, nothing charged. Where the Admin can't change plans from the app (off, or an older
  Admin), Upgrade opens the Cloud page instead. Funnel source `app_usage` (the card) or `app_settings`.

## Add a Cloud

The one way to buy MausBot Cloud in the app, the same for every way in:
the Cloud Pro popup, the card after the update, **Show me how**, **Add a
Cloud…** in the server menu (the sidebar's and the menu bar's Server menu),
Settings (the Cloud card in General, and MausBot Cloud), and the routine
screen's note.

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
  (one card per plan the Admin sells, side by side on a wide sheet and
  stacked in a narrow window, from `lib/cloud-plan` `planCards`: its name,
  "Most popular" on the Admin's recommended plan only, the price per month,
  its promise, its own button (Start free trial, or Get {plan} without a
  trial) with its terms in one line under it, then the same rows in the same
  order on every card in the website's words (with the app's "cloud
  desktop" for the website's "cloud computer"), every number from the
  Admin's `allowances`: always on (or sleeping), cloud desktops as many as
  the bots need (how many at once only as small print), the month's hours,
  CPUs and memory (swap as small print), storage and what it grows to,
  voice, and daily backups' days. The card of the plan the account already
  has says **Your plan** instead of a button (`current`, from the verified
  entitlement's tier); a plan no longer on sale, such as a Personal
  subscriber's, shows only for that subscriber when the screen is given it
  (`own`). Under the cards, when every plan has the same trial, the trial's
  timeline with the reminder line only while the Admin sends one, and the
  Claude credit; money-back; prices plus tax. No launch or struck-through
  price: the Admin's `regularAmount` is not read), the sign-in (its last step
  names the checkout only when the sign-in is on the way to one), the next
  step in the browser (the checkout open there, or, signed in on the way to
  one, the Admin's page after approval, which leads to it), the payment
  received, My Cloud starting, and My Cloud ready (**Open My Cloud**; never
  for someone who already had My Cloud before this sign-in). When a step
  ended without going on (the sign-in code expired or the sign-in ended, a
  checkout already being prepared), the offer says why. A screen reader
  hears each card's button with its plan's name, and each new step takes
  focus at its heading. A payment problem, an ended sign-in or a Cloud that can't
  be reached go to Settings → MausBot Cloud instead.
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
  (`{tier, label, price: {currency: "USD", amount, interval: "month"}, allowances?, trialDays?}`;
  a `personal` entry, which an older Admin may still list, is left out here, so it is never listed, marked Most popular or
  checked out, a `recommended: "personal"` falls back to Pro (else the first plan left), and a `checkout` of it is not
  watched; Personal subscribers keep their plan and see it named Personal;
  `allowances` may carry `cpuKind`, `swapMb` and `snapshotDays`, each said only when present and valid):
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
  `app_routines`, `update_popup` (main refuses any other, and any plan the
  offer doesn't sell).
- **Interest** `POST /api/cloud/desktop/interest` `{kind: "another_cloud"}` → `{ok: true}`.
- Every signed-in request carries this app's version in `x-openmausbot-version`.

Nothing in the app is a price: with the Admin's trial switch off, no card is
shown, and the dialog offers today's plans at the Admin's prices, charged
today. Analytics (the app's existing, optional PostHog) register `app_version`
and `surface` (`local` or `server`) on every event, and count the card, its
actions, the tip, the dialog's views and checkouts opened, with no content.
[docs/analytics.md](analytics.md) lists every event and property.

## This computer's bots move to your Cloud

Once the Cloud is ready (and the Admin's `moves` switch lets this account
move), the desktop app moves everything from this computer to it, once, by
itself, and from then on opens the Cloud as its only home
(`electron/one-home.mjs`, `electron/home-window.mjs`). The move carries each
thing by id over one owner session (`electron/cloud-send.mjs`), checks that it
all arrived, and freezes this computer's copy so nothing runs in two places
(`server/move-freeze.ts`). An older desktop's Copy this computer here gets
`410` with "Update OpenMausBot to bring your bots here by itself."
(`server/cloud-move-http.ts`); a backup file still restores from Settings →
Backups. [docs/verification/cloud-send.md](verification/cloud-send.md) has the
tests.

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
  scopes the person chose, which the Mac itself enforces (see "Use my Mac: Let my bots use
  this Mac").

## Published image

Every push to `main` and every release tag publishes the home machine image as
`ghcr.io/milind-soni/openmausbot-cloud-home`, tagged `latest` (main only), `sha-<commit>` and the release tag.
It is the `Dockerfile`'s `cloud-home` target for the same commit, with Grok and the current Claude Code and
Codex installed. The Docker workflow's summary prints the digest. Set it in the Admin as
`OMB_CLOUD_HOME_IMAGE=ghcr.io/milind-soni/openmausbot-cloud-home@sha256:…`; changing it rolls the new image
out to existing machines one at a time, reverting automatically on a failed health check.
