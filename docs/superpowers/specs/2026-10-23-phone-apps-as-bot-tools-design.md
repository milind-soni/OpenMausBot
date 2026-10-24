# Phone apps as MausBot's hands

Status: design, 2026-10-23. Decisions taken by Omkar the same day: wire it in
first, refine what MausBot watches after real use; grant everything the OS
allows on each platform in the first cut; both iPhone and Android; the
proactive main bot is the bot it is built for; phone apps replace connectors
wherever the phone has the data.

**Open with Omkar (2026-10-23):** which proactive bot. OpenMausBot #3287 (the
built-in MausBot assistant with the daily brief; phones mausbot-mobile #37) was
CLOSED unmerged on 2026-10-22, and Milind's #3314 ("proactive routines, the
Chief keeps an eye on your day") merged the same day. On main the proactive
bot is the Chief of Staff with a routine, "Keep an eye on my day", that runs
checks (`calendar | mail | runs`) every 15 minutes through
`server/connected-reads.ts` with no AI. This document is written against main.
If #3287 is revived instead, "the Chief" below reads "MausBot" and section 6
targets `assistant-sources.ts` / `assistant-watch.ts` with the same additions.

Reference: Grok Bot's 2026-10-23 release ("Grok Bot can now use Calendar,
Reminders, Contacts, and more apps on your phone"), a per-app sheet with an
Allow button for Messages, Location, Calendar, Home, Reminders and Contacts,
while the bot itself keeps running on its cloud computer.

## What this is

Today a bot reaches a person's calendar, contacts or messages only through a
cloud connector (Composio, HighLevel) or through a Mac helper. The phone apps
only show what the bots do.

With this design the phone becomes a tool provider. The bot keeps running
where it runs today, on the Mac or on a Cloud home. The phone registers the
apps the person has allowed, the bot gets one tool per allowed capability,
every call is shipped to that phone, runs there against the operating
system's own framework with the permission the person granted, and the
result comes back as the tool's output. No account is connected, no token is
stored anywhere, and nothing leaves the phone except the answer to that one
request.

Two uses, same plumbing:

- **Asked.** "Remind me to call Priya at 4", "text Rahul the address", "put
  lunch with Jake on Thursday", "who is free this afternoon", "lock the
  door". The bot calls a phone tool; sends need a tap.
- **Pocket mode.** The Chief's "Keep an eye on my day" routine runs on a
  Cloud home around the clock, watches mail and the calendar, and reaches
  the phone briefly when it needs to read the day, write a reminder or look
  up a contact. On Android the phone
  stays connected; on iPhone a silent push wakes the app for one job.

The companion mode (Mac plus phone) gets the same tools because the code
is shared. Pocket mode needs a Cloud plan because the bot has to be awake
when the phone is not; that is the gate, enforced by the Cloud itself and
by the push relay, never by a desktop-only check ([pro-gating rule]).

## Decisions (Omkar, 2026-10-23)

1. Get the wiring in; the watching rules come after data arrives.
2. First cut asks for every permission the platform allows. Refinement later.
3. Both phones. (Earlier standalone-Cloud work went iPhone first; here the
   server plumbing lands once and each phone pack follows; see Delivery.)
