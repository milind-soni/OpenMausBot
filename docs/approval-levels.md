# Approval levels

Approval levels belong to a bot and apply to its next provider turn, including
when that provider resumes an existing native thread.

| Level | Behavior |
| --- | --- |
| **Ask for approval** | The provider asks before actions outside its normal workspace or network permissions. |
| **Approve for me** | Uses native automatic review on Codex, Claude, Cursor, and Grok. Other providers fall back to Ask. Requests a running native reviewer leaves for you are not overridden by OpenMausBot, except by an **Always allow** answer you recorded for that exact command or tool. When Claude reports that its reviewer never started (see below), OpenMausBot approves routine actions itself and still asks about destructive or sensitive ones. Unattended Auto runs use Ask. |
| **Full access** | Enables the provider's permissive mode for commands, edits, and selected-computer actions, including potentially destructive or sensitive work. Applies to this bot's direct, scheduled, and delegated work (ask_bot, delegate_bot); delegation uses the receiving bot's setting, never the sender's. Some providers still ask for approval. Questions and separate OpenMausBot confirmations still wait for you. |
| **Custom (`config.toml`)** | Codex only. OpenMausBot reads and reapplies the effective approval and sandbox settings from your Codex configuration. |

Full access is an elevated-risk standing approval. Full and Custom can only be
enabled from a packaged local desktop app, where the choice crosses a private
process channel rather than the bot-accessible HTTP API. They are hidden in
development, standalone web, and remote pages. Full access does not bypass operating
system privacy controls, authentication, CAPTCHA or MFA, service permissions,
or OpenMausBot's separate confirmations for credentials, routines, skills, and
peer communication.

### Antigravity: Ask or Auto

For Antigravity, the composer and bot settings offer **Ask for approval** and
**Auto (full access)**. Auto enables native `yolo` mode and automatically approves
remaining tool-permission requests for commands, edits, and computer actions,
without an automatic reviewer. The composer chip reads **Auto**. This uses the
existing Full access grant and confirmation, not a separate permission setting,
and applies to every model in that Antigravity instance, including Gemini.

Choose Auto explicitly in the local packaged desktop app. Old Antigravity
`auto` / `autoApprove` settings still behave as Ask and are now displayed as Ask;
they never become unrestricted access on upgrade. Existing Full access bots
now automatically answer remaining tool-permission requests too. Switching back
to Ask restores prompts on the next turn. Questions, credential forms, and the
separate confirmations described above still require an answer. A Chief or
teammate can delegate work to this bot without downgrading its explicit Auto
(full access) grant. This includes destructive commands and sensitive files:
enable it only for bots you trust to run that work unattended. It does not
enable Auto on any other bot, and the legacy Auto setting is not upgraded.

Existing bots that used the old **Auto mode** keep that selection under
**Approve for me** (except Antigravity, as described above), but now use native
review rather than the app's heuristic auto-approval. Providers without native
review ask instead. No bot is migrated
to Full access automatically.
The selected bot level also overrides older provider-instance bypass settings
for each app turn, so **Ask for approval** cannot silently inherit a Grok,
Cursor, Claude, or other engine's legacy full-auto mode.

## Provider mappings

| Provider | Auto | Full access |
| --- | --- | --- |
| Codex | Native automatic reviewer; workspace sandbox | No native approval prompts; unrestricted native sandbox |
| Claude | Native `auto` mode; safe Auto when the CLI starts in Manual instead | Native `bypassPermissions` |
| Cursor | Native `--auto-review` | Native `--force` |
| Antigravity | Legacy `auto` behaves as Ask; UI Auto selects Full access | Native `yolo` plus automatic approval of remaining tool-permission requests; shown as Auto |
| Grok Build | Native `--permission-mode auto`; availability of Grok's reviewer depends on its feature rollout | Native `bypassPermissions`; remaining native requests still appear |
| OpenCode | Ask | Approve individual ACP permission requests, never task questions |
| Other/custom engines | Ask | Not offered until a provider mapping is implemented |

These settings apply on each turn, including resumed conversations. Switching
to a different provider while elevated requires leaving Full/Custom first;
choose Ask. Switching models within Antigravity keeps the selected level.
Native modes require a CLI version that supports them; OpenMausBot does not
silently substitute unrestricted access when a mode is rejected.

