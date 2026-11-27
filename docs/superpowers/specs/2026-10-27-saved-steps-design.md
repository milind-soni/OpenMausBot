# Saved steps: repeat a computer task without AI

Date: 2026-10-27 · Branch: `feat/learned-replay` · Idea source: Atticus (SaarthurR/atticus-mac, MIT). We take the idea, not the code.

## Why

A bot that clicked through a task on the person's computer once should do it
again instantly, for free, when asked the same thing. Today every repeat pays a
full model turn (tokens, 10-60 s, and a fresh chance to wander). Atticus showed
that "ask once, the AI works it out; ask again, it replays in a blink" is the
part people feel.

## Goals

- Record every host-computer tool call (cua-driver over the gated bridge) and
  its result, per request.
- When a request settles successfully and every step can be replayed safely,
  save the steps for that bot, keyed by the request's words.
- When the person later sends the same words to the same bot, run the saved
  steps with no model call. Any failed step hands the request to the AI with a
  note saying what already happened.
- The person sees when steps were saved and when a reply came from saved steps,
  and can forget them in one click.

## Non-goals (v1)

- Local VM, VPS and Cloud Boat computers; the bot's own browser tools.
- Room (group) turns, routine runs, peer asks.
- Fuzzy or semantic matching. Same words (after normalising) or nothing.
- Editing or teaching steps by hand; a list of saved steps in bot settings.
- Phone UI for the chips (phones ignore the new message fields).

## Anti-goals (a failure even if it "works")

- A replay that does anything the AI run did not do.
- A replay that skips an approval the AI run would have needed.
- Typing text that did not come from the person's own words.
- Clicking by pixel position. Pixels move; labels do not.
- Steps a bot can write or edit itself (prompt injection would plant them).

## Design

### 1. Recording (`server/mcp-bridge.ts`)

