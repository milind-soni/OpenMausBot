# Approval levels

Approval levels belong to a bot and apply to its next provider turn, including
when that provider resumes an existing native thread.

| Level | Behavior |
| --- | --- |
| **Ask for approval** | The provider asks before actions outside its normal workspace or network permissions. |
| **Approve for me** | Uses native automatic review on Codex, Claude, and Cursor. Other providers fall back to Ask. Requests the native reviewer leaves for you are not overridden by OpenMausBot. Unattended Auto runs use Ask. |
| **Full access** | Enables the provider's permissive mode for commands, edits, and selected-computer actions, including potentially destructive or sensitive work. Some providers still ask for approval. A turn another bot starts (ask_bot, delegate_bot) runs as **Approve for me** instead, so a teammate cannot hand a Full bot a destructive command with nobody watching. Questions and separate OpenMausBot confirmations still wait for you. |
| **Custom (`config.toml`)** | Codex only. OpenMausBot reads and reapplies the effective approval and sandbox settings from your Codex configuration. |

Full access is an elevated-risk standing approval. Full and Custom can only be
enabled from a packaged local desktop app, where the choice crosses a private
process channel rather than the bot-accessible HTTP API. They are hidden in
development, standalone web, and remote pages. Full access does not bypass operating
system privacy controls, authentication, CAPTCHA or MFA, service permissions,
or OpenMausBot's separate confirmations for credentials, routines, skills, and
peer communication.

Existing bots that used the old **Auto mode** keep that selection under
**Approve for me**, but now use native review rather than the app's heuristic
auto-approval. Providers without native review ask instead. No bot is migrated
to Full access automatically.
The selected bot level also overrides older provider-instance bypass settings
for each app turn, so **Ask for approval** cannot silently inherit a Grok,
Cursor, Claude, or other engine's legacy full-auto mode.

## Provider mappings

| Provider | Auto | Full access |
| --- | --- | --- |
| Codex | Native automatic reviewer; workspace sandbox | No native approval prompts; unrestricted native sandbox |
| Claude | Native `auto` mode | Native `bypassPermissions` |
| Cursor | Native `--auto-review` | Native `--force` |
| Antigravity | Ask | Native `yolo`; remaining native requests still appear |
| Grok Build | Ask | Native `bypassPermissions`; remaining native requests still appear |
| OpenCode | Ask | Approve individual ACP permission requests, never task questions |
| Other/custom engines | Ask | Not offered until a provider mapping is implemented |

These settings apply on each turn, including resumed conversations. Switching
to a different provider while elevated requires choosing Ask or Auto first.
Native modes require a CLI version that supports them; OpenMausBot does not
silently substitute unrestricted access when a mode is rejected.

The mapping follows the provider-boundary approach in
[T3 Code's permission modes](https://github.com/pingdotgg/t3code/blob/bc8584bf8e967ecc1cd215d42bd7a47faf51a862/docs/user/permission-modes.md).
OpenMausBot keeps its own opt-in desktop confirmation; Full access is not the default.

## Verification for contributors

Run `pnpm exec electron scripts/smoke-approval-modes.cjs` to exercise the real
private desktop-to-server grant protocol in a disposable fixture. It verifies
HTTP elevation rejection, Full → Auto → Ask on resumed Claude turns, and
Antigravity approval cards that remain answerable even in Full access. Provider
processes are scripted fakes; this does not verify live account eligibility or
the quality of a provider's automatic reviewer. No live user data is used.