4. The proactive main bot is the bot this is for (see the open point above:
   the Chief on main, or MausBot if #3287 is revived). Other bots can be
   granted the same tools per bot.
5. Prefer the phone's apps over connectors wherever the phone has the data.
6. Initial watch sources, once wired: email, calendar invites, selected
   WhatsApp groups, selected iMessages. See "Platform limits" for what each
   platform can actually give.

## Goals, non-goals, anti-goals

**Goals**

- A bot can read and write Calendar, Reminders and Contacts, read Location,
  control Home, and send Messages on the person's phone, with one permission
  sheet in the app.
- Works in both modes a phone has today: paired with a desktop through the
  companion sidecar, and paired directly with a Cloud home.
- The proactive routine's checks can read the phone's calendar as a source
  next to Google Calendar, and on Android can receive messages from chosen
  WhatsApp groups.
- Every write is visible in the chat as an activity row; every send is held
  by the existing "Send on your behalf?" card.

**Non-goals (this design)**

- Reading WhatsApp or iMessage history. No API exists.
- Reading iMessage at all. Only a Mac can; a Mac-side connector is a separate
  decision Omkar said no to on 2026-10-16.
- Health data (ruled out 2026-10-16).
- Home control on Android (Google Home APIs need Google's approval; a
  follow-up).
- Continuous background location on either platform (Play and App Review
  both treat it as a special case; a follow-up if a real use appears).
- A phone acting as a bot's computer (screen control). That is the USB
  Android harness and PocketCtrl territory, not this.

**Anti-goals (a failure even if it works)**

- Any phone data reaching Supamaus's control plane or the Admin. Phone data
  goes only to the person's own harness (their Mac or their Cloud home), and
  there only as a tool result in the transcript or as the two bounded stores
  in section 6 (the last calendar read, the last 200 captured messages).
- A message sent without the person's tap.
- A capability the person did not allow showing up as a tool.
- A permission prompt at app start. Each one is asked from the sheet, when
  the person taps Allow.
- Draining the battery: the phone never polls when nothing is queued.

## Platform limits (verified 2026-10-23)

| App | iPhone | Android |
|---|---|---|
| Calendar | EventKit, full access (iOS 17 `NSCalendarsFullAccessUsageDescription`). Read, add, move, cancel, attendees, invite status. | `CalendarContract` with `READ_CALENDAR` + `WRITE_CALENDAR`. Same operations. |
| Reminders | EventKit reminders (`NSRemindersFullAccessUsageDescription`). Lists, due dates, complete. | No system reminders API. The app keeps its own MausBot reminders list and fires them as exact alarms (`SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM`, notification channel "Reminders"). |
| Contacts | `CNContactStore` (`NSContactsUsageDescription`; iOS 18 may grant a limited set). Search, read, add, update. | `ContactsContract` with `READ_CONTACTS` + `WRITE_CONTACTS`. Same. |
| Location | CoreLocation, When In Use. One fix on request. Places nearby through MapKit `MKLocalSearch` (no key, no cost). | Fused location, `ACCESS_FINE_LOCATION` (fine and coarse both declared). One fix on request. No free places search: the tool returns coordinates and the bot uses its web search. |
| Home | HomeKit (`NSHomeKitUsageDescription` + the `com.apple.developer.homekit` entitlement). Homes, rooms, accessories, read state, set characteristics, run scenes. | Not in this design. |
| Messages, sending | `MFMessageComposeViewController`: the text and recipient are filled, the person taps Send. WhatsApp: `whatsapp://send?phone=&text=` opens the chat filled in, the person taps Send. | SMS: `ACTION_SENDTO` with `sms:` fills the Messages app; `SEND_SMS` is not requested because Play only grants it to a default SMS app. WhatsApp: the same `whatsapp://send` link. The person taps Send. |
| Messages, reading | Not possible. iOS exposes neither SMS nor iMessage nor WhatsApp to apps. | A `NotificationListenerService` sees incoming notifications. The app keeps only the apps and groups the person ticked (WhatsApp groups, SMS). New messages only, never history. Play allows it with an in-app disclosure and the Data safety form. |
| Background | No push today and no background modes. The app answers while open and during its short linger. Pocket mode needs the push branch (OpenMausBot `bringin/2788`) finished plus a silent push (`content-available`), which wakes the app for about 30 s per push. iOS also throttles silent pushes to a few per hour. | The opt-in always-on service already keeps the stream alive. Pocket mode works today once the person turns it on. FCM push is the fallback when they do not. |

Consequences the design takes on:

- "Selected iMessages" cannot be delivered on either phone. It is listed as
  out of scope above.
- "Selected WhatsApp groups" is Android only, as new-message notifications.
- Reminders on Android are the app's own list, not a system app. They still
  ring, they still show in the app, and the bot can read and complete them.
- Location answers only while the app is in the foreground or during a
  push wake. Otherwise the tool says so.

## Architecture

```
  bot engine ── MCP "device" ── harness (Mac or Cloud home)
                                   │  device registry: who is paired, what each allows
                                   │  device jobs: one queue per phone, tied to the turn
                                   │
                 companion sidecar │ (desktop) / direct session (Cloud)
                                   │
                              phone app ── Calendar · Reminders · Contacts · Location · Home · Messages
```

### 1. The device registry (harness)

The harness learns about phones for the first time. Today only the companion
sidecar counts live streams per device, on its localhost control port, and on
a Cloud home a phone is just a session.

- **Identity** is whatever authenticated the request, never the body: in
  companion mode the sidecar's device header (`companion:<registry id>`), on a
  Cloud home the session (`session:<id>`). This is the `phonePushIdentity`
  rule from the push branch, reused as `deviceIdentity`.
- **Registration.** `PUT /api/devices/self` with `{ name, platform:
  "ios"|"android", appVersion, capabilities }`. `capabilities` is the set the
  person has allowed on the phone, each with its grant level, for example
  `{ calendar: "full", reminders: "full", contacts: "limited", location:
  "when_in_use", home: "full", messages: "send", inbox: ["whatsapp:Family",
  "sms"] }`. The phone registers on every connect, on every change in the
  sheet, and on every OS permission change it notices.
- **Record.** One per identity: the registration, `seen`, `online` (a live
  events stream or a poll inside the last minute), `busy` (a job in flight),
  `lastUsedAt`. Kept in memory with a small on-disk mirror so the Cloud page
  and the Settings screen can show phones that are offline (same shape as
  `KnownLentComputer`). At most 20 per harness.
- **Listing.** `GET /api/devices` for the owner's UI (desktop Settings →
  Phones, phone Settings → This phone). On a Cloud home every device is the
  owner's; in companion mode the sidecar's allowlist opens the route.
