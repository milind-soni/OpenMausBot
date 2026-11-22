# Composio project key

Run the permanent checks from a clean checkout:

```sh
pnpm exec vitest run server/composio-own-key.e2e.test.ts server/composio-live.e2e.test.ts server/composio-own-backend.test.ts
```

The end-to-end test launches the shared `launchVerificationServer` fixture
(`scripts/control-omb.ts launch`) with its fake engine, temporary home and
explicit loopback URL. Composio is `server/testing/fake-composio-project.ts`,
named by `OMB_COMPOSIO_API`. No live models, computers, credentials, user data
or external services are used.

The assertions cover:

- `PUT /api/config` saves a fake `ak_` project key. `GET /api/config` and the
  save response show that a key is configured and its last four characters,
  never the key.
- `GET /api/connectors/catalog` lists the stand-in's apps.
- `POST /api/connectors/:slug/authorize` returns a connect link. The test
  completes the fake connect and does not open the link.
- A bot is granted one read. The fake engine calls it through the session MCP
  (`POST /api/internal/connectors/mcp`) and the transcript receives the
  stand-in's result.
- A second turn calls a tool that was not granted. The transcript carries the
  refusal, and the stand-in records no such call.
- The key is absent from the transcript, the server log and the API responses.
  Every fetch the fixture made, and every hit the stand-in recorded, stayed on
  127.0.0.1.

`server/composio-live.e2e.test.ts` is skipped unless
`EDUBOT_COMPOSIO_TEST_KEY` is an `ak_` key. With one, it lists the catalog,
opens a throw-away session, asks for a connect link on a toolkit that needs no
account, runs one read, and deletes that user's connected accounts. It never
uses Gmail or an account a person owns. CI supplies the secret only for this
repository's own runs, and the secret is absent, so CI skips it.

## Bounds and limitations

The stand-in is not Composio. It serves three toolkits, one session MCP and a
connect link that is never followed. The live file is the only check against
Composio, and only when the key is present. Grants, the session MCP and the
refusal are the desktop own-key path.
