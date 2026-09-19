# Play Console checklist — OpenMausBot 1.4.0, first release

Work top to bottom. Every value you need is inline, so you should not have to
open another file. Console labels move between redesigns; where one has moved,
use the search box at the top of Play Console and search the **task name in
bold** — those names are stable even when the navigation is not.

Est. 25–40 minutes, plus the review wait.

---

## 0. Before the console — build the signed bundle (≈5 min)

**Paste the lines between the fences, never the ``` fences themselves.** Three
backticks open a command substitution in zsh, which swallows every line after
them and drops you in a bare `sh-3.2$` prompt with nothing built.

The password is typed at a prompt, not written into a command. That keeps it out
of this file, out of your shell history, and off the screen:

```sh
cd ~/Desktop/openmaus/OpenGrokBot-android-v1.4.0/android
read -s "OPENMAUSBOT_KEYSTORE_PASSWORD?Keystore password: "
```

Paste the password from `~/openmausbot-release-keystore-PASSWORD.txt` when it
asks — nothing will appear as you type, which is the point — and press Return.
Then, in the same terminal window:

```sh
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
OPENMAUSBOT_KEYSTORE_FILE="$HOME/openmausbot-release.jks" \
OPENMAUSBOT_KEYSTORE_PASSWORD="$OPENMAUSBOT_KEYSTORE_PASSWORD" \
OPENMAUSBOT_KEY_ALIAS=openmausbot \
./gradlew clean :app:bundleRelease
```

When the build finishes, clear the variable so it does not sit in the shell for
the rest of the day:

```sh
unset OPENMAUSBOT_KEYSTORE_PASSWORD
```

> `read -s` is zsh syntax, and zsh is the default shell on this Mac. If your
> prompt ends in `$` rather than `%` you are in a different shell — type `exit`
> to get back to zsh first.

Then confirm it is actually signed — this is the one check worth doing, because
an unsigned bundle fails at upload with a message that never says "unsigned":

```sh
unzip -l app/build/outputs/bundle/release/app-release.aab \
  | grep -E 'META-INF/[A-Z0-9]+\.(RSA|SF)'
```

Two lines = signed. No output = the env vars did not reach Gradle; check the
quoting on the password and run it again.

The file to upload is:
`~/Desktop/openmaus/OpenGrokBot-android-v1.4.0/android/app/build/outputs/bundle/release/app-release.aab`

- [ ] Bundle built
- [ ] Signature check prints two lines

---

## 1. Create the app (≈2 min)

**All apps → Create app**

| Field | Value |
| --- | --- |
| App name | `OpenMausBot` |
| Default language | English (United States) – en-US |
| App or game | App |
| Free or paid | Free |

Tick both declarations (developer programme policies, US export laws).

> Free → paid is impossible later. Paid → free is allowed. Free is correct here.

- [ ] App created

---

## 2. App signing — do this BEFORE any upload (≈5 min)

**Test and release → Setup → App integrity → App signing**

Choose **Export and upload a key from a Java keystore**. Download `pepk.jar`
and the encryption public key (`.pem`) it shows you, then:

```sh
cd ~/Downloads
java -jar pepk.jar \
  --keystore="$HOME/openmausbot-release.jks" \
  --alias=openmausbot \
  --output="$HOME/openmausbot-play-upload-key.zip" \
  --include-cert \
  --rsa-aes-encryption \
  --encryption-key-path=./<the-file-you-downloaded>.pem
```

Upload `~/openmausbot-play-upload-key.zip` on that page.

> **Why this order matters:** once a release exists, the app signing key is
> fixed forever. If you let Play generate its own key instead, everyone running
> a sideloaded APK from GitHub has to uninstall (losing their pairing and local
> data) before they can install from Play.

- [ ] Our key uploaded and accepted

---

## 3. Store listing (≈8 min)

**Grow users → Store presence → Main store listing**

**App name**
```
OpenMausBot
```

**Short description**
```
Chat with the AI bots running on your own computer, straight from your phone.
```

**Full description**
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

**Graphics** — all in `android/PlayStore/assets/`:

| Slot | File |
| --- | --- |
| App icon (512×512) | `assets/play-icon-512.png` |
| Feature graphic (1024×500) | `assets/feature-graphic-1024x500.png` |
| Phone screenshots | `assets/screenshots/01-threads.png` … `05-updates.png`, in that order |

Leave tablet screenshots empty. Play then shows a "not designed for tablets"
note on tablet listings, which is accurate — don't claim tablet support to
avoid it.

- [ ] Listing saved

---

## 4. Store settings (≈2 min)

**Grow users → Store presence → Store settings**

| Field | Value |
| --- | --- |
| App category | Productivity |
| Tags | AI assistant, chat, remote control, developer tools (pick nearest matches) |
| Email address | `omkar@supamaus.com` |
| Website | `https://openmausbot.com` |
| Phone | optional — leave blank unless you want support calls |
| External marketing | leave off |

- [ ] Saved

---

## 5. App content — the declarations (≈12 min)

**Monitor and improve → Policy and programmes → App content**
(each one is a separate task with its own **Start** button)

