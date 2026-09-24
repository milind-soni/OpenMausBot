# Bring your own engine

Two zero-code ways to run OpenMausBot bots on an engine the app doesn't ship.
Both live in `~/.openmausbot/config.json` under `"instances"`; restart the app
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
- OpenAI-compatible instances support structured tools and image input. With a
  model that accepts both, the harness can mount the approved host, Local VM,
  VPS, Box cloud or built-in browser tools and return their screenshots to the model.
  The existing platform, computer-selection and approval checks still apply.
  Box turns retain the selected API model in direct chats, rooms and cloud
  routines. Other drivers continue to use the native Box runner.
- Set `config.tools` to `false` for a model without tool support. Image support
  also depends on the chosen model; the driver cannot add vision to a text-only
  model. See [tool verification](verification/openai-tools.md) for scope and tests.

## Notes

- `config.json` is written with mode 0600; values in `environment` are stored
  as plaintext in that file. Prefer keys scoped to the one engine.
- A typo'd `driver` or invalid `config` never breaks the app: the instance
  shows as unavailable with the reason, and the rest of the fleet loads.
