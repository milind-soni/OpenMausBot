# Phone push: alerts when the phone app is closed

Today the MausBot phone app only gets a notification while it is connected to its
computer or Cloud. The app builds every notification itself from the live event
stream (`notify` frames). So an alert arrives while the app is open, for about
25 seconds after it goes to the background on iPhone, or all the time on Android
with Always-on turned on. When the phone is locked for longer, or the app was
swiped away, nothing arrives.

This document describes real push: Apple's push service (APNs) on iPhone and
Firebase Cloud Messaging (FCM) on Android wake the phone even when the app is
closed. The code for every part is in place and switched off. Nothing changes
until the owner supplies the keys and turns it on (see "Switching it on").

## How it works

1. **The phone gets a device token.** The app asks the system for its raw push
   token (`Notifications.getDevicePushTokenAsync()` in expo-notifications): a
   64-character hex string on iPhone, an FCM registration token on Android. No
   third-party push service sits in between.
2. **The phone gives the token to its computer or Cloud,** over the link it
   already uses and with the credential it already has:
   `PUT /api/push/device {platform, token, environment?, pairing, kinds}`. The
   server knows which phone is asking from what authenticated the request (the
   phone's paired session, or the device the desktop's companion vouched for),
   never from the body. The phone does this after it connects, whenever the
   token changes, and whenever the person changes a notification switch.
3. **The server registers the token with the control plane**
   (`POST /v1/installations/self/push/register`), using the installation
   credential it already holds for the hosted transport. A Cloud home, which
   has none, asks its Admin to relay the same call (see "Cloud homes"). The
   control plane holds the APNs key and the Firebase service account; servers
   and the Admin never do.
