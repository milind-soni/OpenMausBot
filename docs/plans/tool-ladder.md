# The tool ladder — connecting, finding, or building what a job needs

## Why

A bot that needs a tool it does not have currently has one move: say so in prose
and stop. Everything past that is the user's problem — find the integration,
connect it in a settings panel, come back, say it again.

The target is the shape in `hilo.cx/onboarding` (recorded 2026-09-09): you say
what you want done, and the connecting happens *in the conversation*, one step
at a time, with a way out at every step. Their flow:

1. Suggested jobs, not tools — "Create an event in my calendar".
2. "Which calendar do you want to use?" — the providers it actually has.
3. "Connect the selected tool" — one button.
4. "Name this Google Calendar account" — `Work`, with Personal/Work chips, and
   the reason attached: *"shows this name when it asks you to approve an action"*.
5. OAuth (consent is to Composio, not to the product).
6. Back in the chat: "Checking integrations…", and the job continues.

We already have 3, 5 and 6. We are missing 1, 2 and 4 — and we stop where they
stop, which is at "we don't have that".

## The ladder

Their flow has one rung. Ours has four, and the last three are the point:
a bot that cannot do something should not be a dead end.

| Rung | When | What happens | Who decides |
|---|---|---|---|
| 1 · **Use** | the toolkit is already connected | nothing is shown; the job runs | harness |
| 2 · **Connect** | Composio has it, unconnected | picker → name the account → OAuth → resume | user picks |
| 3 · **Find** | not in the catalog | research an MCP/plugin/CLI, **propose** it | user approves |
| 4 · **Build** | nothing exists, or the find was declined | generate a CLI + MCP server for the API | user approves |

**No rung is ever silent about failing.** Falling off a rung is a message that
names what was missing and offers the next one. That is the whole design: the
user is never told "I can't", only "here is the next thing we could do".

### Rung 1 — use what is connected

`composio.connectedServices()` plus the bot's configured MCP servers. A match
means no card at all. The best version of this feature is the one you never see.

### Rung 2 — connect what Composio has

The picker is the question card from #953 with its options built from
`composio.listToolkits()` rather than authored by the model. That matters: a
model-authored list can offer a provider that does not exist or that we cannot
actually connect. The harness owns the list; the model owns the *capability*
("calendar"), never the slugs.

Rows already connected are marked as such. The card always carries
**"Choose a different option"** and **"I'll connect it later"** — the escape
hatches are not decoration, they are what makes it safe to click.

Then the account name, which we already store (`normalizeAccountAlias`,
multiple accounts per toolkit) and have never once asked a person for. It is
asked *here*, at the moment it means something, with the reason attached.

Then the existing `ConnectorCard` and `maybeResumeConnectors` finish the job.

### Rung 3 — find something that exists

The bot researches: is there an MCP server, a plugin, a CLI for this?

**It never installs.** It comes back with a proposal card carrying provenance —
publisher, package, exact version, what access it wants — and nothing runs
until the user approves that card.

This rung is the one with teeth. "Search the web, find an MCP, install it" is
mechanically a supply-chain attack: rank a malicious server for "google calendar
mcp" and you have code in the bot's process holding the user's credentials. The
approval is not a formality and it must never become one — no auto-install, no
allowlist that grows by itself, provenance on screen every time.

### Rung 4 — build one

`cli-printing-press` (https://github.com/mvanhorn/cli-printing-press) generates,
from an OpenAPI spec, a URL, or a HAR file: a Go CLI (`<api>-pp-cli`) **and an
MCP server** (`<api>-pp-mcp`). That second output is the integration point —
it lands as a configured MCP server through the existing `mcpServers` mutation
path, the same as any other.

Counter-intuitively this is the *safer* rung: the code is generated rather than
downloaded from a stranger, and the generated skill goes through the existing
hash-bound review card before it can run. It is also slow — research, codegen,
a Go build — so it is offered, never assumed, and it reports progress.

## Slices — all four built

1. ✅ **Connect in the conversation** (rungs 1–2). `need_tool(capability)`, the
   catalog-backed picker, the account-naming step, the escape hatches.
2. ✅ **Onboarding** — smaller than planned. The suggested-first-jobs card was
   dropped: #833 deliberately replaced the onboarding quiz with setup mode, and
   four chips about calendars are the wrong question for a bot that does not
   yet know what it is. What was actually missing was the END of the setup
   prompt, which sent people to a settings panel to authorize apps by hand. It
   calls `need_tool` now. The app marquee shipped.
3. ✅ **Find** (rung 3): "Look for one" → research → `propose_tool` → a card
   carrying package, exact version, publisher (marked unverified), the command
   that would run, and the pages the bot read. Approval is hash-bound to what
   executes.
4. ✅ **Build** (rung 4): "Build one" → cli-printing-press → the generated MCP
   server proposed on the same card, with the API documentation it was built
   from standing in for a package that does not exist.

## Answered along the way

- **What names the capability**: the model does, with `need_tool`. Harness
  detection on a failed tool call is still worth adding as a backstop for when
  the model does not realise it is stuck.
- **The score floor** in `matchToolkits` exists because "veterinary records"
  confidently offered Airtable and Salesforce. One late mention in a blurb is
  not evidence, and a wrong offer costs a real sign-in.

## Still open

- **The phones.** Rungs 1–4 are desktop-only. The picker is close to the
  question card (#954/#955); the OAuth handoff and the proposal card's
  provenance are their own problems.
- **Rung 4 needs cli-printing-press on the machine.** The bot checks and says
  so if it is missing; it does not install it.
- **Nothing re-checks an approved server.** An approved package is pinned to a
  version, but nothing watches for that version being yanked or the package
  changing hands.
