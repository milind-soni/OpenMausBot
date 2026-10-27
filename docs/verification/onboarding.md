# Welcome flow and guided tour

The first run is short (Oct 23 2026): the greeting (a name only; the email is
asked once, by the separate product-updates question), Connect an AI when none works, then only the import, microphone and
Cloud steps this computer needs, and the chat. There is no feature reel, phone
step or first-bot step, and the app tour starts only from Settings → Replay
app tour.

Launch the isolated full-app fixture following [Chat UI](chat-ui.md):

```sh
node --experimental-strip-types scripts/control-omb.ts ui launch
```

In a second terminal, pass its exact printed handle:

```sh
node --experimental-strip-types scripts/verify-onboarding-ui.ts /tmp/openmausbot-verify-data-XXXXXX/ui.json
```

Use a fresh fixture. The recipe clears only its browser storage, then enables
first-run onboarding through the fixture-only `?onboarding=1` entry. It uses
the real renderer and fake-engine server. No provider login, real phone
pairing, native permissions or user workspace is involved.

Assertions cover the greeting asking for a name only, a reload keeping the typed name, profile-save failure
and retry, the one-step welcome (the fixture's Claude already works) landing in the
chat with the first bot and no app tour (also after a reload),
automatic starter-model selection and a successful first composer message without
opening the model picker,
every app tour step from Settings, persistence after reload, Settings replay, skipping
while Next is saving, closing welcome while its save is pending, and replay on
legacy installs with a failed-save retry. Screenshots
are retained in `.omb-scratch/verify-evidence/onboarding/` with a PASS line for
each workflow. Actual provider authentication and native Electron permissions
remain covered by their separate platform recipes, not this browser fixture.

Stop the launcher with Ctrl-C; it owns and removes only its disposable home.

## Providers connected after first launch

```sh
pnpm exec vitest run server/onboarding-model-default.e2e.test.ts server/default-model-selection.test.ts src/components/NewBotDialog.test.ts
```

The server tests launch only disposable homes and repository-owned fake engines.
They cover a genuinely signed-out first install, a missing CLI connected later,
and first-send discovery without opening settings. They assert the selected model
in persisted bot records and fake-provider arguments, settled turns and bounded
transcripts. Existing bot choices and explicitly pinned thread models survive
both automatic repair and a restart. Disabled and signed-out engines stay unset.
Guarded messages recheck permissions after held provider discovery before starting.
Pure-picker tests cover API/custom engines, empty catalogs, fallback model options
and organization policy. Dialog tests cover blank saved new-bot templates without
replacing deliberate choices. Real provider authentication and packaged native
installation are not exercised by these offline fixtures.

## Organization row, hosted beats and member note (Sep 23 2026)

What each first-run surface depends on, and how it was checked:

| Who opens the app | What they get | Checked by |
|---|---|---|
| Desktop app, own server (full bridge, `remoteClient` present) | The same flow as before, decided without a new request | `src/components/onboarding/WelcomeGate.test.ts`; `HelloBeat`/`EnginesBeat` HTML compared byte for byte with main (no bridge) |
| Hosted workspace opened inside the desktop app (reduced bridge, no `remoteClient`) | Treated like a browser: the server is asked | `src/components/onboarding/WelcomeGate.test.ts` |
| Packaged desktop with the organization bridge | An optional "Using OpenMausBot at work?" row on the engines beat; a signed-in Company engine counts as ready | `src/components/onboarding/beats/OrganisationRow.test.ts`, `src/components/onboarding/beats/EnginesBeat.test.ts` (fake bridge) |
| Browser, admin of a hosted workspace | Greeting (no inputs) only | `src/components/onboarding/WelcomeGate.test.ts`, `src/components/onboarding/beats/HelloBeat.test.ts`, `src/lib/onboarding.test.ts` |
| Browser, hosted member (no admin scope) | No welcome flow; one dismissible note kept in browser storage; no first-conversation spotlights | `src/components/onboarding/WelcomeGate.test.ts`, `src/components/onboarding/FirstConversationTour.test.ts` |
| Browser, client-scope session on a server that is not hosted | Nothing new: the flow does not open itself (it could not be saved); Settings replay and spotlights as before | `src/components/onboarding/WelcomeGate.test.ts`, `src/lib/onboarding.test.ts` |

`GET /api/auth/session` adds `hosted: true` for a session on a hosted
workspace and is otherwise unchanged (`server/hosted-access.test.ts`,
`server/email-signin.test.ts`).

On a fresh `ui launch` fixture, the recipe above still passed end to end
through the new session check. In the same fixture browser, a client-scope
paired session with the server's onboarding record reset got no welcome flow.
That run also showed the member note, which review then limited to hosted
workspaces (the fixture is not hosted). The hosted-only rule is covered by the
tests above, not by a rerun. In that run, "Got it" made no `/api/config`
write, and the note stayed away after a reload. The engines beat was mounted from the Vite preview with a fake
`window.ogb.organization` injected before mount; it showed the row signed out,
then connecting with the code, then connected. `begin` ran once, with the
default Admin. Screenshots are in `.omb-scratch/verify-evidence/onboarding/`.

Not covered here: the real Electron preload bridge and a real Admin enrolment
(see [organization connection](organization-settings.md), not rerun for this
change), and a real hosted tenant's browser. The hosted beat set was rendered
from a temporary preview entry, not reached through a hosted sign-in.

## A new Cloud's welcome

```sh
node --experimental-strip-types scripts/verify-cloud-welcome.ts
```

It launches the isolated fake-engine fixture and mounts the whole app
(`scripts/testing/cloud-welcome-preview.tsx`) in a Vite preview whose
session and config answer as a Cloud home's owner, with Claude signed out and
the trial's Claude credit in the engine list. Open the printed `previewUrl`:

- `?desktop=1` adds the reduced bridge a Cloud's page gets in the desktop app;
  `?move=copy` or `?move=done` shows the one-time move on its way or landed
  (6 bots, 142 chats, 4 routines).
- `?step=engine`, `?step=files` or `?step=done` opens the welcome on that step;
  `?skin=daylight` (or any skin) picks the skin.
- `POST /__fixture/engines?mode=signed-in` (or `signed-out`, `credit`) changes
  the engine list for the next load.

What was checked this way (Oct 16 2026): every step and the done state in
Midnight and Daylight at 1280×860, 1024×760 and 390×844, the bring and engine
steps in the other seven skins, and
the setup card in short beside Routines. Steps finished there are written to
the fixture's onboarding record; the record can be cleared with
`PUT /api/config` (`{"onboarding":{"hintsSeen":[]}}`). The real move and the
desktop's preload bridge are not exercised here; they are covered by
`server/one-home.e2e.test.ts` and
`src/components/cloud-welcome/CloudWelcome.test.ts`.

## Bring what you already use (Oct 16 2026)

The step after the engines beat: skills and MCP servers another AI tool keeps on
this computer, brought in with one button. Desktop app only, and skipped when
nothing new is found within two seconds.

```sh
pnpm exec vitest run server/setup-import.test.ts server/imported-skills.test.ts server/toml-lite.test.ts server/routes/setup-import.test.ts server/setup-import.e2e.test.ts src/components/onboarding/beats/ImportBeat.test.ts src/lib/setup-import.test.ts src/lib/onboarding.test.ts
```

Every test builds its own temporary home; none reads the real `~/.claude`,
`~/.codex` or other dotfiles. The detector test plants credential, session,
history and transcript files holding a sentinel, records every path the step
touches, and checks that none of them was listed or opened and that the
sentinel reaches no answer, saved server or copied skill. The route test
refuses a paired device, a service loopback and a hosted or Cloud server; the
end-to-end test runs the real server from `launchVerificationServer` against a
planted home, as the desktop app runs it (`OMB_TEST_DESKTOP_OWNER_TOKEN`), checks
that a headless server (`openmausbot serve`) refuses the step, and checks that the starter bot and a bot made afterwards both
get the skills in their turn's index, task folder links and `/name`, that a
Claude turn with "Also use my Claude Code skills" on sees a Claude Code skill
once, and that a bot can switch one off for itself. Screenshots of the step in
Midnight and Daylight, at a narrow width, working, failed and with its result
came from `onboarding-preview.html` with a fixture detection (`?beat=import`,
`?import=notes`, `?import=fail`, `?w=390&h=760`). Not covered here: the
packaged Electron window itself.

## One short welcome, no second tour (Oct 23 2026)

```sh
pnpm exec vitest run src/lib/onboarding.test.ts src/lib/welcome-draft.test.ts src/components/onboarding src/components/AppNotices.test.ts
```

`src/lib/onboarding.test.ts` lists every step set (no reel, phone or bot step in any
combination) and the shared count behind the dots and "Step N of M".
`src/components/onboarding/WelcomeFlow.steps.test.ts` renders the flow in happy-dom: a double click moves
one step and Back waits while a step changes; the dots match the counter on
every step; a reload resumes on the saved step with the typed fields, or on the
step before one still loading (import, Cloud) and then on it; Skip and Escape
keep the typed name; a replay or the preview never touches the
saved draft; Skip stays out of a long title's way. `src/components/onboarding/beats/HelloBeat.test.ts` covers the
name-only greeting and Maybe later keeping the name typed. `src/components/onboarding/GuidedTour.test.ts`,
`src/components/onboarding/FirstConversationTour.test.ts` and `src/components/onboarding/WelcomeGate.test.ts` check the app tour
never starts by itself, also after a reload, and the first-conversation
spotlights no longer wait for it.

Layout was checked in `onboarding-preview.html` (`?w=375&h=667`, `?w=1920&h=1080`)
in a browser of the same size. `verify-onboarding-ui.ts` passed end to end on a fresh
`ui launch` fixture (Oct 23 2026). That fixture has a working AI, so it never reaches
Connect an AI; the engines step's refresh failure is covered by
`src/components/onboarding/beats/EnginesBeat.test.ts`, and the steps after it by
`src/components/onboarding/WelcomeFlow.steps.test.ts`.
