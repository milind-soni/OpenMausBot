# Google Play submission — OpenMausBot 1.4.0

Everything needed to put `com.openmausbot.companion` on Google Play, in the
order the Play Console asks for it. Written for the 1.4.0 release; later
releases reuse it and only change the version numbers and the release notes.

Until now the Android app shipped only as a signed APK on GitHub Releases
(`android-v1.0.0` … `android-v1.3.0`). Play wants an **App Bundle** (`.aab`),
which is why the build command below is `bundleRelease`, not `assembleRelease`.

- Package: `com.openmausbot.companion`
- Version: `1.4.0`, `versionCode` 10400
- `minSdk` 26 (Android 8.0) · `targetSdk` / `compileSdk` 37 (Play requires 35+)
- Account: Supamaus Software Private Limited (organisation account — the
  12-testers-for-14-days closed testing rule applies to personal accounts only)

---

## 1. Build and sign the bundle

The bundle is built unsigned unless the signing material is present, so supply
it on the command line. Nothing here is stored in the repo.

```sh
cd android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
OPENMAUSBOT_KEYSTORE_FILE="$HOME/openmausbot-release.jks" \
OPENMAUSBOT_KEYSTORE_PASSWORD='<the password from ~/openmausbot-release-keystore-PASSWORD.txt>' \
OPENMAUSBOT_KEY_ALIAS=openmausbot \
./gradlew clean :app:bundleRelease
```

Output: `android/app/build/outputs/bundle/release/app-release.aab`.

Check it really is signed before uploading — an unsigned bundle is rejected at
upload with a message that does not say "unsigned":

```sh
unzip -l app/build/outputs/bundle/release/app-release.aab | grep -E 'META-INF/[A-Z0-9]+\.(RSA|SF)'
```

That must print two lines. Empty output means the environment variables did not
reach Gradle.

## 2. App signing — upload our existing key

Decision made deliberately: Play must sign installs with **our existing release
key**, the same one that signed the GitHub APKs. Otherwise a user who
sideloaded 1.3.0 cannot update from Play without uninstalling first, losing
their pairing and local data.

In Play Console → **Test and release → Setup → App signing**, choose *Export and
upload a key from a Java keystore*. That page gives a `pepk.jar` download and a
one-time encryption public key. Then:

```sh
java -jar pepk.jar \
  --keystore="$HOME/openmausbot-release.jks" \
  --alias=openmausbot \
  --output=$HOME/openmausbot-play-upload-key.zip \
  --include-cert \
  --rsa-aes-encryption \
  --encryption-key-path=<the .pem downloaded from the console>
```

Upload the resulting zip on that same page. Do this **before** the first
release upload: after a release exists, the app signing key cannot be changed.

Keep `~/openmausbot-release.jks` backed up. Losing it after this point means
losing the ability to ship updates outside Play.

## 3. Store listing

**App name** (30 char limit)

```
OpenMausBot
```

**Short description** (80 char limit — 74 used)

```
Chat with the AI bots running on your own computer, straight from your phone.
```

**Full description** (4000 char limit)

```
OpenMausBot is your own team of AI bots, running on your own computer. This app
is the phone half of it: pair once, and you can read and answer your bots from
anywhere, while the work keeps happening on your machine.

Your computer does the thinking. The phone is a remote control — so your
conversations, files, and credentials stay where you put them.

WHAT YOU CAN DO FROM THE PHONE

• Chat with any bot on your computer, and start new conversations
• Get a notification the moment a bot replies, finishes, or needs you
• Approve or reject an action a bot wants to take, before it happens
• Talk instead of typing — voice mode, or call a bot like a phone call
• Send a photo, a document, or a link straight into a conversation from any
  app's share sheet
• Open the files your bots make, without leaving the chat
• Switch between several computers, and between the threads on each one

HOW PAIRING WORKS

Open OpenMausBot on your desktop, show the pairing QR code, and scan it with
this app. That is the whole setup. The phone then reaches your computer in one
of three ways:

• On the same Wi-Fi, directly
• Over Tailscale, if you use it
• Over an optional encrypted connection, if you turn that on, so your phone
  works when you are away from the network

YOUR DATA STAYS YOURS

Bots, conversations, approvals, and files live on your computer, not on our
servers. There are no ads, no third-party analytics SDKs, and no cross-app
tracking. Credentials you type on the phone are encrypted for your computer
before they leave the screen.

OPEN SOURCE

OpenMausBot is Apache 2.0 licensed and developed in the open at
github.com/milind-soni/OpenMausBot.

REQUIRES A COMPUTER RUNNING OPENMAUSBOT

This app is a companion, not a standalone assistant. You need the free
OpenMausBot desktop app for macOS, Windows, or Linux — openmausbot.com — and
your own model API key or local model. It does not include a subscription to
any AI provider.
```

**Category:** Productivity
**Tags:** AI assistant, chat, remote control, developer tools
**Contact email:** omkar@supamaus.com
**Website:** https://openmausbot.com
**Privacy policy:** https://openmausbot.com/privacy

### Graphic assets still to produce

| Asset | Spec | Status |
| --- | --- | --- |
| App icon | 512×512 PNG, opaque | `assets/play-icon-512.png` ✓ |
| Feature graphic | 1024×500 PNG, no transparency | `assets/feature-graphic-1024x500.png` ✓ |
| Phone screenshots | 2–8, ≥ 1080 px on the short side, 9:16 | `assets/screenshots/` (5, 1080×2400) ✓ |
| 7" / 10" tablet shots | optional; only if the listing claims tablets | skip |

