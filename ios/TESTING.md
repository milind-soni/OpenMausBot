# Testing the companion locally

The automated stages have been run on a Mac and simulator, and the network
stages on an iPhone. Keep this as the runbook for the next machine and release.

Stages, cheapest signal first. Each one is worth completing before starting the
next — a Swift compile error found in stage 1 costs a minute, the same error
found while chasing a Bonjour problem on a phone costs an hour. Stage 5 is the
way out when the network itself is the problem.

## What you need

| Stage | Needs |
|---|---|
| 1 — core tests | a Mac with Xcode command line tools (`xcode-select --install`) |
| 2 — desktop half | + Node 24+, pnpm, and one agent CLI (`claude`, `codex`, or `grok`) signed in |
| 3 — simulator | + full Xcode and XcodeGen |
| 4 — end to end | + an iPhone on the same Wi-Fi as the Mac |
| 5 — off this network | + Tailscale on both, same account |

Stages 1 and 2 are worth doing even if you never get to a phone: stage 1 is
where the Swift errors are, and stage 2 exercises the companion listener the
desktop app now ships.

---

## Stage 0 — get the code

Use current `main` after the companion lands. While reviewing the feature PR,
GitHub CLI can create the correct local branch:

```sh
git clone https://github.com/milind-soni/OpenMausBot
cd OpenMausBot
gh pr checkout 161        # omit after the PR is merged
```

Sanity check — `ios/` and the companion sidecar should be present:

```sh
ls ios/Sources/CompanionCore companion/src/devices.ts companion/src/mdns.ts
```

---

## Stage 1 — the core compiles and its tests pass

No full Xcode, simulator, or phone is required. This is the cheapest place to
catch wire-model, parser, and state-fold regressions.

```sh
cd ios
swift build
swift test
```

`Sources/` is the only product `swift test` builds; `App/` is compiled in
stage 3.

A trailing `Test run with 0 tests in 0 suites passed` is expected and not a
problem: that is swift-testing finding none of its own tests, because these are
XCTest.

**What passing means.** The decoding tests read
`Tests/CompanionCoreTests/Fixtures/*.json`, which were captured from a real
running harness. Green means the client agrees with what the server actually
sends — not with anyone's memory of it.

If a decoding test fails while the others pass, suspect the fixture is stale
before suspecting the model: re-capture with
`node scripts/capture-companion-fixtures.mjs` from the repo root and read the
diff.

---

## Stage 2 — the desktop side, on its own

Prove the harness half works before a phone is in the picture.

```sh
pnpm install
pnpm build:companion      # required once before the dev toggle can start it
pnpm dev                  # 127.0.0.1:5199
pnpm dev:desktop          # Electron starts the harness
```

In the app: **Settings → Companion**. Turn it on. You should see either

- *"Your phone will find this computer as …"* — Bonjour is advertising, or
- *"Listening on 192.168.x.x:8810 — enter that on your phone."* — it is not.

Both are workable; the second just means typing an address. Then **Start
pairing** and check the six-digit code counts down and cancels cleanly.

Verify from a second terminal that the socket is real and refuses strangers:

```sh
curl -s http://192.168.x.x:8810/api/bots            # expect 401 + "pair this device…"
curl -s http://127.0.0.1:8811/state | jq            # addresses, pairing, devices, discovery
dns-sd -B _openmausbot._tcp                         # macOS: should list the service
```

### If discovery says it is not advertising

This is the likeliest snag on macOS, and it is not a bug in the phone.

- **Port 5353 is owned by mDNSResponder.** The sidecar asks for `SO_REUSEADDR`
  and normally shares it fine, but if something else grabbed it exclusively the
  advertisement cannot start. `sudo lsof -i :5353` shows who.
- **The firewall is prompting.** System Settings → Network → Firewall. Incoming
  connections to `node`/OpenMausBot must be allowed, or the phone reaches
  nothing on 8810 even with a correct address.
- Neither blocks testing: use the typed address instead. Discovery failing is
  designed to be a fallback, not a dead end — that is worth confirming too.

---

## Stage 3 — build and launch the simulator

