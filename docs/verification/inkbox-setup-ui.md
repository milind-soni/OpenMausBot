# In-app Inkbox setup renderer verification

Use Node 24 and the installed Electron development dependency:

```sh
pnpm exec electron scripts/testing/inkbox-setup-ui-smoke.cjs
```

This smoke opens a hidden real Electron browser window using the app's React
component, state context, Vite pipeline and styles. It owns a disposable
Electron profile and a fake API bound to a new loopback port. The fixture
contains only synthetic bots, credentials, phone numbers and delivery records.
All external renderer network requests are blocked. It never starts, discovers
or modifies the user's app, and never contacts Inkbox or sends a message.

It checks bot selection, the submitted setup request, key clearing while setup
is pending, disabled form controls, a locally generated QR and the actual
provider SMS URI shape (`sms:+…?&body=…`), copying the connect message with visible
feedback, transition from transport readiness
to an observed message, disconnect, and reconnect without entering another key.
It also verifies that the synthetic key is absent from the rendered document
and local storage. A fixture clipboard captures the copied text in the test
window without replacing the user's actual clipboard. An assertion or renderer error makes the command fail.

The script writes five screenshots and `result.json` to
`.omb-scratch/verify-evidence/inkbox-setup/`, then closes the preview server,
fake API and browser and deletes the temporary profile. The screenshots cover
the empty form, pairing instructions, observed delivery, disconnected state and a narrow layout. Channel availability and unsupported-channel labels are also asserted.
The setup request body is asserted in memory and excluded from saved evidence.

Interactive lifecycle and race regressions also run in the focused UI suite:

```sh
pnpm exec vitest run src/components/InkboxSetupSection.test.ts
```

That suite covers incomplete setup errors, cancellation while setup is pending,
late success after cancellation, replacing a disconnected saved connection,
invalid phones, duplicate submits and stale polling. It uses the repository's
shared isolated test setup and requires Node 24 for its `node:sqlite` import.
These checks establish renderer behavior against synthetic responses. Provider
provisioning, native secure storage, phone opt-in and real iMessage delivery
require their respective backend tests or an explicitly authorized live check.