Both graphics are rendered from the HTML beside them — open
`assets/play-icon.html` or `assets/feature-graphic.html` in a browser, or
re-render headlessly:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --screenshot=assets/feature-graphic-1024x500.png --window-size=1024,500 \
  --hide-scrollbars assets/feature-graphic.html
```

The icon is the app's own adaptive launcher icon (green mascot on white),
converted from `res/drawable/ic_launcher_foreground.xml` — deliberately not the
black desktop icon in `build/icon-1024.png`, so the Play listing matches what
lands on the home screen.

The five screenshots were captured on the `openmaus` AVD (Pixel 7, 1080×2400)
against the repository's own isolated fixture — `scripts/control-omb.ts launch`
with `FAKE_CLAUDE_REPLIES` scripted and `FAKE_CLAUDE_TOOL_CALLS='[]'` — so no
real conversation, computer name, or account appears in them. The status bar is
SystemUI demo mode (9:41, full battery, no notification clutter).

Order them in the listing as they are numbered: the thread list, a conversation,
call mode, pairing, and the updates sheet.

To re-shoot: boot the AVD, install the preview APK, pair it by deep link
(`openmausbot://pair?address=…&token=…` from `POST /api/auth/pairing`), and note
that the preview variant strips that deep link on purpose — re-enable
`PairingLinkActivity` in `app/src/preview/AndroidManifest.xml` for the capture
and revert it afterwards. Quote the URL for the device shell, or `&` truncates
it and the invite arrives without its token.

## 4. Content rating questionnaire

- Category: **Utility, productivity, communication, or other**
- Violence, sexuality, profanity, drugs, gambling: **No** to all
- **User-generated content:** answer **Yes**, with the qualification below.
  Nearly all content is the user's own bots talking on the user's own computer.
  But the app does render rooms (`Room` / `groups` in `:core`), and a room on a
  shared team server can carry messages typed by another person. Nothing is
  publicly discoverable and there is no public feed — the audience is whoever
  the owner invited to a server they run. Play will then ask about moderation
  and reporting; today the app has **no in-app report or block control**
  (`ic_block.xml` exists as an icon but no reporting surface uses it), and
  moderation is whatever the server owner does. If that answer risks a
  rejection, the cheapest fix is a "Report a message" item in the message
  action tray that emails omkar@supamaus.com — not a reason to answer No here.
- Target age group: **18 and over** (keeps the app out of Families policy, which
  the camera and microphone surfaces would otherwise complicate)

## 5. Data safety form

The rule Play applies: data is "collected" only if it is *transmitted off the
device to us or a third party and kept*. Data that passes through a relay in
transit and is not stored does not count as collected.

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | **Yes** — but only via optional hosted access |
| Is all data encrypted in transit? | **Yes** (Tailscale / HTTPS; plain LAN is opt-in on a trusted network) |
| Do you provide a way to request data deletion? | **Yes** — https://openmausbot.com/privacy |

Declare exactly one item:

- **Personal info → Email address.** Collected, not shared. Optional
  (only if the user signs in for hosted access). Purpose: *Account management*.
  Not used for advertising or tracking.

Everything else is **not collected**: messages and photos stay on the user's own
computer; the pairing token stays in the device's encrypted store; there are no
analytics or advertising SDKs; the device identifiers we hold are opaque
installation IDs tied to the desktop installation, not the phone.

Other declarations:
- **Ads:** app contains no ads
- **Government app:** no · **Financial features:** none · **Health:** none
- **News app:** no

## 6. Sensitive permission declarations

Play asks about these in *App content*:

- `CAMERA` — QR pairing only. Frames are read for a code and discarded.
- `RECORD_AUDIO` — voice and call mode, user-initiated only.
- `FOREGROUND_SERVICE_CONNECTED_DEVICE` — holds the socket to the paired
  computer open during a session. The manifest declares
  `android:foregroundServiceType="connectedDevice"`, which matches the use.
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` — prompted, not required; without it
  Android drops the session when the screen sleeps.
- `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, network state permissions —
  ordinary, no declaration form.

No `MANAGE_EXTERNAL_STORAGE`, no SMS or call-log permissions, no accessibility
service, no `QUERY_ALL_PACKAGES`.

## 7. Release

Production release notes (`<en-US>`), 500 char limit:

```
Call a bot from your phone and set a voice key from the device. A cross-bot
inbox shows every thread waiting on you, and queued messages now appear while
they send. Archive threads you are done with. Fixes: the keyboard's Return key
inserts a newline instead of sending, the composer keeps its shape as a draft
grows, and an open thread reloads its history after a reconnect.
```

Rollout: start at 20% staged rollout, watch crash-free rate and the Discord
reports for a day, then go to 100%.

## 8. Reviewer notes (Play Console → App access)

The app is unusable without a paired computer, so a reviewer who only opens it
sees a pairing screen. Declare **All or some functionality is restricted** and
give instructions:

```
This app is a companion for the OpenMausBot desktop app and cannot be used on
its own. To test it: install the free desktop app from https://openmausbot.com
(macOS, Windows, or Linux), open it, go to Settings > Phone, and choose "Set up
a phone" to show the pairing QR code. Scan that code with this app on a phone on the same Wi-Fi
network. No account or purchase is required. A demo video of the paired flow is
available on request at omkar@supamaus.com.
```

## 9. Order of operations

1. App signing key uploaded (step 2) — before any release
2. Store listing + graphics (step 3)
3. Content rating (step 4), Data safety (step 5), App access (step 8),
   Ads, Target audience
4. Upload `app-release.aab` to the Production track, paste release notes
5. Send for review. First review of a new app typically takes a few days;
   organisation accounts skip the 14-day closed-testing requirement
