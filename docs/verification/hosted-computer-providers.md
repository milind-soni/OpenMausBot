# NATION managed Orgo and Daytona computers

This change builds on the member workspace isolation in PR #31. It does not
enable a provider or make the service ready for public invites.

## What each provider adds

| Provider | Useful for | Integration |
| --- | --- | --- |
| Orgo | Browser and Linux desktop workflows | Workspace-scoped REST API; persistent computer per workspace/account/agent |
| Daytona | Repositories, commands, builds, tests and desktop work | Official TypeScript SDK 0.218.0; private persistent sandbox per workspace/account/agent |

Both expose `computer_execute` and `computer_screenshot` to supported model
drivers. Desktop input uses shell tools such as `xdotool`. The built-in Browser
remains a separate surface. The member Computer panel offers Start, Sleep and
Screenshot; this change does not add an interactive VNC viewer or migrate files
between providers. Existing Box and VPS computers keep their assignment.

API contracts checked against:

- https://docs.orgo.ai/llms.txt
- https://docs.orgo.ai/api-reference/computers/create
- https://docs.orgo.ai/api-reference/computers/bash
- https://www.daytona.io/docs/en/typescript-sdk/
- https://www.daytona.io/docs/en/computer-use/
- https://www.daytona.io/docs/en/persistence/

## Admin setup

1. Open `/admin` and the integrations section, **Additional cloud computers**.
2. For Orgo, enter a workspace-scoped API key and that workspace's ID.
3. For Daytona, enter an API key and an **active desktop-enabled snapshot** from
   the same account. The snapshot needs the desktop services supported by
   Daytona Computer Use and `xdotool` for shell-based desktop input.
4. Enable the desired provider and click **Check and save providers**. This
   validates Orgo workspace access and/or Daytona snapshot access without
   creating a billable machine. It cannot validate desktop boot without one.
5. Choose a default for new agents, or change an existing agent's cloud provider
   in its settings. Enable NATION computer access if it is switched off.
   Existing member workspace processes retain their launch configuration;
   restart idle workspaces to apply changes. Existing agents retain their provider.
6. Select Cloud and Start when ready to allocate a computer. Auto only reuses
   a running machine; it does not create or wake one. Blank key fields keep
   saved credentials. Disable a provider to stop new access, and manage any
   existing machines in its provider dashboard before retiring credentials.

Keys stay in server configuration, not responses, workspace config files,
model prompts or the MCP tool environment. Tools receive a per-turn capability
bound to their account's computer and lose access when the turn ends.
Private workspace servers receive the admin-managed configuration from the
parent; they do not accept member-supplied provider credentials.

Sleep preserves disk. Daytona is created private, with 30-minute auto-stop,
auto-delete disabled and no ephemeral mode. Orgo uses the provider's freeze
operation. NATION offers no delete action here. Provider console deletion or
provider retention rules remain outside NATION's control. Missing resources
raise an error rather than silently replacing the user's disk.

Machine runtime/storage are billed by the provider to the admin account. They
are **not yet deducted from member credits**. Review provider quotas before
enabling member access. This PR is disabled by default and not a rollout.

## Isolated automated verification

No test uses production services, credentials or user data.

```sh
pnpm typecheck
pnpm exec vitest run server/hosted-computers/manager.test.ts server/routes/hosted-computers.test.ts server/hosted-computers.e2e.test.ts src/components/HostedComputerAdmin.test.ts
pnpm build
pnpm build:server
node scripts/smoke-packaged-server.mjs
node --experimental-strip-types scripts/smoke-hosted-computers.mjs
```

The end-to-end test uses `launchVerificationServer`, an isolated account gateway,
real member workspace children, a loopback model and loopback provider APIs.
The Daytona test calls the actual SDK, including sandbox and toolbox endpoints.
It verifies configuration gating, write-only keys, remote command execution,
screenshots, separate files for two accounts, sleep/start persistence, unchanged
existing agent assignments, blocked direct member commands and neutral errors.
Manager and route tests cover restart recovery, an uncertain create response,
conflicting operations, forged targets and turn revocation during lookup.

Read-only UI rendering tests check field labels, secret masking, provider gating
and member visibility. They do not prove a live browser interaction with Admin.

On the development runner, two pre-existing Linux process-cleanup cases in
`server/workspace-host.test.ts` fail: "end with the workspace" and "clears what
an earlier run left". Both failures reproduce unchanged at base commit
`bbce133f7481d6fafa430adb9d5eef0444ca5ced`. The first sees a `/proc` PID different
from the spawned child's PID; the second times out. This change does not alter
process cleanup. Other workspace configuration and lifecycle tests pass.

## Live acceptance still required before enabling for members

Use a dedicated staging provider workspace/account and an isolated NATION
fixture with explicit staging configuration, never an existing member's data.
Allocate one computer per provider, run a short command, inspect a screenshot,
perform a desktop click, sleep/start and confirm a saved file still exists.
Check the provider dashboard for the machine's retention and billing settings.
Also confirm configured account quotas and member runtime billing policy.
Automated fixture success is not evidence of a paid account's desktop image,
capacity, permissions or live service availability.
