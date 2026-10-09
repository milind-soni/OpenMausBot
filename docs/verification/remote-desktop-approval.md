# Owner-enrolled desktop approval

An owner can confirm Full access for one conversation from a saved remote
server, including a Tailscale connection. Both computers must run the updated
packaged desktop app. A browser, the separate companion relay, and a headless
server do not acquire this authority.

## One-time setup

1. On the laptop, select the saved server in the Server menu. Pair with an
   admin session if it is not already paired. Use HTTPS or the full Tailscale
   `.ts.net` address; plain HTTP on other networks is refused.
2. Choose **Server → Authorize this laptop for Full access**. Keep the native
   fingerprint dialog open.
3. In the host's packaged app, select **This computer**, then **Server →
   Desktop approval devices**. Review the pending device. Compare every
   fingerprint group and the device ID with the intended owner's laptop.
   Authorize only when they match. Requests expire after two minutes.
4. On the laptop, select **Full access** in the conversation's composer.
   Confirm the native warning, which identifies the server, bot and thread.

Existing pairing does not enroll a key. An admin cookie or a device label
cannot authorize enrollment. Native key material and explicit owner bindings
stay in the OS-encrypted desktop credential document. Custom and bot defaults
are outside this feature. The host's same menu revokes a binding.

## Connection lifetime

The laptop renews a signed lease every four seconds while that saved server
remains selected. If it disconnects, switches servers, quits, loses its
pairing or loses its owner binding, the selected conversation returns to Ask
within twenty seconds (plus the server's 500 ms cleanup tick). A running
direct turn on that conversation is interrupted. This is not an offline
grant; keep the laptop connected. Other conversations and bot defaults keep
their settings. Already delegated work retains its existing Stop semantics.

Each grant is journaled on the host before the existing private
`set → confirm → activate → finalize → commit` exchange. A host restart
recovers journaled conversations to Ask before accepting work. A newer local
desktop selection supersedes an older remote recovery for the same scope.

## Verification

Install with the version from `packageManager`:

```sh
npx --yes pnpm@10.33.0 install --frozen-lockfile
npx --yes pnpm@10.33.0 exec electron scripts/smoke-approval-modes.cjs --remote-approval-only
npx --yes pnpm@10.33.0 exec electron scripts/smoke-approval-modes.cjs
npx --yes pnpm@10.33.0 exec vitest run server/remote-desktop-approval.test.ts server/full-access-workflows.e2e.test.ts src/state/store.test.ts src/components/ApprovalModeSelector.test.ts electron/desktop-companion-client.test.mjs
npx --yes pnpm@10.33.0 run test:electron
npx --yes pnpm@10.33.0 run typecheck
npx --yes pnpm@10.33.0 run lint
npx --yes pnpm@10.33.0 run check:electron
```

The remote smoke runs the real server as an Electron utility process with a
disposable home and fake providers. It uses the production signature,
enrollment, native-client and private-protocol modules, plus a hidden Electron
window mounting the real Composer. The saved origin is mapped to the fixture
over a synthetic transport. Native dialog decisions and encrypted document
storage are fixture callbacks; the smoke does not enroll any real device,
exercise macOS Keychain, send real Tailscale traffic or launch the installed
application.

Evidence includes native cancellation, lost commit-reply recovery, paired
owner success and persisted thread state, rejection of HTTP Full/Custom,
unpaired/bot-token/chat-only callers, wrong origins and unenrolled keys,
pairing revocation, unchanged siblings/default, and the Composer with no
local approvals bridge and no remote Custom option. Node tests cover
signature replay, expiry, wrong workspace/device/boot/target, owner-binding
revocation and the shared warning. Server tests cover private-phase pairing
checks, disconnected requests, lease expiry, crash recovery and superseding
local choices. The original smoke retains provider, question and credential
regressions. These fixtures do not claim a signed packaged-app installation
or two physical computers were exercised.