- **Removal.** `DELETE /api/devices/self` from the phone, and from the list
  for a lost phone. Removal fails any in-flight job with "this phone's access
  changed".

### 2. Device jobs (server to phone)

The harness can only broadcast events today. Nothing is addressed to one
phone and nothing waits for a typed reply. The shared-computer lending queue
(`server/shared-computers.ts`) already solves exactly this for a lent desktop:
a registered device, a long poll, a lease before running, one result, a
server-side timeout, a re-delivery timer and binding to the live turn. Device
jobs copy that shape instead of inventing a second one.

- `GET /api/devices/self/jobs` long-polls up to 20 s and answers the next
  job `{ id, tool, arguments, expiresAt }`.
- `POST /api/devices/self/jobs/:id/lease` before running it, so a job the
  poll lost is re-delivered after 10 s instead of run twice.
- `POST /api/devices/self/jobs/:id/result` with `{ ok, result }` or
  `{ ok: false, error, code }`. Codes the bot needs to understand: `denied`
  (the OS permission was revoked), `foreground_required` (location, compose
  sheet), `not_found`, `too_large`.
- One job in flight per phone. The next waits.
- **Two job classes.** An *in-turn* job comes from a bot's tool call: it is
  bound to the turn with `active()`, a stopped turn fails it before it is
  delivered, and it times out after 45 s (reads and writes) or 120 s (a send,
  the compose sheet waits for a tap), after which the bot is told the outcome
  is unknown and must check before repeating. A *background* job comes from
  a routine's checks (section 6): it has no caller waiting, it stays queued
  until the routine's next tick (15 minutes by default) or until the phone
  answers, whichever is first, and its result is stored for the next check.
  Background jobs are reads only. In-turn jobs go first when both wait.
