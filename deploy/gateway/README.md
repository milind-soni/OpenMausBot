# Codex with Azure, Google, and Bedrock

This optional Compose override runs one Codex harness with three selectable
model providers. LiteLLM translates Codex's Responses requests where needed.

| OpenMaus instance | Model alias | Upstream |
| --- | --- | --- |
| Azure / GPT | `azure-gpt` | Azure GPT deployment, Responses |
| Google / Gemini 3.8 Flash | `gemini-3.8-flash` | Google Gemini API |
| Bedrock / Claude | `bedrock-claude` | AWS Bedrock Claude, Converse |

Gemini is the initial default. Set the full Azure deployment name in
`AZURE_MODEL=azure/DEPLOYMENT`. Set the region and a Claude model or inference
profile your AWS account can invoke in `BEDROCK_MODEL=bedrock/converse/ID`.
The gateway does not switch providers on failure. Provider keys stay in the
gateway container; the app receives only a separate local gateway key.

OpenMaus supplies browser and computer tools through Codex's existing tool
connection. They do not require an OpenAI-hosted computer-use model. The chosen
model must support the relevant tool calls and, for screenshots, image inputs.
The base image includes Chrome and agent-browser. Full desktop control needs
a separately configured OpenMaus computer backend; this stack initially enables
the built-in browser.

## Fresh workspace

Run these commands at the repository root on the chosen host. The first build
compiles this checkout, including local changes; it pins Codex to 0.154.0 and
LiteLLM to 1.101.0.

```sh
cp deploy/gateway/.env.example deploy/gateway/.env
chmod 600 deploy/gateway/.env
```

Fill in the Azure endpoint/key/deployment, Google key, and Bedrock model/region
and credentials. Bedrock accepts either AWS credentials (plus a session token
when temporary) or `AWS_BEARER_TOKEN_BEDROCK`. Credentials must have inference
access to the selected Claude model. Generate a private gateway key, for example
with `openssl rand -hex 32`, and put it in `OPENMAUS_MODEL_GATEWAY_KEY`.
The `.env` file is excluded from Git and the app Docker build context.

```sh
docker compose --env-file deploy/gateway/.env -f compose.yaml -f deploy/gateway/compose.yaml build
docker compose --env-file deploy/gateway/.env -f compose.yaml -f deploy/gateway/compose.yaml run --rm --no-deps omb node /opt/openmaus-gateway/configure.mjs --output /data/.openmausbot/config.json
docker compose --env-file deploy/gateway/.env -f compose.yaml -f deploy/gateway/compose.yaml run --rm --no-deps omb node /opt/openmaus-gateway/configure-reviewer.mjs --codex-home /data/.codex
docker compose --env-file deploy/gateway/.env -f compose.yaml -f deploy/gateway/compose.yaml up -d
docker compose --env-file deploy/gateway/.env -f compose.yaml -f deploy/gateway/compose.yaml ps
docker compose --env-file deploy/gateway/.env -f compose.yaml -f deploy/gateway/compose.yaml exec omb node dist-server/openmausbot.js pair
```

Bootstrap must run before the first server start. It creates private config in
the fresh data volume and refuses to overwrite an existing configuration. For
an existing workspace, explicitly add the three instances using the format in
[`configure.mjs`](configure.mjs) instead of rerunning bootstrap.

Wait for both app and gateway health checks before starting a conversation.
Open `http://localhost:8080` and pair. On a remote host, forward that host's
loopback port over SSH first. The app port stays bound to loopback; the gateway
listens on port 4000 within the app's shared container network namespace and
publishes no host port. Keep the same Compose files and env file on subsequent
commands. If the app container is recreated, recreate its network-sharing
gateway and Caddy sidecars together.

## Automatic review

Codex 0.154.0 otherwise requests `codex-auto-review`, which is not an alias in
this gateway. `configure-reviewer.mjs` generates model metadata from Codex's
bundled standard Responses catalog and sets `auto_review_model_override` to
`azure-gpt` for all three routes. Automatic review and its policy stay enabled;
the Azure GPT deployment performs review even when Gemini or Claude performs
the main task. Review context therefore reaches Azure for every provider.

The generated catalog lives in `/data/.codex/openmaus-models.json`; the script
preserves other Codex settings and backs up an existing config before adding
`model_catalog_json`. Codex reads this setting at process startup. Restart the
app after applying it to an existing installation, once active turns finish.
To roll back, remove that one setting or restore the saved config.

## Connected apps

The headless server needs either a Composio project key or a managed broker
installation. The packaged desktop normally registers its own installation;
headless deployments must provision one explicitly. For managed mode, provide
`OMB_COMPOSIO_BROKER_URL` and `OMB_COMPOSIO_BROKER_TOKEN` in the private Compose
environment. Keep the installation token in a secret store and preserve it
across restarts so connected accounts retain their identity. No project or
provider OAuth key is exposed to the browser.

After the connection service is configured, open **Connected apps**, choose an
app, and complete its sign-in flow. Provisioning the service does not authorize
personal accounts automatically.

## Validation

See [the gateway verification recipe](../../docs/verification/model-gateway.md).
Local tests prove native Codex request translation, start/resume, and synthetic
MCP computer-tool calls with screenshot images across all three protocols. They do not establish real
account permissions, model availability, screenshot understanding, or a working
Linux deployment. After deployment, exercise each provider and the built-in
browser with disposable test data before using a real workflow.

The gateway removes only the unsupported OpenAI `prompt_cache_key` hint for
Gemini and Bedrock. Other unsupported parameters still fail visibly.
