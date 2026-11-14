# The safety floor

The safety floor is a short never-list of shell commands the server will not
approve by itself: a recursive delete of the filesystem root, the home
directory or a top-level system directory; formatting or overwriting a disk;
a fork bomb. It is off by default (`safetyFloor.enabled` in `config.json`, or
`OMB_SAFETY_FLOOR=1`). No check here runs any of those commands: the
classifier only reads text, and every permission request is a fake one.

It is not applied on a Windows server yet. There the setting is accepted and
does nothing, and the server says so once at startup. The classifier, gate,
chat-runtime and driver suites give the server's platform explicitly (Linux)
wherever they expect a denial, so they say the same thing on a Windows
runner. The real-server test uses the machine's own platform: on a Windows
runner it checks that nothing is applied, and stops there.

## Run

```sh
pnpm exec vitest run server/safety-floor.test.ts server/safety-floor-gate.test.ts server/auto-approve-undelivered.test.ts
pnpm exec vitest run server/drivers/openai-chat-safety-floor.test.ts server/drivers/self-answer-safety-floor.test.ts
pnpm exec vitest run server/safety-floor.e2e.test.ts
pnpm exec vitest run server/auto-approve.test.ts server/command-allowlist.e2e.test.ts
```

## What it checks

- `server/safety-floor.test.ts` calls the classifier in `server/safety-floor.ts`
  with tables of command lines: every spelling that must be blocked (flags in
  any order, quotes, trailing slashes and dot segments, `sudo`/`doas`/`env`
  prefixes, `sh -c` and `cmd /c` wrappers, chains, cmd and PowerShell forms)
  and every one that must be read to the end with nothing found (the same
  words in a commit message, an echo, a heredoc or a comment; a subdirectory;
  a path only a variable knows; an image file). The platform argument picks
  the reading, so every platform's rows run on any machine: a POSIX row is
  asserted on macOS, Linux and Windows; a cmd or PowerShell row must block on
  Windows and must not be blocked on macOS or Linux, where it is not
  evaluated (the gate does not use the Windows rows yet). A third table pins
  what is neither blocked nor clear, and what reading every line twice costs
  on Windows. Separate cases cover a reading
  that loses its place (never "clear"), the 32 KB cap, and a 20 KB body full
  of escaped quotes.
- `server/safety-floor-gate.test.ts` feeds fake permission requests to
  `server/safety-floor-gate.ts` with an adapter that only records its answer:
  the setting is off by default and the environment can only add it; a
  never-list command is denied with a reason, one status line and one
  `auto-denied` decision row; anything else is left to the grant; a denial
  that cannot be delivered stops the turn instead of leaving it waiting. With
  the platform given as Windows the gate does none of this, and says so once
  at startup. A
  request with no known working directory is still denied, from the command
  line it carries. A command the reader cannot read (forced with a reader
  that fails) is neither denied nor allowed: the grant's verdict becomes a
  card, the log says so once without the command, and a runtime with no card
  to show refuses the call.
- `server/drivers/openai-chat-safety-floor.test.ts` drives the chat runtime
  against a local fake provider and a fixture MCP tool that records the
  command it is handed and runs nothing. At Full access and under "Always
  allow this session" the never-list command never reaches the tool; at Ask
  the card reaches a person and their Allow stands; with the floor off
  nothing changes.
- `server/drivers/self-answer-safety-floor.test.ts` drives the Codex and ACP
  drivers against their scripted fakes, which send a permission request and
  record the answer. Codex at Full access accepts a request inside the
  driver; with the floor on it raises a never-list command as a request
  instead, carrying the exact command, and goes on accepting every other one.
  An ACP agent's kept "Always allow this session" repeats for an ordinary
  command and asks again for a never-list one, and a legacy full-auto
  instance does not answer one by itself. Two cases join the driver to the
  fold's own check: a Codex request with no working directory and an ACP
  request not typed as a shell command both reach it with their command
  line, and it denies them.
- `server/safety-floor.e2e.test.ts` launches the real server in an isolated
  home with the fake Claude CLI parked, and raises Bash requests through its
  actual permission socket. A saved command answers `rm -rf /` while the
  floor is off; after `PUT /api/config` switches it on, the same request is
  denied, the transcript carries the notice and `/api/decisions` the row; an
  unsaved never-list command still reaches a card and the person's Allow
  stands. It then restarts that fixture with only `OMB_SAFETY_FLOOR=1`, gives
  the bot Full access, and checks that Full is denied the never-list command
  and still answers an ordinary one. `/api/config` reports the switch at each
  step. The first request is also read off the `/api/events` stream, where it
  must carry neither `command` nor `commandLine`.

## Limits

Not applied on a Windows server yet. The gate in
`server/safety-floor-gate.ts` is inert there whatever the setting says. The
classifier still has a Windows reading (every line read as POSIX and as
cmd/PowerShell), and the win32 rows of the tables keep it tested through the
platform argument, but nothing uses it: on a real Windows server it leaves
too many ordinary commands unread. The gate tests check the inert path with
the platform given as Windows: nothing is classified, denied, held or logged,
and the startup notice is written once. On a Windows runner
`server/safety-floor.e2e.test.ts` checks the same against the real server and
stops there.

On macOS and Linux a command is read as a POSIX shell line. cmd commands are
not evaluated, so a Mac or Linux server driving a Windows machine gets no
protection for what runs there. What follows `pwsh -c` or
`powershell -Command` is the one exception: it is read both as a POSIX line
and as PowerShell deleting POSIX paths.

Known limitations:

- An arithmetic shift in `(( … ))`, `$[ … ]` or `$(( … ))` is "could not
  read": `(( x << 1 ))`, `echo $[1<<2]`, `x=$((2 << 3))`. The reader takes
  `<<` for the start of a heredoc that then never ends, so nothing approves
  the request automatically: it comes as a card, or is refused where there is
  no card to show. That also holds when a never-list command follows on a
  later line: the answer is "could not read", not a block.
- The three forms are not skipped as arithmetic, because text inside them
  can run: a substitution (`$(( $(rm -rf /) + 1 ))`), or a `((` that is
  really two subshells. It is read like any other text, and arithmetic with
  no shift in it (`$((i + 1))`, `$(( (a + b) * 2 ))`) reads clear. The tables
  pin all three outcomes.

These checks prove the places the server answers by itself: the
`request.opened` fold, the chat runtime's own tool gate, and the Codex and
ACP drivers' own answers. They do not prove anything about an engine that
never asks. Claude Code under `bypassPermissions`, Codex with approvals off
and an ACP agent in its own yolo mode run a command without sending a
request, so the floor never sees it.

The Muse Code driver has the same guard as Codex (at Full access it no
longer answers a never-list command inside the driver), but the repository
has no fake Muse host, so that one line is checked by typecheck and reading
only. A request's display summary is cut at 200 characters and is never read
as a command; the floor reads the engine's own command line, which every
driver that has one puts on the request.

Read the Full access leg of `server/safety-floor.e2e.test.ts` for what it is.
The test itself writes the Bash request to the broker's socket. It proves
that a shell request reaching the server at Full access is denied; it does
not show that Claude Code sends one, and under `bypassPermissions` the real
CLI does not. The saved-command leg is the path a real Claude Code, Codex or
ACP agent takes at "Ask for approval".

The fake engine is parked throughout, so nothing here is evidence about a
real model's behaviour, and no Settings control exists yet: the switch is the
config key or the environment variable.