- **Whose phone.** A phone belongs to the harness owner. On a desktop
  harness that is the local owner; on a Cloud home it is the account that
  paired the phone. A turn or routine runs against the owner's phones only
  when it runs as the owner: a person's own message, or a routine the owner
  made. Guests, rooms, team Clouds and any turn started by someone else never
  see a phone, the same rule MausBot's visibility used.
- **Wake-ups.** The poll is the authority; two nudges make it instant. A new
  SSE frame `device.job` `{ id }` tells an app with an open stream to poll
  now. On iPhone in the background, a silent push with the same id does the
  same (sub-project D). Without either, the next poll finds it.
- **Offline.** If the phone has not been seen for a minute the bot gets, in
  one sentence, "Omkar's iPhone is offline; open the MausBot app on it", the
  same way a lent computer reports itself.
- **Results** are capped at 256 KB; the phone truncates lists and says so in
  the result (`truncated: true`) rather than failing.

### 3. The `device` MCP kind

Tools reach engines the way Browser, Cloud computer, Data and HighLevel do:
a fifth internal MCP kind `device` on `harness-mcp-proxy`, mounted into a
turn with a capability token, answering `tools/list` and `tools/call` at
`POST /api/internal/device/mcp`. HighLevel (`server/highlevel/`) is the
template: flat JSON schemas validated with ajv, `tools/list` filtered by the
per-bot verdict, `tools/call` validated, `assertActive` before and after,
decision-log rows, an activity row on every write.

The server-side `tools/call` does not run anything itself. It enqueues a
device job for the chosen phone and awaits the result.

**Which phone.** Most people have one. When the owner has several registered,
the tool catalog gains `phone` as an optional argument (`"Omkar's iPhone"`)
and the default is the phone used most recently, with the list of phones in
the tool instructions. A bot never sees phones that belong to another person
(team Cloud: none, the same as MausBot itself).

**Tool catalog.** Names follow the verb rule in `shared/outbound.ts` so the
existing classifier does the right thing without a special case: reads start
with GET/LIST/SEARCH/FIND, writes with CREATE/UPDATE/DELETE/SET/RUN, and the
two message tools start with SEND, which makes them outbound.

| Capability | Tools |
|---|---|
| calendar | `PHONE_LIST_EVENTS` (range, calendar), `PHONE_GET_EVENT`, `PHONE_FIND_FREE_TIME`, `PHONE_CREATE_EVENT` (title, start, end, all-day, location, notes, attendees by email), `PHONE_UPDATE_EVENT`, `PHONE_DELETE_EVENT`, `PHONE_RESPOND_TO_INVITE` (accept, decline, tentative) |
| reminders | `PHONE_LIST_REMINDERS` (list, due range, completed), `PHONE_CREATE_REMINDER` (title, due, notes, list), `PHONE_UPDATE_REMINDER`, `PHONE_COMPLETE_REMINDER`, `PHONE_DELETE_REMINDER` |
| contacts | `PHONE_SEARCH_CONTACTS` (name, phone, email), `PHONE_GET_CONTACT`, `PHONE_CREATE_CONTACT`, `PHONE_UPDATE_CONTACT` |
| location | `PHONE_GET_LOCATION` (one fix, accuracy, place name when known), `PHONE_FIND_PLACES_NEARBY` (iPhone only, MapKit) |
| home | `PHONE_LIST_HOME` (homes, rooms, accessories, scenes, current state), `PHONE_SET_ACCESSORY` (accessory, characteristic, value), `PHONE_RUN_SCENE` |
| messages | `PHONE_SEND_MESSAGE` (recipient as contact or number, text; SMS/iMessage), `PHONE_SEND_WHATSAPP` (same, opens WhatsApp) |

Two arguments are common to every tool: `phone` (optional) and nothing
else; time zones come from the phone's registration, dates are ISO 8601.
Every result carries `phone: { name, platform }` so the transcript says
where it ran.