### 5.1 Privacy policy
```
https://openmausbot.com/privacy
```
Live as of 18 September 2026 — verified.

### 5.2 App access
Choose **All or some functionality is restricted**. Add one instruction set:

- Name: `Pairing required — companion app`
- Username / password: leave blank, tick *no credentials required* if offered
- Instructions:
```
This app is a companion for the OpenMausBot desktop app and cannot be used on
its own. To test it: install the free desktop app from https://openmausbot.com
(macOS, Windows, or Linux), open it, go to Settings > Phone, and choose "Set up
a phone" to show the pairing QR code. Scan that code with this app on a phone on the same Wi-Fi
network. No account or purchase is required. A demo video of the paired flow is
available on request at omkar@supamaus.com.
```

> Skipping this is the single most common cause of a first-review rejection for
> a companion app: the reviewer opens it, sees a pairing screen, and fails it as
> broken.

### 5.3 Ads
**No**, the app contains no ads.

### 5.4 Content ratings
Start the questionnaire.

- Email: `omkar@supamaus.com`
- Category: **Utility, productivity, communication, or other**
- Violence, sexuality, profanity, controlled substances, gambling, crude
  humour: **No** to all
- **Does the app allow users to interact or communicate with other users?**
  → **Yes**. Rooms on a shared team server can carry another person's messages.
  Follow-ups: content is **not** publicly broadcast, there is **no** location
  sharing, and users **cannot** exchange personal information openly.
- **Moderation / reporting:** the app has no in-app report or block control
  today. Answer honestly.

> This is the one answer I could not decide for you. Saying No would be simpler
> and would be false — rooms exist. If the reviewer pushes back on the missing
> report control, the cheap fix is a "Report a message" item in the message
> action tray that emails omkar@supamaus.com, then re-submit.

### 5.5 Target audience and content
- Age groups: **18 and over** only.
- Appeal to children: **No**.

> Ticking any under-18 band pulls the app into Families policy, which the camera
> and microphone surfaces make expensive to satisfy.

### 5.6 Data safety
- Does your app collect or share any of the required user data types? → **Yes**
- Is all user data encrypted in transit? → **Yes**
- Do you provide a way for users to request data deletion? → **Yes**,
  URL: `https://openmausbot.com/privacy`

Declare exactly **one** data type:

| Field | Answer |
| --- | --- |
| Data type | Personal info → **Email address** |
| Collected | Yes |
| Shared | No |
| Processed ephemerally | No |
| Required or optional | **Optional** (only if the user enables hosted access) |
| Purpose | **Account management** |

Everything else: **not collected**. Messages and photos stay on the user's own
computer; the pairing token stays in the device's encrypted store; there are no
analytics or advertising SDKs; the installation IDs we hold belong to the
desktop install, not the phone. Data that only passes through a relay in transit
without being stored does not count as collected under Play's definition.

### 5.7 The remaining small ones
- Government apps: **No**
- Financial features: **None of these**
- Health: **No**
- News app: **No**
- Advertising ID: **No, my app does not use advertising ID**

- [ ] Every App content task shows **Completed**

---

## 6. Production release (≈5 min)

**Test and release → Production → Create new release**

1. Upload `app-release.aab`. Confirm it reads **version 1.4.0 (10400)**.
2. Release name: `1.4.0`
3. Release notes (`en-US`):
```
Call a bot from your phone and set a voice key from the device. A cross-bot
inbox shows every thread waiting on you, and queued messages now appear while
they send. Archive threads you are done with. Fixes: the keyboard's Return key
inserts a newline instead of sending, the composer keeps its shape as a draft
grows, and an open thread reloads its history after a reconnect.
```
4. Countries: **Add countries/regions → Select all**, unless you want a narrower
   launch.
5. Rollout: set **staged rollout to 20%**, not 100%. Watch the crash-free rate
   and Discord for a day, then raise it. A full-stop halt is only possible while
   a rollout is staged.
6. **Save → Review release → Start rollout to Production**.

- [ ] Sent for review

---

## 7. After submitting

- First review of a brand-new app usually takes a few days, sometimes longer.
  Later updates are typically hours.
- As an organisation account you are exempt from the 12-testers-for-14-days
  closed testing rule. If the console ever asks for it, something is wrong with
  the account type — check before working around it.
- Watch **Policy status** and the email on the account for rejections.
- Once live, add the Play badge to openmausbot.com/download and the repo README.
- Tag the release in git to match what shipped:
  `git tag android-v1.4.0 && git push origin android-v1.4.0`
  (the branch `android-release/v1.4.0` is still unpushed).

## Likely rejection reasons, and the fix

| If they say | It means | Fix |
| --- | --- | --- |
| "App does not function" / stuck on pairing | App access instructions ignored or missing | Re-check §5.2, add the demo video |
| Data safety mismatch | The declaration disagrees with what the binary does | Re-read §5.6; the privacy policy must agree with it |
| UGC / moderation | No report or block path | Add "Report a message" to the action tray, resubmit |
| Broken functionality on a tablet | Tablet screenshots implied support | Remove tablet screenshots |