### When the native reviewer never starts

Claude Code accepts `--permission-mode auto` for every model and, when auto
mode is unavailable to the session, starts in Manual without an error. On
Claude Code 2.1.266 that is the case for Claude Haiku 4.5 and Sonnet 4.5,
and for any organization that set `disableAutoMode`. In that session every
tool call reaches OpenMausBot as a permission request, and until now each one
became a card: a bot on **Approve for me** asked before `wc -l` in its own
workspace.

The Claude driver reads the mode the session actually runs in from the CLI's
`init` frame and marks each request accordingly. When Auto was requested and
the session runs Manual, **Approve for me** answers the way it did before native
review existed: routine commands, edits, and tool calls are approved by
OpenMausBot, the destructive and sensitive guards still card, unattended turns
still ask, and the chat shows one notice per session naming the model the
reviewer is unavailable for. Each approval is written to the decision log with
the rule `native-review-inactive`. A request from a reviewer that is known to be
running is still never answered by the app.

Grok and Codex do not report whether their reviewer ran, so their requests
still reach you. For those, **Always allow** on a card now records an answer
that stands in next time the same command or tool is asked about, unless a
guard applies. This mirrors the remembered-approval behavior other harnesses
offer for Grok. It is never offered for computer control or a sandbox change,
and never over a reviewer Claude reports as running.

### Read-only integration tools

OpenMausBot's built-in agents MCP server now describes nine scoped reads with
explicit read-only, non-destructive, idempotent, closed-world metadata:
`list_bots`, `list_rooms`, `list_threads`, `check_delegation`, `wait_delegation`,
`session_search`, `session_read`, `list_routines`, and `skills_list`.
Session recall still enforces own-bot access and records its existing room
disclosure audit. These hints do not grant access to another bot's conversations.
Writes, credential requests, proposals, and third-party tools do not inherit
these hints. The metadata is available to every engine using this integration;
whether an engine consumes it remains that engine's behavior.

Grok previously launched Auto as `default`, making the setting behave like Ask
even on a CLI with automatic review. Auto now passes `auto` on every turn,
including resumed sessions and custom/local models run through Grok. This mapping
was checked against Grok 1.0.3's CLI help and the [official permission documentation](https://docs.x.ai/build/features/permissions).
Grok can still disable its reviewer through provider-side feature gating or
managed policy; OpenMausBot never changes that into bypass-permissions.

The fix does not make every operation silent: native denials, permission
escalations, questions, and separate OpenMausBot confirmations remain intact.
Arbitrary MCP display titles or `readOnlyHint` claims from a third-party server
are not authorization to bypass a prompt. Claude, Codex, and Pi's existing
built-in integration routes remain unchanged.

The mapping follows the provider-boundary approach in
[T3 Code's permission modes](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/user/permission-modes.md).
Its [Grok adapter](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/apps/server/src/provider/acp/GrokAcpSupport.ts#L29-L41)
also maps Auto to `--permission-mode auto`. This is an engine setting, not a
per-model allowlist. T3 likewise falls back to asking on providers without native
Auto; its quieter default is Full access, not a universal safe-action classifier.
OpenMausBot keeps its own opt-in desktop confirmation; Full access is not the default.
T3's separate Grok "Always allow this session" remembers explicitly approved
matching commands/tool inputs. That is not a grant for every tool sharing a
display name, and this patch does not introduce a new remembered-approval mode.

## Verification for contributors

Run `pnpm exec electron scripts/smoke-approval-modes.cjs` to exercise the real
private desktop-to-server grant protocol in a disposable fixture. It verifies
HTTP elevation rejection, Full → Auto → Ask on resumed Claude turns, and
Antigravity automatic tool approvals on new and resumed Full access turns across
multiple model variants. It also checks that Ask and legacy Auto still prompt,
peer-started Full turns auto-approve, switching the receiving bot back to Ask
restores prompts even for a Full-access sender, delegated Codex Custom uses the
native Auto reviewer consistently, and questions remain interactive. Provider
processes are scripted fakes; this does not verify live account eligibility or
the quality of a provider's automatic reviewer. No live user data is used.
Grok coverage exercises two model selections across fresh/resumed Auto turns,
real built-in MCP reads under a scripted native reviewer, returning to Ask,
and held deletion, credential, spoofed-title command, and question requests.