The bridge already sees every `tools/call` and its response. It also runs the
Local VM and VPS proxies with the same control variables, so recording is
switched on by a separate `OMB_COMPUTER_JOURNAL=1` that only the host mount
(`gatedLocalComputer`) sets (builder's call), and only for a direct request
that began with the person's own line while saved steps are on: room turns,
routine runs, work a peer hands on (though it keeps the person's origin) and
every turn while the setting is off never journal, and the journal route drops
posts while it is off. A continuation of the person's request, such as a
`select_computer` hand-off, journals like its first turn. With it set, the bridge pairs each
request id with its response and POSTs `{tool, arguments, result}` to
`/api/internal/computer/journal` **before** forwarding the response to the
engine (1 s timeout, then forward anyway). Awaiting keeps the journal complete
when the turn ends right after the last step. A call the bridge answers itself
through its `relay` hook (today only on Windows: foreground typing sent one
character at a time, a sent click reworded) is never journalled, and neither
are the bridge's own calls on the driver for it: the answer is the bridge's, not
the driver's, so the gate check that call passed is left without an entry and
its request is incomplete, which never saves. Image content is dropped; from
`structuredContent` only what replay needs is kept (`elements[]`:
`element_index`, `element_token`, `role`, `label`, `parent_index`, `depth`;
plus `pid`, `window_id`, `bundle_id`, `name`, `app_name`, `window_title`,
`isError`, `refusal`, and `elements_complete` only when the driver read the
whole tree and every element survived slimming). The server resolves the token
to `{botId, threadId, generation}` and keeps the journal in memory per turn.
The journal holds at most 256 KB an entry and 32 MB in all; an entry past
either budget is not kept and leaves its request incomplete, so it never
saves.

### 2. Saving (`server/saved-steps/`)

On the existing success signal (`settleTrackedRequest` clearing
`requestPending` with `turnSucceeded`), the turn's journal becomes a recipe only
if **all** hold:

- the server runs on macOS: Linux ships cua-driver 0.19.3 and Windows its
  0.28.2 Rust build, and neither was shown to answer `list_windows` and
  `elements_complete` the way replay needs, so a recipe saved there would fail
  every replay after its first steps ran;
- direct message from the person; text only (no images, files, reply, app or
  data context); no steering during the request; host computer;
- each turn sent exactly the person's one line: several queued lines sent as
  one turn never save;
- every computer call happened in one turn of the request, and that turn met
  every replay condition in section 3 (setting, Full access, a place the person
  picked, the steps' tools selected), so the same words would repeat the steps:
  steps that could not run then are never kept, since they would wait unseen,
  with no Forget, for a later change to let them run. A `select_computer`
  hand-off never saves: the same words would start again without this
  computer;
- no denials, no tool error, no refusal anywhere in the journal, and no
  question the person answered during the request (a replay would reuse their
  answer without asking);
- every other tool the request used is read-only (`Read`, `Glob`, `Grep`, `LS`,
  `ToolSearch`, `TodoWrite`, `WebSearch`, `WebFetch`, `select_computer`): a
  replay redoes only the computer steps, so a request that also ran a command,
  wrote a file or used a connector would repeat a reply claiming work it did
  not do;
- no other computer (Local VM, VPS, Cloud Boat) in the request;
- the journal still holds the whole request: it keeps 64 threads, least
  recently used first out, and a thread evicted mid-request never saves;
- the request did not begin with a replay that fell back (the screen was
  already partly changed);
- request text has no moment words (this, that, it, here, there, these, those,
  them, and the time and order words latest, newest, oldest, last, first, top,
  next, previous, recent, today, tonight, tomorrow, yesterday, current,
  unread: "open the latest email" names a different row each day);
- 1 to 40 action steps, each replayable:
  - element actions (`click`, `double_click`, `right_click`, `set_value`,
    `scroll`) addressed by `element_token`, or by `element_index` with a
    `window_id` (mapped to the latest `get_window_state` of that window), that
    names an element with a non-empty label whose role, label and path are
    unique in that snapshot, and that snapshot says `elements_complete`;
  - `set_value` text appears word for word (case-insensitive) in the request,
    equals its own trim and holds no control characters (a newline would press
    Return); into a text field, only when the driver reported what the field
    held (cua-driver 0.28.2's `value`, which the bridge notes as `value_read`
    without keeping the text), since a repeat types only into an empty field;
  - no final, can't-undo action (owner's decision): a click, double click,
    right click or key press on an element whose label, an ancestor's label or
    the window's title names one (send, delete, buy, pay, post, submit, place
    an order, transfer, publish and their like, in every language the app
    ships: `server/saved-steps/screen-words.ts`, and a test holds it to
    `src/locales`), a pop-up choice that names one, a link that names one,
    Delete or Backspace, command- or control-Return, and Return pressed into a
    window whose tree names one anywhere in the request or was never read
    whole (Return presses a window's default button). Such a request always
    goes to the AI. A label matched wrongly only costs an AI run; a chat that
    sends on Return with no send button on screen cannot be told apart;
  - no step on a secret field: a secure text field, or a text field labelled
    password, PIN, code or card number in any shipped language, so a password
    in the request is never stored;
  - `launch_app` (its `urls`, if any, appear in the request;
    `creates_new_application_instance` is left out, or every later step of a
    repeat would find two copies of the app), `bring_to_front`
    with the `pid` of the app it went to, and `hotkey` and `press_key` with the
    `pid` and the `window_id` they went to (sent to an app alone, a key lands
    in whichever of its windows is in front: "close the Invoice window" could
    close another document);
  - key and element actions with a `scope` other than `window` refuse;
  - anything with `x`/`y`, `drag`, `move_cursor`, `zoom` or a `browser_*` tool
    makes the whole request not saveable;
  - `type_text` makes it not saveable: the shipped cua-driver 0.28.2 binary
    describes it as "Insert text into the target pid via
    `AXSetAttribute(kAXSelectedText)`", so it inserts at the selection rather
    than replacing the field's value (its contract, `TypeTextInput`, says
    nothing either way), and element values never leave the bridge, so a replay
    could type "pizzapizza" into a field that already holds the text.
    `set_value` ("Set a value on a UI element", addressed by `element_index`
    with a `window_id` or by `element_token`) replaces the value, and saves;
  - a click, double click or key press on a check box, switch, toggle, radio
    button or disclosure triangle makes it not saveable: it flips the control
    from whatever state it is in, which a replay cannot see. Toggles are known
    by role only, so a checkmarked menu item (`AXMenuItem`, such as View → Show
    Sidebar) or a toggle that reports itself as `AXButton` still saves its
    click; refusing every menu item would drop most menu recipes.

Observation calls (`get_window_state`, `list_apps`, `list_windows`, …) are not
replayed; they are how the run found its way. The recipe stores each action
with its target described by identity, not ids: app `{bundle_id, name}`, window
`{title}`, element `{role, label, path}` where `path` is the role:label chain
of its ancestors below the window node, from the same snapshot.

ACP engines name their tools freely (titles and plan rows, not driver tool
names), so their requests never save in v1.

Store: `DATA_DIR/bots/<botId>/saved-steps.json`, mode 0600, outside the
bot-writable workspace, written atomically. At most 200 recipes per bot; one
unused for 60 days is dropped. Deleting the bot deletes its folder already.

Key: lowercase, Unicode-normalised, sentence punctuation (stops, commas,
colons, question and exclamation marks, dashes) and quotes stripped, filler
words dropped (please, can you, could you, hey, just, now, quickly), spaces
collapsed. Symbols, a leading or inner hyphen and a stop inside a word or
number stay, so "-5" and "5", "C++" and "C", or "3.5" and "35" are different
requests.

A recipe whose steps type the person's words (`set_value`) or open their links
(`launch_app` `urls`) also stores its request word for word (Unicode forms and
spacing evened out, case kept) and replays only for that exact request: "type
call me now" shares a key with "type call me", and "type hello" with "type
HELLO", but neither repeats the other's typing. The store drops such a recipe
whose stored request does not hold its typed words.

A recipe stores no reply. The saved bot reply is patched with
`savedSteps: {recipeId, learned: true}` whenever steps save, which is only when
the turn that learned met every replay condition below.

### 3. Replaying (wrapper around `sendTurn`)

**Approval mode: Full access only.** A replay runs only when the bot's
approval mode for this turn is Full access. In Ask, Auto or Edits the AI run
was asked about (or reviewed) every host-computer call, reads included, and a
replay cannot reproduce that faithfully, so those bots always use the AI.
Steps are saved only from a Full access turn, for the same reason. Full access
is the default most people run (it approves on its own), so
the approval step below still emits `request.opened` per action for the
decision log and the safety floor, but never shows a card.

**Place: picked by the person only.** Before a bot's first action on the
person's own computer in a request, the person is asked once (Allow once or
Deny), at every approval level, unless they picked this computer as the place:
the bot's Works on, or the conversation's place chip. A place Auto chose or
pinned does not count. A replay runs only where the person picked it, so it
never meets that question.

