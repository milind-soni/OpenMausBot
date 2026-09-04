# Bring your own engine

Two zero-code ways to run OpenMausBot bots on an engine the app doesn't ship.
Both live in `~/.openmausbot/config.json` under `"instances"`; restart the app
after editing (instance entries are read at boot).

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
  connected apps. The one exception is the preview engine below, which runs
  its own tool loop.

## OpenMaus Runtime (preview): the loop runs inside OpenMausBot

Every other engine hands the inner model/tool loop to an installed CLI or a
one-shot chat endpoint. This one runs it in-process — model call, tool call,
approval, steering, cancellation — against any OpenAI-compatible endpoint.
It is off until you enable it in Settings → Experimental features, and no
existing bot is moved onto it; you pick it per bot in the model menu.

- **It does not use a Claude or Codex login.** Authentication is an API key
  (the same `openaiCompat.key` the OpenAI-compatible engine uses) or a local
  server that needs none. Usage is billed by that provider.
- **No key is accepted only for a local endpoint** — loopback or a private
  network address (`127.0.0.1`, `localhost`, `10.x`, `192.168.x`, `172.16–31.x`,
  `[::1]`, `fd..`). A remote URL with no key shows as unavailable and says so;
  every prompt would otherwise go to a host you never authenticated with.
- **Tools:** your own `mcpServers` from `config.json` mount as tools, namespaced
  by server. Every call asks for approval through the ordinary card, or your
  auto-approve rules; an unanswered ask is a deny, never an allow.
- **Context:** the engine row and model menu show `Context: OpenMaus managed`
  alongside `API key · billed by the provider` — two labels on purpose. Who
  owns the conversation's context and how the engine is paid for are separate
  questions, and this is the engine where they differ.
- Bounds: 32 model calls and 64 tool calls per turn, 180 s per tool, and a stop
  after the same call is repeated five times.

## Notes

- `config.json` is written with mode 0600; values in `environment` are stored
  as plaintext in that file. Prefer keys scoped to the one engine.
- A typo'd `driver` or invalid `config` never breaks the app: the instance
  shows as unavailable with the reason, and the rest of the fleet loads.
