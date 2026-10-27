# Approval levels

Approval levels belong to a bot and apply to its next provider turn, including
when that provider resumes an existing native thread. You can also change one
while the bot is working (see below). Each level is one of the
provider's own permission modes, passed through. A native tool request that
reaches you is one the provider left for you. OpenMausBot only answers from an
explicit grant: Full Access, a saved exact command or MCP read-shaped tool, or
the narrow built-in web-search allowance under Approve for me. In Full Access,
OMB also applies its own configuration tools without another approval.

Every bot and conversation starts at **Full access**, the default T3 Code uses
too: each engine runs in its own most permissive mode, and a real question or
a missing credential still reaches you. That covers a bot made in New bot,
through the API or by onboarding, each new thread, a Chief's new teammates,
and bots imported from a team backup, a shared team file or the organization
library. A level a person picks stays until someone changes it. On a hosted
company workspace the default stays Ask, because Full access there comes only
from the operator's dedicated policy.

| Level | Behavior |
| --- | --- |
| **Ask for approval** | Requests approval for commands and file changes, the way the provider's supervised mode does. |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval. Offered where the provider has such a mode (Claude, Grok, Antigravity). |
| **Approve for me** | Uses the provider's automatic review on Codex, Claude, Cursor, and Grok to approve routine actions and ask about others. Providers without an equivalent fall back to asking. |
| **Full access** | Enables the provider's permissive mode for commands, edits, and selected-computer actions, including potentially destructive or sensitive work. Residual native permission prompts are answered for you. OMB profile changes, routine actions, team setup, bot deletion, and enabled skill authoring apply without a second approval. Peer-review prompts are skipped within the bot's authorized scope. Sends through connected apps (email, messages, posts, payments) go out without the "Send on your behalf?" card or a daily allowance; apps outside the bot's connected-app scope are still refused. Work handed on with `coordinate_bots` uses the receiving bot's setting, never the sender's — except from a Chief of Staff, whose level flows down (below). Actual questions and missing credentials still need your input. |
| **Custom (`config.toml`)** | Codex only. OpenMausBot reads and reapplies the effective approval and sandbox settings from your Codex configuration. |

Full access applies the moment you pick it: no confirmation dialog, no second
step. It can be turned on from any client that can reach the app's API: the
desktop app, a browser, a paired phone or web client, or a bot or script
calling the local API where local calls count as you (development, the CLI, a
self-hosted server). Picked in bot settings, it applies to the bot and every
one of its existing threads at once; picked in the composer, to that thread;
Refresh permissions copies it onto one thread. Every engine runs it (see
Provider mappings). On a hosted company workspace, Full access still comes
only from the operator's dedicated policy
([guarded messages](verification/guarded-messages.md)).

Custom is different: it can only be entered or left from a packaged local
desktop app, where the choice crosses a private process channel rather than the
bot-accessible HTTP API, because it holds restrictions you wrote yourself. It
is hidden in development, standalone web, and remote pages.

### Changing the level while the bot works

You don't have to stop a bot to change its level. From the moment you pick
one, every approval decision OMB makes in that conversation uses it. How far
that reaches depends on who runs the tools:

- **API engines** (OpenAI-compatible, Grok API, MiniMax, Mistral, Cerebras,
  Groq, Meta): OMB's tool gate reads the level before each tool call, so the
  change applies from the next call, up or down.
