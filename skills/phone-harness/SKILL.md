---
name: phone-harness
description: "Control, inspect, test, or automate a physical Android phone connected to OpenMausBot over authorized USB debugging. Use for explicit Android, USB phone, ADB, mobile-app, tapping, typing, swiping, scrolling, screenshot, or phone-screen requests."
---

# Phone Harness

Use the `phone` tools for every requested Android action. Never replace them
with Bash, raw `adb`, `subprocess`, an emulator, network ADB, or Tailscale.

1. Call `status` before the first action. If the device is missing or
   unauthorized, stop and relay the physical setup instruction.
2. Call `open_app` with the human app name. Do not scan the launcher first.
   Use `list_apps` only when the name is ambiguous.
3. Call `read_screen` before choosing a target and after every action. Prefer
   `tap_text`; use `screenshot` and pixel `tap` only when accessibility text
   cannot identify the target.
4. Use `swipe`, `type_text`, and `press` for interaction, verifying each step.

The tools operate the user's real phone. Navigate and read only what the task
needs. Stop before sending, posting, purchasing, booking, deleting, changing
settings, entering protected information, or accepting an unexpected legal or
security prompt unless the user has explicitly authorized that exact action.

Never enter passwords, payment details, government identifiers, or one-time
codes. Ask the user to complete protected-input steps directly on the phone.