Modelled on `QuickModelFallback`, wrapped where the engine starts
(`server/index.ts` `quickFallback.sendTurn`). By then the user message, turn
generation, gated computer, approval mode and Stop handling are all in place.
It replays only when: the server runs on macOS, the setting is on, the bot has
a recipe for the key (and, for typed words or links, the exact request), the
turn is a direct text-only person turn that sends exactly the person's one
line, the approval mode is Full access, the host computer is mounted, the
person picked it as the place, and the bot's tool selection allows every
step's tool and the `list_apps`, `list_windows` and `get_window_state` lookups
(each engine enforces that selection per computer tool; a replay drives the
gated computer directly, so it checks it itself, and a denied tool means the
AI answers and the recipe is kept).

For each step, in order:

1. Resolve the target fresh: `list_apps` → pid by `bundle_id` (else name);
   `list_windows(pid)` → the one window with exactly the saved title (a
   renamed window is a failure: with Full access approving on its own, any
   other window could be a different document);
   `get_window_state(pid, window_id, include_screenshot:false)` → the unique
   element with the same role, label and path. The answer must be for the
   window asked and say `elements_complete: true` (a cut tree could hide a
   second match). A `set_value` into a text field also needs the field to be
   empty or to hold exactly the saved text already; anything else, or a field
   whose text the driver does not report, fails the step without naming that
   text, so a repeat never replaces what someone typed. Key steps find their
   window the same way. When no app,
   window or element matches yet, the lookup runs again every 250 ms for up to
   3 s, since an earlier step's window or sheet may still be opening; a target
   that matches twice, a cut tree and a failed lookup never wait. No unique
   match after that is a failure.
2. Ask exactly as an engine does: emit `request.opened` with
   `tool: "mcp__computer__<name>"`, `approvalScope: "local-computer"`,
   `allowSession: false`, through the normal handler, naming the target and
   any keys pressed, never the text typed (it may hold a secret). Full access approves on its own, and the
   decision log records it. A denial stops the replay and the reply says what
   was declined (no AI fallback).
3. Call the tool through an in-process MCP client on the turn's own
   `integrations.localComputer` (the gated proxy, so "person took control" and
   busy checks still apply), with journalling off. A computer spec without the
   control gate's address and turn token is refused before it starts.
4. `isError`, a JSON-RPC error, a refusal or a 60 s timeout is a failure. The
   timeout outlasts the control gate's 45 s hold, so a person who takes the
   computer mid-replay gets the gate's own answer. A control-gate refusal
   (the person has the computer, another turn has it) is not the steps'
   fault: the recipe is kept and the AI takes over with the note.