- **Engines with their own modes** (Codex, Claude, Cursor, Antigravity, Grok
  Build, Qwen Code, Gemini CLI, Droid, Pi's custom MCP tools): the engine got
  its mode when the turn started and keeps it to the end of the turn. A
  permission request it still sends is answered at the new level, so raising
  to Full access applies to the next request. Lowering from Full access, and
  moving between Ask, Auto-accept edits and Approve for me, applies from the
  next turn.
- **Agents whose requests OMB answers** (OpenCode, Cline, Kimi, Hermes, custom
  ACP agents, Pi's computer-control confirms): every request reaches OMB, so
  the change applies from the next request, up or down.

A request already on screen stays for you to answer, and an action already
running finishes. A team change sets the level on working bots too.

A department's sidebar menu has **Set for all bots in this department…**, for the owner
or an admin. It sets one approval level (Ask, Auto-accept edits, Approve for
me or Full access), or one model and effort, on every bot in that department. It
lists what each bot will get before anything changes, then saves the bots one
at a time with the same request and checks as each bot's own settings. A bot
whose engine does not offer the level, model or effort, or that is working
during a model change, is skipped and the summary gives the reason. A skipped bot is not changed
later: once its turn ends, run the team change again or set that bot in its
own settings. A level reaches each bot and every one of its threads, the same
way for every level, so a thread opened with New thread moves too; a bot is
"already set" only when all of its threads are. Choosing Auto for a bot on
this computer shows the same warning as its own settings. Model changes keep
each bot on its own engine and move the threads that use the bot's model; a
thread with a model of its own keeps it, including the one open on screen
(the bot's own settings, by contrast, move that thread with the bot). Custom
stays a per-bot setting: a bot or thread on Custom leaves it only in the
desktop app.

Full access does not bypass operating system privacy controls,
authentication, CAPTCHA or MFA, service permissions,
or workspace/team ownership and computer-sharing grants. Full Access controls
approval prompts; it does not sign in for you, enable a feature you disabled,
or grant another bot access to a different workspace.

The effective setting belongs to the source conversation. An existing Ask
thread remains Ask even if the bot default is Full; a Full thread works
without these extra prompts even if the bot default is Ask. A bot nobody has
set a level on follows the default, and so does each of its threads without a
level of its own. Bots and threads that saved Ask before Full access became
the default keep it: choose Full access in the bot's settings, or **Set for
all bots in this team…**, to move a bot and every one of its threads at once.
OpenMausBot adds no review card of its own at any level: a bot's profile,
working folder, model, skill, team setup and team memory changes apply at
once and leave a one-line receipt with Undo, so the bot continues in the same
turn. Routine requests keep their own rule until Triggers v2 replaces them,
and on My Cloud a turn a guest or a webhook drove still waits for the owner. Invalid input, unavailable services, or failed
writes return errors, not a request to approve again. An expired native
permission request is not turned into another Allow/Deny card.

A turn a webhook, a routine, or another bot started runs in the bot's level
like any other turn. The decision log records that nobody was at the keyboard
when such a turn asked.

### A Chief of Staff's level covers the work it delegates

Teammates start at Full access like every bot, but a person may have set one
lower, and switching each thread a Chief opens back up by hand was where a
team's owner spent their day. So **a Chief of Staff's level flows down**. Work
it hands out with `coordinate_bots` — into the work thread the Chief's
conversation has with a teammate, or a fresh thread with `thread: "new"` —
starts at the level of the Chief conversation it came from: Auto-accept edits,
Approve for me, or Full access. The teammate's thread is switched to that
level, keeps it, and opens with a line saying so ("Approve for me — delegated
by Clive, a Chief of Staff on Approve for me"); you can still change it in
that thread. Work a Chief hands out inside a room runs at the Chief's level
for that turn. It flows down every hop, not just the first: when Ada, working
for Clive, hands part of it to Bea, Bea's work runs at Clive's level too
("Approve for me — delegated by Ada, from Clive, a Chief of Staff on Approve
for me"), in threads and rooms alike. Each hand-off looks up its chain to the
nearest Chief conversation (`server/host/delegated-level.ts`). The level is
computed once when the assignment is written and recorded on it
(docs/runtime-contract.md §3); the turn runs with exactly that level.

It only ever raises: a teammate already on a higher level keeps it, a teammate
on Custom keeps its own configuration, and a Chief handing work out from an
Ask conversation passes nothing on. Every engine runs Full access, so only
Auto-accept edits can be capped: a teammate on an engine without it (Codex,
whose Ask already writes the workspace) stays on its own level. The teammate's
own default and its other conversations do not change, and an ordinary bot's
hand-off, with no Chief up its chain, still uses the recipient's setting. A consultation (`consult: true`)
answers from what the teammate knows and acts on nothing, so no level travels
with it. Questions and missing credentials still reach you.

## Answering a request

Approve or deny requests in the conversation to let the bot continue. **Allow
once** answers this request only. **Always allow this session** hands the
provider its own remembered approval: Claude receives its suggested permission
rules, and ACP agents such as Grok receive their `allow_always` option, or the
driver repeats your answer for that exact operation until the native session
ends. API models (OpenAI-compatible, MiniMax, Mistral, Grok API) have no
native session, so their driver keeps the allow for that bot, that exact tool
and that exact server (as launched: a changed command, URL or credential is
another server, and a bridge into a VM or a Boat is new each turn) for the
rest of the conversation, in memory until the server restarts. Another bot in
the same room asks again.

For a read-shaped tool from a configured custom MCP server, the card also
offers **Always allow**. This is an explicit standing grant for that exact bot,
provider instance, MCP server, tool name, and current server configuration. A
different tool still asks; editing the server command, URL, headers, or
credentials invalidates the grant. It is not offered for create/update/delete
tools, computer control, a sandbox change, an unconfigured server, or a guest's
turn. A custom MCP server controls its own tool names, so only remember tools
from a server you trust. The grant applies to the bot's current and future
conversations, including newly delegated work. Saved entries are visible and
revocable in the bot's Access settings.

The harness's own agents tools (coordinating teammates, threads, memory) never
ask on Claude, Codex or API models: OpenMausBot authorizes each of those
routes itself.

Auto-accept edits and Ask card whatever the provider asks about. Approve for
me cards whatever the provider's reviewer leaves for you, with the note "The
provider requires your approval for this action." A sandbox widening is held
in every level but Full.

### When the native reviewer never starts

Claude Code accepts `--permission-mode auto` for every model and, when auto
mode is unavailable to the session, starts in Manual without an error. On
Claude Code 2.1.266 that is the case for Claude Haiku 4.5 and Sonnet 4.5,
and for any organization that set `disableAutoMode`. In that session the bot
asks before each action unless you have explicitly remembered that exact MCP
read tool. The Claude driver reads the mode the session actually runs in from
the CLI's `init` frame; when Approve for me was requested and the session runs
Manual, the chat shows one notice per session naming the model. Choose a model
the reviewer supports, remember the MCP reads you trust, or use Full access to
stop the prompts.

### Changing a bot's engine

A bot at **Full access** keeps it when you switch it to another engine: every
engine runs Full access, so there is no reset to Ask and no confirmation. The
bot's threads that follow its model keep their level too. **Custom** rules
belong to Codex, so a Custom bot goes back to Ask before it changes engine.
Switching to an engine that cannot run the bot's level (for example
Auto-accept edits on Codex) still asks to choose Ask first.

### Antigravity: Ask, Edits, or Auto (full access)

For Antigravity, the composer and bot settings offer **Ask for approval**,
**Auto-accept edits** (its native `auto_edit` mode), and **Auto (full access)**.
Auto enables native `yolo` mode and automatically approves remaining
tool-permission requests for commands, edits, and computer actions, without an
automatic reviewer. The composer chip reads **Auto**. This is the Full access
level under another name, not a separate permission setting, applies at once
like Full access, and covers every model in that Antigravity instance,
including Gemini.

A new Antigravity bot starts on Auto, the default. Old Antigravity
`auto` / `autoApprove` settings still behave as Ask and are displayed as Ask;
they never become unrestricted access on upgrade. Switching back to Ask
restores prompts on the next turn. Questions and missing-credential forms
still require an answer. A Chief or
teammate can hand work to this bot with `coordinate_bots` without downgrading
its explicit Auto (full access) grant. It does not enable Auto on any other bot.

## Asking you questions

Every engine can stop and ask, and no approval level ever answers a question
for you: Ask, Auto-accept edits, Auto, and Full access all leave a question
card for a person. What differs per engine is only how the ask travels:

| Engine family | How an ask travels | Multiple questions at once |
| --- | --- | --- |
| Claude Code | Structured round-trip (its own `AskUserQuestion`). In Full access the CLI does not offer that tool, so the model uses the injected `ask_user` tool | Yes — capped at 4 by the CLI, up to 6 with `ask_user` |
| Codex | Structured round-trip, or an async question that does not stop the turn | Yes — up to 6 |
| Grok Build | Structured round-trip (its own `ask_user_question`, sent as `_x.ai/ask_user_question`) | Yes — up to 6 |
| Cursor | Structured round-trip (its own `cursor/ask_question`). Cursor accepts only option ids, so an answer in your own words goes back as a skipped question with your words as the reason | Yes — up to 6 |
| Grok (API), MiniMax, OpenAI-compatible endpoints | The injected `ask_user` tool | Yes — up to 6 |
| Other ACP engines (Antigravity, Gemini CLI, Qwen Code, OpenCode, …) | Option-match round-trip on the ACP permission request | One at a time — the request carries one choice set |
| Pi | The injected `ask_user` tool over `extension_ui_request`; each question is its own card | Up to 6 per call, shown one after another. One pick per question, no multi-select |

Codex can also ask without waiting (its `request_user_input_async` tool).
The question arrives with the bot's message as the same question card, and
the turn keeps working. Your answer is steered into that turn while it runs.
After the turn ends, the answer is sent as your reply, like any question
answered late.

Older conversations may still hold a question the removed Computer engine
parsed out of model-authored output rather than a real tool call. Those
cards keep their "Agent-composed question" badge, and their decision-log
rows keep `origin: output`. Flat clients (notifications, older companion builds)
see plain buttons only when a card asks a single choice question; a
multi-question card renders its structured form on current apps instead.

## Provider mappings

| Provider | Ask | Auto-accept edits | Auto | Full access |
| --- | --- | --- | --- | --- |
| Codex | `on-request` approvals, `workspace-write` sandbox, you review | not offered (Ask already writes in the workspace) | same sandbox, native `auto_review` reviewer | `never` approvals, `danger-full-access` sandbox |
| Claude | Native `default` | Native `acceptEdits` | Native `auto` | Native `bypassPermissions` |
| Cursor | Native default | not offered | Native `--auto-review` | Native `--force` |
| Antigravity | Native `default` | Native `auto_edit` | Legacy `auto` behaves as Ask; UI Auto selects Full access | Native `yolo` plus automatic approval of remaining tool-permission requests; shown as Auto |
| Grok Build | Native `default` | Native `acceptEdits` | Native `--permission-mode auto`; availability of Grok's reviewer depends on its feature rollout | Native `bypassPermissions` plus automatic approval of remaining tool-permission requests |
| OpenCode | Ask | not offered | Ask | Approve individual ACP permission requests, never task questions |
| Qwen Code | Native `default` | Native `--approval-mode auto-edit` | Native `--approval-mode auto` (Qwen's LLM classifier approves safe actions, blocks risky ones) | `--yolo`, plus automatic approval of remaining ACP permission requests |
| Gemini CLI | Native `default` | Native `--approval-mode auto_edit` | Ask (no reviewer) | `--yolo`, plus automatic approval of remaining ACP permission requests |
| Cline | `--auto-approve false`, you review | not offered | Ask (no reviewer) | Approve individual ACP permission requests, never task questions |
| Droid | Session mode `normal` (reads only) | not offered | Ask (no reviewer) | Session mode `auto-high`, plus automatic approval of remaining ACP permission requests |
| Kimi, Hermes, custom ACP agents | The agent's own default | not offered | Ask (no reviewer) | Approve individual ACP permission requests, never task questions |
| Pi | Pi's own tools run; computer control and custom MCP tools ask | not offered | Ask (no reviewer) | Custom MCP tools run without asking; computer-control confirms are approved |
| API engines (OpenAI-compatible, Grok API, MiniMax, Mistral, Cerebras, Groq, Meta) | OMB's tool gate asks | not offered | Ask (no reviewer) | OMB's tool gate approves each call |

These settings apply on each turn, including resumed conversations. Switching
to a different provider while on Custom requires leaving Custom first;
choose Ask. Switching models within Antigravity keeps the selected level.
Native modes require a CLI version that supports them; OpenMausBot does not
silently substitute unrestricted access when a mode is rejected.

### Read-only integration tools

OpenMausBot's built-in agents MCP server describes its scoped reads with
explicit read-only, non-destructive, idempotent, closed-world metadata:
`list_bots`, `list_rooms`, `list_threads`, `assignment_status`,
`session_search`, `session_read`, `list_triggers`, and `skills_list`.
Session recall still enforces own-bot access and records its existing room
disclosure audit. These hints do not grant access to another bot's conversations.
Writes, credential requests, proposals, and third-party tools do not inherit
these hints. The metadata is available to every engine using this integration;
whether an engine consumes it remains that engine's behavior. Arbitrary MCP
display titles or `readOnlyHint` claims from a third-party server are not
authorization to bypass a prompt.

The level set follows the provider-boundary approach in
[T3 Code's permission modes](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/user/permission-modes.md):
Supervised, Auto-accept edits, Auto, and Full access, each a provider mode
rather than an app rule, with a remembered approval that belongs to the
provider's session. Its default is Full access, and so is OpenMausBot's
(`DEFAULT_APPROVAL_MODE` in `shared/approval-mode.ts`).

## Verification for contributors

The [Full Access workflow recipe](verification/full-access.md) tests immediate
profile, routine, team, skill, and peer actions through the real server and MCP
proxy. Its fixture also verifies that explicit Ask sibling threads still wait.

Run `pnpm exec electron scripts/smoke-approval-modes.cjs` to exercise the real
private desktop-to-server grant protocol in a disposable fixture. It verifies
that Full access applies over HTTP while Custom is refused there, Full → Auto → Ask on resumed Claude turns, and
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
