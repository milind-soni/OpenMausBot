# Hosted Slack management entry point

Read [the verification entry point](README.md) first. On a hosted organization
workspace, agent settings gain a Slack section with one link, Manage in Admin,
which opens the configured Admin service's `/slack?workspace=<workspace>&bot=<agent>`
page in a new tab. That page is where the agent gets its own Slack app. This
app holds no Slack logic: it never contacts Slack, stores no Slack credential,
and reports no connection status. Names and avatars remain editable in the
agent's Identity section.

`GET /api/bots/:id/slack-management` lives in the route module
`server/routes/hosted-slack.ts`, registered in the route table from
`server/index.ts`. It is a client-scoped read (`server/request-auth.ts`), so a
member who opens agent settings gets the same link as an admin; every other
method on the path stays admin-only and unrouted. It returns
`{available:true, managementUrl}` only when the agent exists and the runtime
has complete hosted configuration (an https Admin origin and a valid workspace
slug), portal membership, the workspace access hook, and a live `admin`
entitlement. Hidden or missing agents return 404. A local install and a
local-membership workspace return `{available:false}`, not an error, and the
Slack section is then absent from the settings rail. The URL is built from
configuration and the stored agent id, never from request input, and carries
no session, portal grant, or Slack token; Admin authenticates and authorizes
its own visitors.

Run these disposable fixtures:

```sh
pnpm exec vitest run server/hosted-slack.test.ts server/routes/hosted-slack.test.ts server/request-auth.test.ts server/hosted-access.test.ts
pnpm exec vitest run src/components/bot-settings/SlackSection.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/slack-management-ui.e2e.test.ts
pnpm typecheck
pnpm lint
```

The route test serves the module through the route table on a real HTTP
server: the hosted answer, `{available:false}` for a local install, a hook
that is not live and local membership, 404 for missing and hidden agents, and
a pass for every other method and path. The hosted-access test starts an owned
server with a temporary home and fake Admin backchannel. It proves the real
route returns the correct agent link to an admin and to a member, rejects
missing and hidden agents, revokes a demoted admin's session, refuses a
member's write and an unauthenticated read, and withholds the link in local
membership mode. The helper tests cover incomplete or invalid configuration
and URL parameter boundaries.

The UI test launches `control-omb ui` with the real renderer and a disposable
fake-engine workspace. It checks that the real API answers `{available:false}`
and that the settings rail has no Slack row, then supplies synthetic Admin
responses only inside that browser page. It checks the row, its copy and the
agent-specific link (new tab, `noopener noreferrer`, one link and no other
control), that an unavailable, denied or failed read removes the row, and that
an old response cannot surface after switching agents. It writes a settings
screenshot beside the fixture's retained server log and prints both paths.
The owned launcher removes its temporary workspace on exit. Set `OMB_UI_E2E=1`
to install the harness's pinned browser when it is not already available;
without a browser the test skips itself, as it does in the sharded CI run.

These checks prove the settings entry point and its boundary. They do not
install a Slack app, publish an agent, synchronize a Slack profile, or
exercise Slack messages. The separately deployed Admin service owns those
workflows and needs its own isolated fixtures.
