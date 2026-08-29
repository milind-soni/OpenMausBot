# Agent Centipede for Android

A native Android companion for the Agent Centipede desktop app. The computer remains the source of truth and owns agents, transcripts, credentials, routines, and computer sessions. The phone uses the existing restricted companion sidecar.

## What is included

- QR and manual pairing with explicit route confirmation
- Android Keystore encryption for the long-lived paired-device token
- Credential route pinning for hosted HTTPS, Tailscale, or one exact trusted-LAN origin
- Agent roster, conversations, sending, approvals/questions, and interrupt
- Routine list with pause/resume and run-now controls, including interval schedules
- Foreground live updates, Android notifications, and reconnect hydration
- Opt-in, read-only live agent-computer screen
- Recent routine run history with success, failure, output, and manual/scheduled status
- Replay-safe phone alerts when the live event stream reconnects
- Dynamic Material 3 light/dark design

The companion cannot read or update provider API keys, manage paired devices, drive the host computer, call internal agent routes, or reach future server routes by default. Those limits are enforced by `companion/src/routes.ts`, not only by this UI.

## Build

Use Android Studio or command-line Gradle with JDK 17 and Android SDK 36:

```powershell
cd android
.\gradlew.bat testDebugUnitTest assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`.

## Pair

1. Start Agent Centipede on the computer.
2. Open **Settings → Phone**, enable phone access, and create a pairing QR.
3. Open Agent Centipede on Android, scan the QR, verify the computer and transport, then connect.
4. For manual trusted-LAN pairing, enter the displayed address and six-digit code.

The computer must be awake and Agent Centipede must be running. Hosted HTTPS or Tailscale is recommended away from a trusted home network.