**Instructions and recovery text**, in the pattern of `harness-mcp-request.ts`:
the device kind's instructions tell the bot the phone is the person's own
device, reads are free, writes show in the chat, sends open a sheet the
person taps, and an unknown outcome must be checked with the matching
`PHONE_GET_*`/`PHONE_LIST_*` before repeating.

### 4. Policy: who may do what

Three layers, all existing shapes.

1. **The phone decides what exists.** A capability not allowed on the phone
   is not in `tools/list`. The OS permission is the authority; the server
   only mirrors it.
2. **Per bot.** `bot.phoneApps` holds a grant per capability, `off | read |
   write`, like `connectorScopes`. MausBot gets `write` on everything the
   phone allows, by Omkar's decision 2. Other bots start `off` and are
   granted from the bot's Settings, where the same sheet of six rows appears
   with a per-bot switch. The verdict runs on every call, not only on
   `tools/list`.
3. **Per device.** A switch in the phone's own Settings, "Let bots use this
   phone's apps", like `browserControlAccess`. Off hides the phone from the
   registry entirely.

Routine checks (section 6) read the phone with the bot's `read` grant and
the owner rule above; they never write.

Then the turn policy that already exists:

- Reads run silently.
- Writes (events, reminders, contacts, home) are recorded as activity rows
  in the chat and in the decision log. They do not ask, because the person
  granted `write` to that bot for that app. Full access and Approve-for-me
  behave as they do for any tool.
- Sends are outbound. The `index.ts` outbound hold (`outboundRequests`,
  "Send on your behalf?" card, 25-a-day cap) moves from a Composio-only
  branch to a helper both the connectors route and the device kind call.
  Full access bypasses the card as it does today; the compose sheet is
  still a tap, so a message is never sent without the person.
- The daily cap counts phone sends with connector sends.

### 5. The phone side

