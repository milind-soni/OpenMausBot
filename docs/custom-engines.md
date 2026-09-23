# Bring your own engine

Three configuration-based ways to connect engines or model providers.
These live in `~/.openmausbot/config.json` under `"instances"`; restart the app
after editing (instance entries are read at boot).

## Provider icons

In **Settings → Engines**, expand an instance and choose its **Provider icon**.
The built-in choices include OpenAI, Anthropic, Google Gemini, Microsoft Azure,
Amazon Bedrock (AWS), xAI, DeepSeek, Meta, Mistral AI, Qwen, Moonshot AI,
Cohere, and OpenRouter. You can also upload a PNG, JPEG, or WebP image up to
128 KB and 1024 × 1024 pixels. **Reset** restores the default icon.

Each instance has its own icon, independent of its driver or API protocol.
Changes made in Settings apply immediately without restarting the engine.
For file-based configuration, add `"icon": { "kind": "preset", "preset": "azure" }`
alongside `driver` and `displayName`. Custom uploads are stored as embedded image
data; the app does not fetch remote icon URLs.

## Codex harness with a custom model provider

Use this when you want Codex to run the agent loop and tools while a different
endpoint supplies the model. Install Codex, then configure a separate instance:

```json
{
  "instances": {
    "codex-custom": {
      "driver": "codex",
      "displayName": "Codex / My Provider",
      "environment": { "MY_MODEL_KEY": "your-provider-key" },
      "config": {
        "provider": {
          "name": "My Provider",
          "url": "https://models.example/v1",
          "apiKeyEnv": "MY_MODEL_KEY",
          "models": ["my-model"]
        }
      }
    }
  }
}
```

- The endpoint must implement the **Responses API streaming and tool-call
  protocol that Codex uses**. Chat Completions-only and Anthropic-native APIs
  need a compatible adapter; changing the URL alone does not translate them.
  These settings map to the native [Codex provider configuration](https://developers.openai.com/codex/config-reference/).
- `models` supplies the picker catalog; its first entry is the default. The
  driver rejects selections outside that list. Model IDs can include local tags
  such as `model:latest`. Model discovery is not performed for these instances.
- `apiKeyEnv` reads only this instance's `environment`, never an ambient shell
  credential. Omit both fields for a keyless local server. Use HTTPS for remote
  endpoints; HTTP is accepted on loopback, for example `http://127.0.0.1:1234/v1`.
  URLs cannot contain credentials, query parameters, or fragments.
- The provider is selected explicitly on new and resumed native threads.
  Custom instances do not offer ChatGPT sign-in or sign-out. The configured
  credential is passed to Codex through its child environment, not command-line
  arguments. Setup status does not prove the endpoint accepts the key.
- Create separate instances for different providers, even when they serve
  identically named models. Custom routing cannot be combined with Company
  routing in the same instance. Your native `config.toml` is not rewritten.
- Codex's existing MCP connections remain available, including OpenMaus
  computer tools and custom MCP servers. The model must support tool calling;
  screenshot-based computer control also needs image support. A third-party
  computer backend needs a compatible MCP interface or a separate adapter.
  This configuration does not install a computer backend.

Verification and current limitations: [Codex custom providers](verification/codex-providers.md).

For Azure GPT, Google Gemini 3.8 Flash, and Bedrock Claude together, use the
[shared gateway setup](../deploy/gateway/README.md). It keeps all three on Codex
and translates the provider protocols through LiteLLM.

### Alumnium browser automation

Alumnium 0.21.0 provides a stdio MCP server through `alumnium mcp`. Add it
through OpenMaus's custom MCP settings using the path to your installed
`alumnium` executable, arguments `["mcp"]`, and its model-provider environment
variables. Configure `ALUMNIUM_MODEL` separately from the Codex model; Alumnium
runs its own model-assisted browser actions.

Its MCP tools include `start`, `do`, `get`, `check`, `fetch_accessibility_tree`,
`wait`, and `stop`. Codex can call those tools through the existing custom MCP
connection. Alumnium handles browser automation; desktop applications require
a separate computer backend. The MCP handshake and tool discovery were checked
in a temporary home, without opening a browser. A complete browser task through
Codex has not yet been verified.

## Any ACP agent (a CLI you spawn)

If an agent CLI speaks [ACP](https://agentclientprotocol.com) over stdio —
`fx acp`, a Zed-style agent server, your own wrapper — point a `customAcp`
instance at it:

```json
{
  "instances": {
    "my-agent": {
      "driver": "customAcp",
      "displayName": "My Agent",
      "environment": { "MY_AGENT_TOKEN": "…" },
      "config": { "cli": "my-agent acp" }
    }
  }
}
```

- **`config.cli`** is the whole command, args included (`"npx -y some-agent acp"`
  works). You can also set it from the app: Settings → Engines → *Set CLI…* on
  the instance's row. An instance without a command shows up with exactly that
  hint instead of failing at first message.
- **Sign in first.** The driver has no auth flow of its own — run the CLI once
  in a terminal and log in there; OpenMausBot spawns it with your login intact.
- **Model choice stays inside the agent.** The picker shows a single
  "Agent default" entry; whatever the CLI is configured to run is what runs.
- **`environment`** is passed to the CLI child. Foreign provider keys
  (XAI_API_KEY, OPENAI_COMPAT_API_KEY, …) are deliberately stripped so a
  custom CLI can never bill against another engine's login.
- **Permissions** ride ACP's own `session/request_permission` — if your agent
  asks, the request becomes a normal approval card in chat.
- Multiple instances are fine — one per agent.

## Any OpenAI-compatible endpoint (no process at all)

The built-in `openai-compat` driver supports multiple instances, so a local
vLLM/LM Studio/Ollama-openai endpoint or any hosted compatible API is one
entry:

```json
{
  "instances": {
    "my-endpoint": {
      "driver": "openai-compat",
      "displayName": "My Endpoint",
      "environment": { "MY_ENDPOINT_KEY": "sk-…" },
      "config": {
        "url": "http://127.0.0.1:1234/v1",
        "apiKeyEnv": "MY_ENDPOINT_KEY",
        "model": "my-model"
      }
    }
  }
}
```

- `apiKeyEnv` names which `environment` value carries the key, so several
  instances can hold different keys without colliding.
- The driver lists the endpoint's `/models` when it can and keeps your
  `model` as a custom option either way.
- Honest limits: chat text + reasoning streams only — **no tool calls**, so
  bots on these instances answer and write, but don't operate computers or
  connected apps.

## Notes

- `config.json` is written with mode 0600; values in `environment` are stored
  as plaintext in that file. Prefer keys scoped to the one engine.
- A typo'd `driver` or invalid `config` never breaks the app: the instance
  shows as unavailable with the reason, and the rest of the fleet loads.
