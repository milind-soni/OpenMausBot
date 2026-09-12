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
