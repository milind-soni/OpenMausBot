# Codex model gateway

Use only synthetic loopback providers and disposable homes for local checks.
Do not point this verifier at a running app or real model endpoint.

```sh
python3.13 -m venv /tmp/openmaus-gateway-test
/tmp/openmaus-gateway-test/bin/pip install -r deploy/gateway/requirements.txt
/tmp/openmaus-gateway-test/bin/python scripts/verify-model-gateway.py
pnpm exec vitest run scripts/model-gateway-config.test.mjs server/codex-providers.e2e.test.ts
```

The Python verifier starts the pinned, real LiteLLM proxy with the deployment
configuration, substituting synthetic credentials and loopback upstream URLs.
It launches the native Codex verifier with fresh homes for Azure, Google, and
Bedrock. Each must call an inert MCP computer tool, receive its text and PNG
image result, finish
the turn, and resume the thread. The upstream fixture handles Azure Responses
SSE, Gemini streaming content, and Bedrock Converse binary event streams. It
also checks that Bedrock uses AWS SigV4 signing. Retained JSON records the
provider paths, tool names, and receipt of the synthetic result and image; it contains
no real credentials. The fixture uses a whitelisted environment and cleans up
only its own processes and temporary data. Logs and JSON evidence paths are
printed on completion or failure.

The server test separately uses the repository's isolated
`launchVerificationServer` and `control-omb` surface to create a bot, switch
custom providers, send, wait, and read the transcript. Configuration tests check
the three Codex instances, Gemini default, private file permissions, and refusal
to overwrite an existing workspace.

2026-09-16: native Codex 0.154.0 and LiteLLM 1.101.0 passed all three protocol
routes, including start/resume and MCP text/image results. Azure used `/openai/responses`;
Google used `:streamGenerateContent`; Bedrock used `/converse-stream`. Namespace
tools were preserved through the translations. A missing translation for
Codex's optional `prompt_cache_key` was observed on Gemini and resolved with a
targeted gateway setting. No general parameter-dropping policy is enabled.

Limits: synthetic provider responses do not prove live model access, real model
tool behavior, image understanding, or browser/desktop execution. A Linux Docker
build, real provider credentials, and the GCP deployment remain separate checks.
