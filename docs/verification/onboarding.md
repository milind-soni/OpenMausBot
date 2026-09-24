# Welcome flow and guided tour

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

Assertions cover profile-save failure and retry, reduced-motion reel playback,
engine refresh failure without losing inventory, phone skip, welcome completion,
every guided tour step, persistence after reload, Settings replay, skipping
while Next is saving, closing welcome while its save is pending, and replay on
legacy installs with a failed-save retry. Screenshots
are retained in `.omb-scratch/verify-evidence/onboarding/` with a PASS line for
each workflow. Actual provider authentication and native Electron permissions
remain covered by their separate platform recipes, not this browser fixture.

Stop the launcher with Ctrl-C; it owns and removes only its disposable home.

## Organisation row, hosted beats and member note (Sep 23 2026)

What each first-run surface depends on, and how it was checked:

| Who opens the app | What they get | Checked by |
|---|---|---|
| Desktop app, own server (full bridge, `remoteClient` present) | The same flow as before, decided without a new request | `src/components/onboarding/WelcomeGate.test.ts`; `HelloBeat`/`EnginesBeat` HTML compared byte for byte with main (no bridge) |
| Hosted workspace opened inside the desktop app (reduced bridge, no `remoteClient`) | Treated like a browser: the server is asked | `src/components/onboarding/WelcomeGate.test.ts` |
| Packaged desktop with the organisation bridge | An optional "Using OpenMausBot at work?" row on the engines beat; a signed-in Company engine counts as ready | `src/components/onboarding/beats/OrganisationRow.test.ts`, `src/components/onboarding/beats/EnginesBeat.test.ts` (fake bridge) |
| Browser, admin of a hosted workspace | Greeting (no inputs) and the bot beat only | `src/components/onboarding/WelcomeGate.test.ts`, `src/components/onboarding/beats/HelloBeat.test.ts`, `src/lib/onboarding.test.ts` |
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
(see [organisation connection](organization-settings.md), not rerun for this
change), and a real hosted tenant's browser. The hosted beat set was rendered
from a temporary preview entry, not reached through a hosted sign-in.