**The sheet.** Settings → "Phone apps for bots", also offered once by the
proactive bot as a card in its chat ("Let me use your phone's apps?") and
reached from the bot's own Settings. Six rows in Grok's order, each with its icon,
one line of what the bot can do, and Allow. Allow asks the OS for that one
permission, nothing else. Below the rows: the per-device switch, the list of
bots that may use the phone, and one sentence the stores require: what a
bot reads is sent to the AI engine the person chose (Apple guideline
5.1.2(i) wants the third-party AI named; the sentence names the engine from
the server's config, "sent to Claude", "sent to OpenAI", "stays on your
Cloud" for a local model).

On Android the Messages row has a second half, "Let MausBot see new
messages", which opens the notification-access settings page after the
disclosure screen, then shows the picker of apps and groups (populated from
the notification titles seen so far: "WhatsApp: Family", "WhatsApp:
Supamaus team", "Messages"). Only ticked sources are forwarded.

**Modules.** One native module per capability in each app, behind one
protocol so the job runner does not know which app it is talking to:
`ios/Sources/CompanionCore/DeviceTools/*.swift` (EventKit, Contacts,
CoreLocation + MapKit, HomeKit, MessageUI) and
`android/core/.../devicetools/*.kt` (CalendarContract, the app's reminders
store + AlarmManager, ContactsContract, FusedLocationProvider, SMS and
WhatsApp intents, NotificationListenerService). Each module exposes
`capability`, `granted()` and `run(tool, arguments)` and nothing else. A
shared fixture file under `ios/Tests/CompanionCoreTests/Fixtures/` holds the
job and result shapes so both platforms parse the same bytes, as the
touch-control and companion fixtures already do.

**The job runner.** Lives in CompanionCore / `core`, next to the SSE client.
Polls only while registered and enabled, backs off when idle, wakes on the
`device.job` frame, leases, runs the module, posts the result, repeats. It
never runs two jobs at once. Compose sheets and anything needing the screen
return `foreground_required` when the app is not visible, and the app posts
a local notification "MausBot wants to send a message; tap to finish" that
opens the pending job.

**Background.**

- Android: the existing always-on service is the pocket-mode switch. The
  sheet says so and offers it. The notification listener is its own
  service, as Android requires.
- iPhone: while the app is open or lingering, nothing new. Pocket mode is
  sub-project D: a silent-push subset extracted from the push branch
  `bringin/2788` (device token registration `PUT /api/push/device`, the
  control-plane relay send, `server/phone-push.ts` trimmed to that), not the
  whole closed-app alert feature, which that branch also carries and which
  stays a later item. D adds the `aps-environment` entitlement, the
  `remote-notification` background mode, and one push shape, silent,
  carrying only a job id. The Admin relay route for Cloud homes does not
  exist yet and is built in D. The app wakes, polls, runs the one job, posts the result, sleeps.
  The harness coalesces: one silent push per phone per job burst, never
  more than the few per hour iOS honours; a job that cannot be delivered
  within its timeout fails with the offline sentence. On a Cloud home the
  push goes through the Admin relay (`/api/cloud/services/push`, as the
  standalone-Cloud spec already planned), so no APNs key is on a customer
  machine.

**Permissions declared** (and nothing more): iOS usage strings for
calendars (full), reminders (full), contacts, location when in use, HomeKit,
plus the HomeKit entitlement and a privacy manifest entry; Android
`READ_CALENDAR`, `WRITE_CALENDAR`, `READ_CONTACTS`, `WRITE_CONTACTS`,
`ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `SCHEDULE_EXACT_ALARM`,
`BIND_NOTIFICATION_LISTENER_SERVICE` on the listener, `queries` entries for
WhatsApp and the SMS app. No `READ_SMS`, no `SEND_SMS`, no background
location, no `READ_CALL_LOG`.

### 6. The proactive routine and the phone

On main the Chief's routine "Keep an eye on my day" (`server/host/proactive.ts`)
runs checks every 15 minutes (`server/host/routine-checks.ts`) that read
Google Calendar and Gmail through `server/connected-reads.ts` (`READ_APPS =
gmail | googlecalendar`) with no AI, and only then decide whether an AI run
is worth it. Three additions:

- **Phone calendar as a read app.** `READ_APPS` gains `phonecalendar`. It is
  "connected" when the owner has a registered phone whose calendar is
  allowed and the bot's `phoneApps.calendar` grant is at least `read`. Its
  read is a background `PHONE_LIST_EVENTS` job over the same lookahead
  window, mapped to the same `CalendarEvent` shape (attendees,
  `selfDeclined`, `status` from the invite state). Events that also exist in
  Google Calendar (same `iCalUID`) are merged, not doubled. A phone that does
  not answer by the next tick is a failed read like any other: the check
  keeps its cursor, backs off, and the brief says "Couldn't read your
  iPhone's calendar · open the app". The last successful read is kept in
  `routine-checks.json` on the harness until the next success, as the Gmail
  cursor is.
- **Phone inbox as a check.** Android's listener posts captured messages to
  `POST /api/devices/self/observations` as `{ source: "whatsapp:Family",
  from, text, at }`. A new check `messages` keeps the last 200, or 7 days,
  whichever is less, in `routine-checks.json` on the harness, and hands new
  ones to the same batched triage run that mail goes through ("Needs you"
  rows, drafts only) and to the brief under a "Messages" section. Nothing is
  answered automatically. The sheet's disclosure says that ticked messages
  are kept on the person's own computer or Cloud for a week.
- **Reminders as the hand-off.** When the routine's run has something only
  the person can do (sign, reply, call) and the phone allows reminders, the
  bot creates a reminder with the thread link in its notes, in addition to
  the brief row. This is a line in `WATCH_INSTRUCTIONS` plus the tool, not
  a new mechanism.

What to watch, how often, and which rows to raise stay as built; Omkar
decided to tune them after real use.

### 7. Companion mode and Cloud mode

| | Companion (Mac + phone) | Cloud home (phone alone) |
|---|---|---|
| Identity | sidecar's `x-openmausbot-companion-device` header | the `omb_sess_` session |
| Routes | `/api/devices/self/*` and `GET /api/devices` added to `companion/src/routes.ts`; `device.job` added to the SSE scrub list as pass-through | all reachable already |
| Push | APNs through the control plane relay with the installation credential (branch 2788) | APNs through the Admin relay with the machine bearer |
| Gate | none; tools work on a free plan while the app is open | the Cloud plan is the gate for pocket mode; the relay refuses an unpaid account |

The Mac's own Apple Calendar/Reminders/Mail pack (2026-10-16 scope) is a
different connector on a different device. When both a Mac pack and a phone
are present, both show as sources; the bot's tools are namespaced by
device (`PHONE_*` here, `MAC_*` there) so nothing collides.

## Delivery

Each is its own branch, spec'd here, planned separately. Server halves go to
milind-soni/OpenMausBot, phone halves to SupaMaus/mausbot-mobile
(`feat/phone-apps`), Admin half to openmaus-cloud.

| | Sub-project | Repo | Depends on |
|---|---|---|---|
| A | Device registry, device jobs, `device` MCP kind, per-bot grants, outbound hold shared, Settings → Phones list, `device.job` frame, companion routes | OpenMausBot | – |
| B | iPhone pack: sheet, six modules, job runner, fixtures, privacy manifest, App Review notes | mausbot-mobile | A |
| C | Android pack: sheet, modules incl. reminders store and notification listener with picker, job runner, Play disclosure + Data safety | mausbot-mobile | A |
| D | iPhone pocket mode: finish and merge `bringin/2788`, silent job push, Admin relay path for Cloud homes, entitlement + background mode | OpenMausBot, openmaus-cloud, mausbot-mobile | A, B |
| E | Proactive routine: `phonecalendar` read app, `messages` check from Android observations, reminders hand-off line | OpenMausBot | A, B or C |

A and B can be built in parallel against the fixture file; C follows B's
shapes. Android reaches pocket mode at C; iPhone at D.

## What is left to the builder

- Exact JSON schemas per tool, the fixture file, and the result caps per
  list.
- The registry's on-disk mirror format and where the Cloud page shows phones.
- How the sheet's six rows read on each platform, the icons, and the copy of
  the disclosure screen (the store wording constraints above are the only
  requirement).
- The iOS limited-contacts case (iOS 18): whether to surface "limited" in the
  sheet or just work with what is granted.
- Poll back-off curve, lease and re-delivery timers (start from
  shared-computers' values).
- Test strategy per layer: server unit tests on the job queue and verdicts,
  package tests on both phones with the fixture, one UI test per sheet, and
  a device check on both of Omkar's phones before any PR is marked ready.

## Calls made in this document (Omkar did not decide these)

- Reminders on Android are the app's own list with exact alarms, not Google
  Tasks (that would be a connector again).
- Messages sending always goes through the platform compose sheet or the
  WhatsApp link; no direct SMS sending, to stay inside Play policy.
- Reading messages is Android only, through the notification listener, and
  only for ticked sources.
- Home is iPhone only in this design.
- Location is When In Use only, one fix per call, foreground or push wake.
- Other bots start with no phone access; the proactive bot starts with
  everything the phone allows.
- Phone data never reaches the control plane or the Admin; on the person's
  own harness only the last calendar read and 200 captured messages (7 days)
  are kept.
- A phone belongs to the harness owner; routine checks may use it as the
  owner; nobody else's turns ever see it.
- Two job classes: in-turn (45 s, 120 s for sends) and background (waits a
  routine tick, reads only).
- Sub-project D extracts only the silent-push subset of `bringin/2788`;
  closed-app alert pushes stay a later item.
- The job queue copies the shared-computer lending shape rather than adding
  a WebSocket.
- `PHONE_*` tool naming so the outbound classifier needs no special case.
- The free plan gets the tools while the app is open; only pocket mode is
  Cloud-only.

## As built: sub-project A (server), 2026-10-23

The server half shipped on OpenMausBot branch `feat/phone-apps-server`. Where
it differs from the sections above, this list wins; B and C build against it.

- **Routes** are under `/api/phones` (the sidecar reserves `/api/devices`):
  `PUT /api/phones/self` (register; the body may carry fields this server does
  not know, they are dropped), `GET /api/phones/self`, `DELETE /api/phones/self`,
  `GET /api/phones/self/jobs` (long poll, answers within 20 s),
  `POST /api/phones/self/jobs/:id/lease`, `POST /api/phones/self/jobs/:id/result`
  (`{ ok: true, result }` or `{ ok: false, error, code? }`; an unknown `code` is
  read as absent). Admin only: `GET /api/phones`, `DELETE /api/phones/:key`.
- **Identity** is never the body: a Cloud or direct session (`session:<id>`,
  not cookie-only) or the sidecar's verified device (`companion:<device id>`).
  The register response's `phone.key` is the value to filter `device.job`
  frames by.
- **Removal on the computer sticks.** `DELETE /api/phones/:key` fails the
  phone's queued and leased jobs with "This phone's access changed." and
  blocks the key; the next `PUT /api/phones/self` from it gets 403 "This phone
  was removed on the computer. Pair it again to use its apps." Pairing again
  gives a new key. The phone's own `DELETE /api/phones/self` does not block.
- **Online and the nudge.** A job is queued and the `device.job` frame
  (admin-only on the events stream, `{ kind, phone, id }`) is sent first; if
  no poll picks the job up within 15 s and the phone was not seen in the last
  60 s, the job fails as offline. An app without an open events stream should
  poll at least once a minute to stay "online".
- **Owner rule as built.** Team Clouds, hosted workspaces, servers with shared
  sign-in and service-trust servers offer no phones. On a Cloud home the
  lending proof decides. On a desktop: the owner's own lines, live admin
  sessions, and routines the owner wrote (recorded in `owner-routines.json`
  when an owner or admin creates or re-saves the prompt) count as the owner;
  peer-asked, relayed and webhook-handed work never does. Routines created
  before this change get no phone until the owner re-saves them.
- **Tools.** 23 `PHONE_*` tools through MCP kind `device`; the grant is
  `bot.phoneApps` (unset, every bot gets everything the phone allows); held
  tools are those `shared/outbound.ts` classes as
  outbound: `PHONE_SEND_MESSAGE`, `PHONE_SEND_WHATSAPP`, `PHONE_RESPOND_TO_INVITE`.
  The phone used most recently that allows the tool's app is chosen when the
  bot names none. Timeouts: 45 s read/write jobs, 120 s held jobs; results
  over 256 KB are refused as `too_large`.
- **Every bot by default.** With `phoneApps` unset any bot, not only the Chief,
  may use what the phone allows; an explicit `phoneApps` per bot still wins
  (`{}` switches it off), and the owner rule is unchanged.
- **Where the person is talking from.** A registered phone's send is noted by
  its `sendId` (one is minted for a phone send without one, and for each Live
  call line from the phone); the direct turn it starts is told to do reminders,
  events, contacts, location and texts on the phone. A person's own direct turn
  from elsewhere, a room turn and the prompt preview are told the person is at
  the computer: do things the usual way, read the phone when it helps, and ask
  once before changing anything on it unless they said where. Turns nobody typed
  (routine and webhook runs, peer asks, coordination, continuations whose
  request is unknown) are told nobody is waiting and to use the phone only when
  the task names it. This sentence is its own volatile section, `device-place`,
  so the `device` section and the cached system prompt stay the same from turn
  to turn.
- **Fixture.** `server/testing/fixtures/phone-jobs.json` pins every shape
  above; copy it by hand into `ios/Tests/CompanionCoreTests/Fixtures/` (the
  capture script captures live and does not copy files).
