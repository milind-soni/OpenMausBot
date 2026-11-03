# Gmail draft creation and revision

Run the isolated server and bridge regressions:

```sh
pnpm exec vitest run server/trust-controls.e2e.test.ts server/connected-app-tools.e2e.test.ts server/connector-proxy.test.ts server/connector-app-tools.test.ts server/gmail-draft-policy.test.ts
```

The trust-controls test launches a disposable verification server, seeds its
own Full-access bot and points Composio at a loopback stand-in. It submits a
draft-only request through the messages API, then exercises the authenticated
connector relay with direct sends, draft sends, replies, forwards, opaque
execution and a mixed create/send batch. None may reach the stand-in.

One reply draft is created. A repeated creation in that turn is refused. A
new revision request must refuse creation and update the original draft ID;
the stand-in must retain exactly one draft with revised content and the same
Gmail thread ID. The bridge tests also check that read-only grants cannot
expose draft writes and that the native update maps to GMAIL_UPDATE_DRAFT.

The fixture retains its server log and a `.trust-controls.json` evidence file
under the temporary verification evidence directory. The JSON records API
requests, responses and the calls that actually reached the stand-in. The
fixture removes its disposable data on completion.

These checks prove the relay restrictions and tool argument mapping, not
Gmail's rendering or Composio's MIME header generation. The request guard
recognizes English draft and no-send wording; it is not a general natural
language authorization classifier. Duplicate reservations cover a single
turn, while revisions explicitly require updating by draft ID. Cross-turn
creation requests still require checking the existing drafts first.
