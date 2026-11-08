# Claude custom endpoints

A custom endpoint is a Claude bot engine of its own: it points Claude Code at
DeepSeek, GLM or another host that speaks Claude Code's API, with its own
directory, while the Claude Code on this computer keeps its sign-in. This
recipe uses only the disposable fixture and the fake Claude CLI; it never
calls a real provider and never reads or writes a real `~/.claude`.

Launch the fixture and keep its printed `url`, `dataDir` and `logPath`:

```sh
node --experimental-strip-types scripts/control-omb.ts launch
```

Its `config.json` has one **Verification fixture** Claude account whose CLI is
the repository's fake Claude CLI. The launcher always writes the latest turn's
spawn record to `<dataDir>/fake-claude-dump.json`; caller-supplied
`FAKE_CLAUDE_DUMP` is replaced, so read that path.

## Settings section

Open `previewUrl` from the launch evidence, then Settings → Engines. Expand the
Claude card.

1. **Add endpoint** opens an empty form inside the card: name, base URL
   (placeholder `https://api.anthropic.com`), API key and an optional model.
   There is no provider selector. Save stays disabled until name, URL and
   (for a new endpoint) token are filled. A rejected save shows an alert and
   leaves the fields editable. A plain-HTTP host off this computer with no
   model is refused without sending the key; typing the model saves it.
2. Enter a synthetic gateway URL with an authenticated `/v1/models` catalog
   offering `deepseek-chat` and `deepseek-reasoner`. Save its name, base URL
   and fake token. A row appears with its address and **Edit** and **Remove**
   actions. The token is not shown anywhere.
3. **Edit** shows the saved address with the token field empty. Rename it,
   leave the token empty and save; both models remain available.
4. Create two bots on the endpoint. Choose `deepseek-chat` for one and
   `deepseek-reasoner` for the other in their agent settings. Each keeps its
   own model selection. Official Anthropic uses the standard model catalog.
5. Try **Remove** while a bot still uses the endpoint: the button is disabled
   and its tooltip says how many bots use it. Move the bot to another model,
   then remove it: only the row disappears, and Claude's own sign-in stays.

## HTTP and turn evidence

Against the printed `url` (loopback owner trust in the fixture). Set
`URL=<printed url>` in the same shell first:

```sh
curl -s -X POST "$URL/api/instances/claude-endpoint" \
  -H 'content-type: application/json' \
  -d '{"displayName":"DeepSeek verify","baseUrl":"https://api.deepseek.com/anthropic","token":"sk-verify-secret","model":"deepseek-chat","opusModel":"deepseek-reasoner"}'
```

The response is `201` with `instanceId` and the engine list; the endpoint row
carries `access: "custom"`, `url`, and `claudeEndpoint` with `baseUrl`,
`models` and `tokenSaved` — never the token. `GET $URL/api/instances` must not
contain `sk-verify-secret` either. `<dataDir>/config.json` now holds:

- `config.configDir` = `<dataDir>/providers/<instanceId>`
- `config.requireApiKey` = `true` and `config.endpointModels` = the served models
- `environment.ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_MODEL`, and a tier value for each non-empty mapping

Create a bot on the endpoint (`POST /api/bots` with
`modelSelection.model = "deepseek-chat"`), send a message and wait for idle.
`<dataDir>/fake-claude-dump.json` then shows the turn's `env` and `argv`:
`CLAUDE_CONFIG_DIR` is the endpoint's own directory, `ANTHROPIC_BASE_URL` and
`ANTHROPIC_MODEL` are the endpoint's, `ANTHROPIC_AUTH_TOKEN` is the fake token,
and `--model` is the endpoint's model. Nothing in the dump reads the
fixture's home `~/.claude`.

`PATCH $URL/api/instances/<instanceId>/claude-endpoint` with a new `model` and
`"opusModel": ""` keeps the saved token, replaces `ANTHROPIC_MODEL`, drops the
cleared tier, and shrinks `config.endpointModels` to the served models. A
missing instance is `404`; a named Claude account is `400`; an endpoint whose saved
token is gone is `400` and asks for the token.

`DELETE $URL/api/instances/<instanceId>` removes only the saved entry after the
bot moves off it; deliberately created files under its `providers/<id>`
directory stay (the fixture's fake CLI does not create the directory by itself).

## Regression suites

```sh
pnpm exec vitest run --no-file-parallelism server/claude-endpoints.test.ts server/claude-account-api.test.ts server/model-providers-docs.test.ts server/default-model-selection.test.ts src/components/ClaudeEndpoints.test.ts
pnpm typecheck
pnpm i18n:check
pnpm lint
```

## Limitations

This proves the wiring, isolation and API behavior with the fake CLI. It does
not prove that a real DeepSeek or GLM endpoint answers, because no real token
is used; do that once by hand with your own key. The Settings surface is
driven by hand; `control-omb` cannot drive Settings yet.