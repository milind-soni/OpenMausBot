# Gmail draft creation, send approval and revision

In the bot's Permissions settings, choose **Ask every time** under
**Sending on your behalf**. Connected-app sends require consent at every
access level, including Full access, regardless of the prompt's language.
An Allow applies to the pending call, not later sends. **Allow a daily amount**
instead authorizes automatic sends up to the configured cap, including at
Full access. Reading and drafting never consume the allowance. Opaque app
code execution needs consent because its effects cannot be counted.

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
- The daily allowance permits sends at Full access, consumes the cap, and
  refuses further sends after it is exhausted. Explicit draft-and-send
  requests follow the same policy. Sending a draft after a draft write also
  uses the configured policy.
- The draft tools create one reply draft and update its existing ID while
  retaining the Gmail thread. Repeated creation for the same thread within
  the originating request is refused, including after delegation and resuming.
  Independent requests must still check existing drafts before creating one.
- Delegated and resumed Full-access turns respect each bot's outbound policy.
- Switching from an allowance to Ask every time while session metadata is
  pending refuses dispatch. Fresh scope checks run before draft reservations,
  so a scope refusal does not consume a creation attempt.

The bridge tests verify read-only app grants hide draft writes and native
updates map to GMAIL_UPDATE_DRAFT. The fixture retains its server log and a
`.trust-controls.json` evidence file under the temporary verification evidence
directory. Evidence records API requests, responses and provider calls; the
disposable application data is removed on completion.

These checks prove relay enforcement and draft-tool argument mapping. They do
not verify Gmail rendering, Composio's MIME reply headers or a model's ability
to follow natural-language drafting instructions. The relay does not classify
request wording. A daily allowance authorizes automatic sends; use Ask every
time when each send needs review. Draft revisions use the existing draft ID,
not a language-based prohibition on creating drafts.