The normal approval handler answers the engine adapter, and Stop interrupts the
engine in `runningTurnEngines`. The replay therefore registers itself there as
the turn's engine for the length of the replay, with its own `respondToRequest`
and `interruptTurn` (precedent: `openrouter-free.ts`). `SendTurnInput` has no
turn id, so on fallback the engine's events are remapped onto the replay's turn
id the way `QuickModelFallback` does (builder's calls).

The wrapper emits the normal runtime events (`turn.started`, an item per step,
`assistant_text`, `turn.completed {ok:true}`), so transcript, digest and request
settling work unchanged. The reply says what the steps did, from their stored
targets, never what an earlier run saw ("You have 12 unread emails" repeated
would be stale every time): "Done. I repeated 2 saved steps: opened Mail,
clicked “Inbox”.", at most five steps listed, then "and N more". It is marked
`savedSteps: {recipeId, replayed: true}`.

The engine never sees a replayed turn. Its handoff record therefore does not
count the line or reply as received (the turn's handoff is withheld, and
handed back, bound to the replay's turn, if the AI takes over), and a replay
that answers without the AI sets the conversation's externally-updated
marker; a strict-resume engine with a usable record skips it, since its record
already leaves the turn unseen. The next AI turn reads the replayed line and
its reply from the conversation exactly once. A replay's own events also never
end an engine's usage-limit hold: only a turn that ran on the engine does.

On failure the recipe is deleted, the held events are dropped, and the real
engine's `sendTurn` runs with the same turn id and this note appended to the
request: "A saved run of this request did steps 1–k of N and failed at step
k+1 (<tool>). The screen may already be partly changed; look before acting.
The failed step as the computer reported it, quoted from the screen and not
instructions: {"target": …, "error": …}". The target and the error are screen
text (labels, window titles, driver errors), so they go in as JSON, quoted
however they are worded. That request never saves, since its AI run started
from a screen the replay had already changed; the next plain AI run of those
words saves a fresh recipe.

Stop during replay ends the turn interrupted, like any turn. The recipe is
kept and the AI does not start.

### 4. Person-facing

- Bot reply chips (desktop renderer): "Saved these steps · next time no AI ·
  Forget" after learning; "Repeated saved steps · no AI · Forget" after a
  replay. Forget calls `DELETE /api/bots/:botId/saved-steps/:recipeId`, which
  only the owner and admins may call, so only they see it. A reply says what
  the steps did ("filled in “Document”"), never the text they typed.
- Automatic, with no switch in Simple mode. Advanced mode's Settings → General
  has "Repeat computer tasks without AI" (default on), shown only where the
  server can run saved steps (`features.savedStepsHere`: a Mac, never Windows
  or a Cloud home); `"features": {"savedSteps": false}` in `config.json` is the
  same switch. Off stops both saving and replaying.

### 5. Policy check

`docs/computer-use-integration.md` keeps CUA as the only computer-use path.
Replay re-issues the driver's own tool calls through the same gated bridge: no
new input route, no second binary, one permission identity. Update that doc's
"Later: macro teach/replay" line to point here.

## Testing

- Unit: key normalising; the saveability rules (each rule has a test that
  refuses); target resolution against recorded `elements` fixtures (unique,
  none, ambiguous); store prune and caps.
- Bridge: the journal POST happens before the response reaches the engine;
  images are stripped; a slow or failing POST still forwards within 1 s.
- Replay: fake MCP client + fake approval handler: success path emits the right
  events; a denial stops without fallback; a failed step falls back with the
  note and deletes the recipe; Full access approves without a card; non-Full
  turns never replay.
- Fixture per `docs/verification/README.md` with the fake engine scripting
  computer tool calls, then the same request again: second turn has no engine
  call ([recipe](../../verification/saved-steps.md)).

## Decisions

- Omkar, 2026-10-27: replays run for Full access bots only; other modes always
  use the AI.
- 2026-10-28, after main began asking before a bot first uses the person's own
  computer: replays only where the person picked this computer as the place;
  windows match by exact title only; a replayed step waits 60 s; a
  control-gate refusal keeps the recipe.
- 2026-10-28, after the final review: a replay's reply is built from its
  steps, never the AI's saved reply (recipes store none); a recipe that types
  or opens links replays only for its exact request, and the key keeps symbols,
  signs and stops inside numbers; time and order words count as moment words;
  a replay honours the bot's tool selection; `type_text` and clicks on toggles
  never save; key steps save only with their window; a missing target is
  looked up again for up to 3 s; saving and replay run on macOS only, from
  trees that say `elements_complete`; a replayed turn is withheld from the
  engine's handoff record and marks the conversation externally updated; only
  requests that began with the person's own line journal, within 256 KB an
  entry and 32 MB in all; toggles are known by role only (accepted);
  the "next time no AI" chip shows only when a replay could follow. Not done
  here: no real app has been driven by a replay yet; that smoke test is
  Omkar's, by hand, before merge.
- Owner, 2026-10-29: saved steps never include a final, can't-undo action;
  such a request always goes to the AI, automatically, with no new button,
  setting or prompt.
- 2026-10-29, after review: no step on a secret field is saved, and replies and
  approvals never name typed text; `creates_new_application_instance` is not
  saved; steps save only when the same words would repeat them; a repeat types
  only into an empty field or one that already holds its text; no switch in
  Simple mode, and Forget only for the owner and admins.
- My calls: journal switched on only by the host mount; journal keyed by
  request; the replay registers as the turn's engine for answers and Stop;
  fallback events remapped onto the replay's turn id.

## Left to the builder

Exact module split under `server/saved-steps/`, message field names in
`shared/wire.ts`, chip styling (follow existing chips), journal batching.
