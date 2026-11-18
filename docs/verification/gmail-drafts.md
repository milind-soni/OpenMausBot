# Gmail draft creation, send approval and revision

In the bot's Permissions settings, choose **Ask every time** under
**Sending on your behalf**. Connected-app sends require consent at every
access level, including Full access, regardless of the prompt's language.
An Allow applies to the pending call, not later sends. **Send without asking**
instead authorizes automatic sends with no daily limit, as does Full access
with no setting. Reading and drafting are not sends. Opaque app code
execution needs consent because its effects cannot be read.

Run the isolated server and bridge regressions:

```sh
pnpm exec vitest run server/trust-controls.e2e.test.ts server/connected-app-tools.e2e.test.ts server/connector-proxy.test.ts server/connector-app-tools.test.ts server/gmail-draft-policy.test.ts server/outbound-hold.test.ts
```

The trust-controls fixture launches disposable verification servers and points
Composio at a loopback stand-in. It verifies:

- Ask every time holds Gmail sends, replies, forwards, Slack sends, opaque
  execution and mixed create/send batches at Full access. Denial leaves the
  provider untouched; approval releases only that call.
- Spanish, Hindi, French, Japanese and English requests need consent before
  the first send, with no draft write or request-wording classification.
- Send without asking permits sends at Full access with no card, and a
  Full-access bot with no setting sends 35 in a row without a refusal or a
  card. Explicit draft-and-send requests follow the same policy. Sending a
  draft after a draft write also uses the configured policy.
- The draft tools create one reply draft and update its existing ID while
  retaining the Gmail thread. Repeated creation for the same thread within
  the originating request is refused, including after delegation and resuming.
  Independent requests must still check existing drafts before creating one.
- Delegated and resumed Full-access turns respect each bot's outbound policy.
- Switching from Send without asking to Ask every time while session
  metadata is pending refuses dispatch. Fresh scope checks run before draft
  reservations, so a scope refusal does not consume a creation attempt.

The bridge tests verify read-only app grants hide draft writes and native
updates map to GMAIL_UPDATE_DRAFT. The fixture retains its server log and a
`.trust-controls.json` evidence file under the temporary verification evidence
directory. Evidence records API requests, responses and provider calls; the
disposable application data is removed on completion.

These checks prove relay enforcement and draft-tool argument mapping. They do
not verify Gmail rendering, Composio's MIME reply headers or a model's ability
to follow natural-language drafting instructions. The relay does not classify
request wording. Send without asking authorizes automatic sends; use Ask every
time when each send needs review. Draft revisions use the existing draft ID,
not a language-based prohibition on creating drafts.
