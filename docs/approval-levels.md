# Approval levels

Approval levels belong to a bot and apply to its next provider turn, including
when that provider resumes an existing native thread.

| Level | Behavior |
| --- | --- |
| **Ask for approval** | The provider asks before actions outside its normal workspace or network permissions. |
| **Approve for me** | OpenMausBot approves ordinary permission requests. Potentially destructive or sensitive actions, unattended work, and questions still wait for you. |
| **Full access** | Codex only. Codex runs without its native sandbox or approval prompts, including destructive, sensitive, unattended, and selected-computer actions. Normal question cards still wait for you; unsupported structured forms are declined. |
| **Custom (`config.toml`)** | Codex only. OpenMausBot reads and reapplies the effective approval and sandbox settings from your Codex configuration. |

Full access is an elevated-risk standing approval. Full and Custom can only be
enabled from a packaged local desktop app, where the choice crosses a private
process channel rather than the bot-accessible HTTP API. They are hidden in
development, standalone web, and remote pages. Full access does not bypass operating
system privacy controls, authentication, CAPTCHA or MFA, service permissions,
or OpenMausBot's separate confirmations for credentials, routines, skills, and
peer communication.

Existing bots that used the old **Auto mode** keep the same behavior under
**Approve for me**. They are never migrated to Full access automatically.
The selected bot level also overrides older provider-instance bypass settings
for each app turn, so **Ask for approval** cannot silently inherit a Grok,
Cursor, Claude, or other engine's legacy full-auto mode.