4. **Something happens that would notify the person.** The server emits its
   `notify` frame as today. For each registered phone, it checks:
   - is phone push switched on;
   - is this one of the kinds a closed app is woken for: an **approval**, a
     **question**, a **sign-in** request, or a **finished reply** (`done`);
   - did this phone ask for this kind (its own Settings switches);
   - does this phone hold a live event stream right now (then it gets the frame
     the normal way, and no push);
   - would this phone have been shown this frame at all (the same audience rule
     the event stream uses: bot visibility, rooms, admin-only frames, a Team
     Cloud's per-person frames);
   - has it had a push for the same kind and conversation in the last
     10 seconds, or 30 pushes in the last 10 minutes.
5. **The server asks the control plane to send**
   (`POST /v1/installations/self/push/send`) with the kind, a title made from
   names, ids, the phone's tag for this computer, and a notification
   identifier. The send is queued in a small outbox: a failure the relay may
   recover from is retried after 5 s, 30 s and 2 min; a push still waiting
   after 10 minutes, or for a phone that connected in the meantime, is
   dropped.
6. **The control plane sends it to APNs or FCM,** which wake the phone.
7. **The phone shows it.** On iPhone the system shows it. On Android
   expo-notifications shows it, in the same channel and with the same buttons
   as a local notification.
8. **A tap opens the app on that computer and conversation.** The app
   connects and fetches the content as it always does. The buttons (Allow,
   Deny, Answer) work as they do on a local notification: they open the app,
   wait for the connection, and answer the card.

## What a push contains

Never message text. The control plane's schema refuses any field that could
carry it (`400 invalid_request`, not silently dropped).

| Field | Example | Notes |
| --- | --- | --- |
| kind | `approval` | `approval`, `question`, `sign-in`, `done` |
| title | `Scout needs approval` | the server's own notification line for that kind, from names only, in the conversation's language |
| bot id, bot name | `bot_…`, `Scout` | |
| thread id | `th_…` | which conversation to open |
| room id, room name | `grp_…`, `Launch` | only in a room |
| pairing | the phone's random tag for this computer | so a tap opens the right one of several saved computers |
| collapse id | `openmaus.<thread>.<seq>` | see "No duplicates" |

What the lock screen reads, by kind:

- approval: "Scout needs approval" (in a room: "Scout in Launch needs approval")
- question: "Scout has a question"
- sign-in: "Scout needs you to sign in to a website" (the website is left out)
- finished reply: "Scout finished"

On iPhone the payload is `{aps: {alert: {title}, sound, thread-id, category,
interruption-level}, omb: {...}, body: {...}}`. On Android it is a data-only
FCM message with `title`, `tag`, `channelId`, `categoryId`, `threadIdentifier`
and `body` (the same fields as JSON), and no message text. The exact shapes are
in `cloudflare/control-plane/README.md` ("Phone push relay").

A Live Activity push leaves `alert` unset. An activity `update` that carries
`alert` lights the screen and pops the activity open in the Dynamic Island,
which brings back the large expanded island the phone app removed (its own
activities send no alert configuration, so the island stays a small mark).
The person still hears about the ask: the closed-app alert above arrives as
an ordinary notification. Only a push-to-start `start` carries `alert`,
because ActivityKit does not start an activity remotely without one, and the
control plane refuses `alert` on anything else. A phone that registers its
status words (`statuses`) gets the activity in its content state version 1
(`status`, `ask`, `waiting`, `version`); a phone that does not gets the
earlier shape with `headline`, which the phone app also draws.

## No duplicates with local notifications

A push goes only to a phone with no live stream, so most of the time only one
of the two exists. They can meet at the edges: the app comes back and replays
the frames it missed, or the stream closes just as an alert is sent.

- The push carries the identifier the app would give its own notification for
  the same frame: `openmaus.<threadId>.<seq>`. On iPhone this is the APNs
  collapse id, which becomes the notification's identifier; on Android it is
  the notification's tag. A local notification with the same identifier
  replaces the push instead of adding a second one.
- The app also remembers which pushes it has seen (still in the notification
  centre, tapped, or received while open) and does not post a local
  notification with the same identifier.
- In the foreground, a push that arrives while the stream is live is not
  shown: the stream's own notification wins.
- If the identifier would be longer than 64 bytes (APNs' limit), the push
  falls back to one identifier per kind and conversation. That only happens
  for thread ids over 40 characters; MausBot's are shorter.

## Privacy and threat model

**What the control plane learns.** For each registered phone: the installation
that registered it (for a Cloud home: the home's machine id), the device token, its platform and APNs environment, and
when it last got a push. For each send: the kind, the title, the bot's and
room's names and ids, the thread id and the phone's pairing tag. It never sees
message text, files or credentials. It logs only the request id, the platform
and the provider's status and reason, never the token or the payload.

**What the Admin learns (Cloud homes only).** Which of its machines asked, when,
and the action; and, in memory for the length of the call, the body it
forwards: the device token, its platform and environment, and for a send the
same names, ids and title as the control plane. It stores none of it: no token
in its database or logs (its per-phone limit counts a hash keyed with a random
key that dies with the process), and it logs only the machine, the action and
a status.

**What Apple and Google learn.** The same names, ids and title, the device
token, and when MausBot pushed to the phone. Not the content of any
conversation.

**Where tokens are kept.** On the computer or Cloud, in
`<data dir>/push-devices.json` (mode 0600), beside the other paired-device
records. In the control plane, in the D1 table `installation_push_devices`
(token and its SHA-256), or for a Cloud home in `machine_push_devices` (the
same, keyed by the home's machine id). The phone app never sends the token
anywhere else.
`GET /api/push/device` never echoes it.

**Revocation.** A registration ends when:

- the phone removes the computer (the app calls `DELETE /api/push/device` first,
  while it can still reach it);
- the computer signs the phone out, or its session expires
  (`onSessionRevoked`);
- the desktop's companion unpairs the phone (`/api/live/device-revoked`);
- the same phone pairs again (the token moves to the new pairing);
- Apple or Google say the token is dead (`410`), which deletes it everywhere;
- the installation is revoked in the control plane, which deletes all its
  tokens;
- for a Cloud home, the Admin retires or deletes the Cloud: it asks the control
  plane to delete every token of that machine (`.../push/forget`), and keeps
  asking until it answers.

Known gap: a phone that removes a computer it cannot reach (the computer is
off) leaves its registration there until one of the other events happens. The
phone then still gets "Scout finished" from that computer; a tap opens
nothing, because the computer is no longer saved.

**Rate limits.** On the server: one push per phone, kind and conversation in
10 seconds, 30 per phone in 10 minutes. In the control plane: 600 sends per
installation and 60 per token per hour, 120 registrations per hour, 50 tokens
per installation; the same per Cloud home, plus 20,000 sends and 6,000
registrations an hour across every Cloud home together. The Admin applies the
same per-home and fleet limits before it forwards anything.

**Replay and forgery.** Every relay call needs the installation credential.
A send reaches only a token that the same installation registered, so a
stolen credential of one computer cannot reach another computer's phones. It
could send its own phones content-free alerts with a misleading title (up to
200 characters, one line) until it is revoked; that is the open risk of a
stolen credential, bounded by the rate limits. Replaying a send gives a
duplicate alert at most, replaced on screen by the collapse id. A paired phone
can register only for itself; a phone that registered somebody else's token
would only send that person the same names and ids it can already read.

A Cloud home signs each call to its Admin with its own bootstrap secret, over
the machine id, the action, a timestamp (5 minutes), a nonce (once) and the
body. The Admin takes the machine id from that signature, never from the body,
so a compromised home can register and push only under its own machine id,
which reaches only the tokens its own phones registered; it cannot reach
another customer's phone. The Admin reaches the control plane with one secret
shared only between the two. Whoever held that secret could push content-free
alerts to any Cloud home's registered phones by naming machine ids, bounded by
the per-token and fleet limits above, but could not read a token back or reach
an installation's phones. It is rotated without downtime: the control plane
accepts a previous secret beside the current one.

## Cloud homes

A desktop has an installation credential once its owner turns on "Use your
phone anywhere", and `openmausbot serve` has one after `openmausbot account login` or
from `OMB_INSTALLATION_CREDENTIAL` (or a push-only `OMB_PUSH_CREDENTIAL`). A
Cloud home has none. So **the Admin relays for its homes**: built, and off
until switched on.

- **The home** (`server/phone-push-admin.ts`): when the server runs as a Cloud
  home and has no installation credential, every relay call goes to its Admin
  instead, `POST <admin>/api/cloud/machines/push/{register,unregister,send,activity}`,
  with the very same body, signed with the bootstrap secret it already holds
  (headers `x-omb-cloud-machine`, `x-omb-cloud-timestamp`, `x-omb-cloud-nonce`,
  `x-omb-cloud-signature: v1=<HMAC-SHA256 over "omb-phone-push-v1", the machine
  id, the action, the timestamp, the nonce and the body's SHA-256>`). Same
  outbox, retries and back-off: `503 push_unavailable`, a `401` or a `404` (an
  Admin with its switch off, or an older one) leaves it alone for an hour. Still
  gated by `features.phonePush` / `OMB_PHONE_PUSH`, off by default.
- **The Admin** checks the signature, takes the machine id from it, checks the
  body against the control plane's own strict schemas (no field for message
  text), applies the limits, and forwards the parsed body. Its switch is
  `OMB_CLOUD_PHONE_PUSH` (off by default); it forwards to
  `OMB_CLOUD_PUSH_RELAY_URL` with `OMB_CLOUD_PUSH_RELAY_SECRET`. Retiring or
  deleting a Cloud deletes its tokens at the control plane, switch on or off.
- **The control plane** has the matching routes,
  `POST /v1/cloud-homes/<machine id>/push/{register,unregister,send,activity,forget}`
  (`src/push-cloud-homes.ts`), beside the installation ones and with the same
  bodies, limits, storage shape (`machine_push_devices`, migration `0019`) and
  send path, plus a fleet-wide limit. They take only the Admin's secret,
  `CLOUD_HOME_PUSH_SECRET` (and `CLOUD_HOME_PUSH_SECRET_PREVIOUS` during a
  rotation), compared in constant time; with neither set they answer
  `503 push_unavailable`. Nothing changes for installation callers.

The bodies both sides accept and refuse, and the home's signature, are one
fixture, `cloudflare/control-plane/test/fixtures/cloud-home-push.json`, which
the Admin holds byte for byte and checks with the same SHA-256.

No credential lives on the home beyond the bootstrap secret it already had,
nothing needs rotating every 90 days, and the Admin keeps no device token.

**Switching it on for Cloud homes**, after steps 1 to 10 of "Switching it on",
in order:

1. Apply the control plane's migration `0019_cloud_home_push.sql`.
2. Set the control plane's `CLOUD_HOME_PUSH_SECRET` (random, 32 characters or
   more) and deploy it.
3. Ship an Admin image with the relay, then set the same value as the Admin's
   `OMB_CLOUD_PUSH_RELAY_SECRET`, and `OMB_CLOUD_PUSH_RELAY_URL` to the control
   plane's origin, and restart the Admin.
4. Ship a Cloud home image with this code.
5. Turn phone push on in one test Cloud's home: `features.phonePush: true` in
   its `config.json` (its owner's `PUT /api/config`; an `OMB_PHONE_PUSH` set by
   hand in a home's environment is rewritten by the Admin at its next update),
   then `OMB_CLOUD_PHONE_PUSH` on in the Admin's Cloud operations → Switches.
6. Run "Test plan on real devices" against that Cloud, then widen.

## Always-on and the grace period

- **iPhone.** For about 25 seconds after the app leaves the screen it keeps
  its stream open and posts local notifications itself. When the stream
  closes, the server sees no live stream and pushes from then on.
- **Android, Always-on off.** The same, with the 25-second linger.
- **Android, Always-on on.** The stream stays open, so the server never pushes;
  local notifications work as today. Push is the fallback when the system or
  the phone maker kills the service.
- "Live stream" means an open `/api/events` connection from that phone. A
  stream a network box holds open after the phone went to sleep delays pushes
  until the server notices it is gone (the heartbeat, every 15 seconds,
  eventually fails).

## Time-sensitive alerts and Android channels

- On iPhone, approvals, questions and sign-in requests are sent with
  `interruption-level: time-sensitive`, so they break through Focus. That
  needs the Time Sensitive Notifications entitlement, which the phone app's
  preview and production builds carry (`timeSensitiveNotifications` in its
  `app.config.ts`); a development build shows them as ordinary alerts.
- On Android a push uses the app's existing channels: `approval_question`
  (high importance) for approvals, questions and sign-ins, and `bot_messages`
  for finished replies. A phone that never opened the new app has no channels
  yet and shows the push in the default channel.
- The categories (Allow and Deny on an approval, Answer on a question) are the
  ones the app registers today.

## Compared with the reference app, and why push goes through the control plane

The owner asked for push "like the reference app does it, with a relay". This
section says what the reference app actually does, how each part maps onto
MausBot, and which design we keep.

### How the reference app does it

- **Who sends.** The user's own server process, running on their machine,
  watches its own event stream and posts each conversation's state (phase,
  project and thread title, model name, timestamps, a deep link) to a hosted
  service it calls its relay: a Cloudflare Worker with a database. The server
  authenticates with a per-environment credential plus a short signed proof
  that can be used once. The hosted service never detects events itself.
- **What the hosted service knows.** Device tokens and preferences, the Live
  Activity tokens, which environments each account linked, and the per-thread
  state above: titles and phases, never message text (failure details are
  replaced with a fixed sentence). It fans each state out to every device of
  every account linked to that environment, through APNs (alerts and Live
  Activity updates) and FCM (data-only messages).
- **When the user's machine is off.** Nothing new is sent. The hosted service
  expires old rows (running after 2 hours, waiting after 24 hours, finished
  after 15 minutes) and a cron job ends idle Live Activities; the cards also go
  stale after 10 minutes.
- **The phone.** It registers once per account with a stable device id and the
  raw APNs or FCM token, re-registers when the token rotates, on every return
  to the foreground, and when a stored signature (token, app version, OS
  version, preferences) changes. Calls go one at a time, and a generation
  counter stops a late answer from overwriting a sign-out. Live Activities are
  always started on the phone, in the foreground; their update tokens are
  registered, and the hosted service updates and ends them by push. It does
  not start them by push: the reference app records that remote start proved
  too unreliable. On Android, a native module handles FCM data messages
  without a foreground service and shows one ongoing "agent activity"
  notification plus alerts.

### How that maps onto MausBot

| The reference app | MausBot |
| --- | --- |
| The user's server watches its events and decides | The computer or Cloud (`server/phone-push.ts`) does the same |
| Hosted relay: holds the APNs and Firebase keys, stores tokens, sends | The control plane's push routes (`cloudflare/control-plane/src/push.ts`) |
| Server authenticates with an environment credential | The installation credential the computer already has |
| Device registration goes to the hosted relay, per account | Registration goes to each computer over the phone's existing link, and the computer registers it with the control plane |
| Live Activity tokens registered, updates and ends by push | The same (`/api/push/activity`, control plane `push/activity`) |
| Android ongoing notification from FCM data, no foreground service | The same (the phone app's `bot-activity` module) |

MausBot also has something called a relay: MausBot Relay (`relay1`, `relay2`,
`relay/` in this repository). It is a different thing. It splices the phone's
end-to-end encrypted connection to the computer and cannot read a byte of it,
so it never sees an event, a bot name or a token. The reference app's relay is
a hosted service that receives plain state from the user's server and talks to
Apple and Google. In MausBot that service is the control plane.

### Should push go through MausBot Relay as well, or instead?

What it would buy:

- **The relay knows when a phone's link is down.** So does the computer: the
  relay's view is the same session the computer holds, seen from the middle.
  The computer also knows when a phone on Wi-Fi or a tunnel is gone, which the
  relay never sees.
- **One hosted hop.** We already have one: computer → control plane → Apple or
  Google. Going through the relay would add a hop (computer → relay → Apple),
  because the relay would still have to learn what to send from the computer.
- **Fewer moving parts.** It would be more. The relay nodes are long-running
  containers on two hosts, built to carry bytes they cannot read. They would
  need the APNs key and the Firebase service account on each node, a token
  store, rate limits and dead-token handling. That is a second sender to
  secure and keep in step with the control plane, which already does all of
  this and is covered by tests.

What it would cost or break:

- **Cloud homes and many phones never touch the relay.** A Cloud is reached
  directly over HTTPS, and many phones use Wi-Fi or a tunnel. Only the
  control plane can serve them all.
- **It weakens what the relay promises.** Today a relay compromise exposes
  only ciphertext and connection metadata. With push it would also expose
  device tokens and the keys that can alert every MausBot phone.
- **Credentials would sit outside Cloudflare's secret store,** on hosts we
  patch ourselves.

**Recommendation: keep the control plane as the sender. It already is our
equivalent of the reference app's relay:** a single hosted service that holds
the Apple and Google keys, receives content-free state from the user's own
machine, and sends. MausBot Relay stays a blind splice. What we take from the
reference app is everything around the sender: the phone's registration
robustness, Live Activities updated and ended by push from tokens the phone
registers, and an ongoing "working" notification on Android driven by FCM data
messages. MausBot keeps one difference on purpose: the phone registers with
each computer, not with a hosted account, because a phone can be paired
without any MausBot account at all.

## Switching it on

What the owner provides and does, in order. Nothing here has been done.

**Apple**

1. In the Apple Developer account, create an APNs auth key (`.p8`) with the
   Apple Push Notifications service enabled. Note its Key ID and the Team ID.
2. Enable the Push Notifications capability on the App ID `com.openmausbot.app`
   (and `.next` / `.dev` if those builds should get pushes), then regenerate
   the provisioning profiles.

**Google**

3. Create a Firebase project, add the Android app `com.openmausbot.companion`
   (and the `.next` / `.dev` packages if wanted), and download
   `google-services.json`.
4. In Project settings → Service accounts, generate a private key (the
   service-account JSON). It needs the Firebase Cloud Messaging API (V1)
   enabled.

**Control plane** (`cloudflare/control-plane/README.md`, "Phone push relay")

5. Apply the D1 migrations `0017_push_platforms.sql` (after `0008`) and
   `0018_push_purpose.sql` (Live Activity and push-to-start tokens). Live
   Activities and Android's ongoing notification need no further secret: they
   use the same APNs key (topic `<bundle id>.push-type.liveactivity`) and the
   same Firebase project.
6. Set the secrets: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` (the
   `.p8`), `APNS_BUNDLE_ID` (`com.openmausbot.app`), optionally
   `APNS_ENVIRONMENTS=production,sandbox` to accept development builds, and
   `FCM_SERVICE_ACCOUNT` (the whole service-account JSON).
7. Deploy the Worker. Until a platform's secrets are set its routes answer
   `503 push_unavailable` and servers back off for an hour.

**Phone app** (`app/app.config.ts` in the phone repository)

8. Put `google-services.json` where the build can read it (an EAS file secret
   named by `MAUSBOT_GOOGLE_SERVICES_FILE`, or `app/google-services.json`).
9. Build with `MAUSBOT_REMOTE_PUSH=1` (or set `REMOTE_PUSH = true`). This adds
   the `aps-environment` entitlement (`production` for preview and production
   builds, `development` for development builds), Firebase on Android, and
   turns on token registration in the app. Update the store privacy answers
   (the app now sends a device token to MausBot's servers and to Apple or
   Google).

**Desktop and server**

10. Ship the server with phone push. It stays off until
    `features.phonePush: true` is in `config.json`, or `OMB_PHONE_PUSH=1` is set
    (`OMB_PHONE_PUSH=0` forces it off). This is the rollout flag: turn it on
    for one machine first, then flip the default in a release.
11. For Cloud homes, follow "Switching it on for Cloud homes" under "Cloud
    homes".

Deploy order: migration and secrets, then the control plane, then a server
with phone push on for one test machine, then a phone build with the switch on,
then widen.

## Test plan on real devices

Run each on an iPhone (TestFlight build, production APNs) and an Android
phone (release build with Google Play services), paired with a desktop that
has "Use your phone anywhere" on and `features.phonePush: true`.

1. Pair, then `GET /api/push/device` from the phone (or check the server's
   `push-devices.json`) shows a registration with the right platform.
2. Lock the phone for a minute. Ask a bot to do something that needs approval.
   A notification "Scout needs approval" arrives within seconds, with Allow and
   Deny.
3. Tap Allow on the lock screen: the app opens, connects and answers the card.
4. Swipe the app away. Send a message to a bot; "Scout finished" arrives. Tap
   it: the app opens that conversation.
5. With the app open on screen, trigger an approval: exactly one notification
   (the local one), no push.
6. Leave the app and come back within 25 seconds while a reply finishes: one
   notification, not two.
7. Turn off "Approvals and questions" in Settings: approvals stop arriving
   while closed; finished replies still arrive.
8. Remove the computer in the app's Settings: no more pushes from it.
9. Two saved computers: a push from the one that is not active opens on that
   computer after a tap.
10. Android with Always-on on: no pushes (local notifications only); force-stop
    the service and pushes resume.
11. Uninstall the app, trigger an alert: the server log shows the token
    dropped after the provider's `410`/`UNREGISTERED`.
12. A computer with phone push left off: nothing in the control plane's logs,
    `GET /api/push/device` says `off`.

## What this does not do

- **No message previews.** The notification shows the bot's name and what it
  needs, never the message. Showing text would need the phone to open the
  encrypted link from a notification extension, which is not planned.
- **Nothing arrives if the computer is off or asleep,** or offline. The
  computer is what notices the event and asks for the push; a sleeping Mac
  notices nothing. A Cloud runs all the time, so a Cloud's phones get pushes
  whenever its bots work (once its Admin relays for it, see "Cloud homes").
- **No push for other kinds** (mentions, routine failures, waits, notices).
  They arrive as today while the app is connected.
- **No badge counts from push.** The badge is updated when the app runs.
- **No delivery guarantee.** Apple and Google may delay or drop a push (low
  battery, Focus, Doze); the outbox retries only failures between the server
  and the control plane.