```sh
brew install xcodegen
cd ios && xcodegen generate && open OpenMausCompanion.xcodeproj
```

Build for the simulator first — it is a faster loop for compile errors.
The same gate can run without opening Xcode:

```sh
xcodebuild -project OpenMausCompanion.xcodeproj \
  -scheme OpenMausCompanion \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CODE_SIGNING_ALLOWED=NO build
```

That command is a compile gate only. **To actually pair in the Simulator**,
build with a team and local signing instead — without an
`application-identifier` entitlement the Simulator's keychain refuses the
device token with "A required entitlement isn't present", right after the
code is accepted:

```sh
xcodebuild -project OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  DEVELOPMENT_TEAM=<your team id> CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual build
```

No provisioning profile is involved for the Simulator; the team id only
makes Xcode emit the entitlement. Bonjour works from the Simulator (it
shares the Mac's network), so **On this network** lists the Mac — tap it and
type the code; there is no camera for the QR path.

**Re-run `xcodegen generate` whenever a pull adds a file to `App/`.** The
generated project lists source files explicitly, so a new one is missing from
the target until you regenerate, and the build fails with `Cannot find 'X' in
scope` — which looks like a code error and is not one.

### If the app is letterboxed inside black bars

Everything drawn oversized, content floating in the middle of the screen, black
above and below: that is iOS compatibility scaling, and it means the built
Info.plist has no `UILaunchScreen` key. Check the built product rather than the
spec — `plutil -p` the Info.plist inside the .app — because
`INFOPLIST_KEY_UILaunchScreen_Generation` is *silently ignored* for a target
that supplies its own Info.plist, which is how this shipped the first time.

Then switch to a **real device**. The simulator shares the Mac's network stack,
so Bonjour there proves less than it appears to, and the local-network
permission prompt behaves differently. Signing needs a free Apple ID team; no
paid account is required to run on your own phone.

---

## Stage 4 — the thing actually working

On the phone, in order:

1. **Pair.** In OpenMausBot → Settings → Companion, choose **Set up a
   phone**. Scan the QR code with the phone's Camera, open OpenMausMobile,
   confirm that the computer and six-digit code are filled in, then tap
   **Connect**. The computer should also appear by name for the manual path:
   tap it and type the same code.
   - Relaunch the app after pairing once. It should return to the roster
     without asking for another code; that proves the device token made it
     into Keychain rather than only living in memory.
   - If the list stays empty, check in this order:
     1. **Local Network permission.** iOS asks once, and a denial is
        permanent and silent. Settings → OpenMausBot → Local Network. If the
        toggle is not even there, the prompt never fired — which points at the
        Info.plist. Deleting the app and reinstalling resets the decision and
        asks again.
     2. **The built Info.plist** actually carries
        `NSLocalNetworkUsageDescription` and `NSBonjourServices`. Without them
        `NWBrowser` returns nothing at all, silently, and it looks exactly like
        an empty network: `plutil -p` the Info.plist inside the built .app.
     3. **The phone and the Mac are on the same Wi-Fi.** Check the actual
        SSID on both, not just "is Wi-Fi on" — one device on the guest network
        and the other on the main one is the single most common cause, and the
        two look identical from the phone. Bonjour is multicast: it does not
        cross subnets, and guest networks usually isolate clients from each
        other on top of that, which blocks the typed address too. Cellular
        carries no Bonjour either, so a phone that fell back to 5G finds
        nothing. Settings → Wi-Fi → ⓘ shows the phone's IP; if it is not on
        the same /24 as the Mac, that is the answer.
   - Then use the typed address as a fallback and keep going. Pairing by
     address exercises everything except discovery.
   - **If the typed address does not work either**, stop diagnosing the
     network and go to stage 5. When both devices are demonstrably on the
     same SSID and neither discovery nor a typed address gets through, the
     network is isolating its clients and there is nothing to fix on either
     machine.
2. **The roster loads**, matching what the desktop shows.
3. **Send a message** from the phone. It should appear on the desktop too — same
   harness, two clients.
4. **The approval.** This is the whole product. Ask a bot to do something that
   needs permission (`run \`ls\` in my home directory` is enough for most
   engines). The card should reach the phone; answering it there should
   unblock the bot on the laptop.
5. **Reconnect.** Background the app for a minute while the bot keeps working,
   then come back. The transcript should catch up *without* a visible reload —
   that is the resumable stream doing its job. Watch the harness log to confirm
   it replayed rather than re-hydrated.
6. **Revoke.** Remove the device in Settings → Companion on the computer. The
   phone should land on "This phone was unpaired" rather than silently failing.

---

## Stage 5 — off this network, via Tailscale

Everything above assumes the phone and the Mac can reach each other directly.
Sometimes they cannot, and no amount of checking the SSID fixes it: a guest
network that isolates its clients will let both devices online, show them the
same network name, and still drop every packet between them. Bonjour finds
nothing and the typed address times out, which reads exactly like a broken app.

Tailscale makes that class of problem go away rather than diagnosing it. Both
devices join a private network of your own and get an address in `100.64.0.0/10`
that does not depend on which Wi-Fi either of them is on — or on Wi-Fi at all,
so this is also how the phone reaches the Mac over cellular.

1. **On the Mac:** install Tailscale (`brew install --cask tailscale`, or the
   App Store build) and sign in.
2. **On the phone:** install Tailscale from the App Store, sign in to the *same*
   account, and turn the VPN on.
3. **In OpenMausBot → Settings → Companion:** with the toggle on, the panel now
   prints the tailnet name — something like `macbook.tail1234.ts.net:8810`, with
   the LAN address listed separately underneath. If it still only shows a
   `192.168.x.x` address, the sidecar could not find the Tailscale CLI — it
   asks once at startup, so turn the Companion toggle off and on again (or
   restart `pnpm companion` if running it by hand) after Tailscale is up.
4. **On the phone:** scan the Companion panel's QR code, which carries that
   MagicDNS name, or pair by typing the name. Discovery does not help here —
   Bonjour is multicast and a tailnet does not carry it — so the QR/manual
   address is the path, and it is the one path that works from anywhere.

**Use the name, not the address.** Both reach the harness, but only the name
gets past App Transport Security. iOS exempts local networking, and `100.64/10`
is CGNAT space rather than one of the private ranges that exemption covers, so
a plain-HTTP request to a bare tailnet address is refused by the OS before it
reaches the network. `ios/project.yml` exempts `ts.net` by name instead. The
symptom if you use the address anyway is a connection that fails instantly with
a policy error rather than a timeout.

Once paired over a tailnet, nothing else changes: the same stream, the same
approvals, the same reconnect behaviour. It is the same listener on the same
port — only the route to it is different.

---

## What is expected not to work

Not built yet, so not bugs:

- **Nothing arrives after the app is terminated.** Live and replayed notification
  frames now become native alerts and badges, but closed-app push still needs an
  APNs relay with project-owned Apple credentials.
- **No voice or routine management.** Tasks, SQLite transcript search/export,
  reactions, and edit/version switching are available from the conversation UI.

(Two entries that used to sit on this list have since shipped: replies stream
token by token as the provider emits them, and each bot has a computer panel —
open it from the chat and frames arrive for exactly as long as it is on
screen.)

## If the phone sits on "Connecting…"

The two sides now say what they think is happening, and comparing them is
usually the whole diagnosis:

- **Desktop/server log:** the sidecar and harness record the stream opening and
  closing. No opening entry means the request never arrived.
- **Xcode console**, subsystem `com.openmausbot.companion`: `opening stream`,
  then `stream live, resumed=…`, then `hydrated N bots`. Whichever of those is
  missing is where it stopped.

Opened on the server but never live on the phone means the bytes are not
reaching the client. Never opened means the request never left it. A repeating
`opened` / `closed` pair on the server with `stream failed: cancelled` on the
phone means the client is tearing its own connection down — that was a real bug
(`URLSession.AsyncBytes` cancels its task when the sequence is released), and
`EventStreamTests` now guards against its whole class.

## Reporting back

For Swift errors, the compiler's own output is the most useful thing — file,
line, and message. For runtime problems, the harness log is usually more
informative than the phone: it is where the pairing, auth and stream decisions
are actually made.
