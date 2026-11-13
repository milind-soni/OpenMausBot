# Bring your own engine

Two zero-code ways to run OpenMausBot bots on an engine the app doesn't ship.
Both live in `~/.openmausbot/config.json` under `"instances"`; restart the app
after editing (instance entries are read at boot).

## Provider icons

Each instance shows its driver's mark. An OpenAI-compatible server shows the
mark of whoever runs it, read from the host in its address: `api.deepseek.com`
shows DeepSeek, `<resource>.openai.azure.com` Microsoft Azure,
`dashscope-intl.aliyuncs.com` or `<workspace>.<region>.maas.aliyuncs.com` Qwen,
`openrouter.ai` OpenRouter, and so on
(the list is `SERVER_HOSTS` in `server/provider-icon.ts`). A server without a
mark of its own, such as Groq, Together, Ollama or LM Studio, keeps the default.

An icon stored on the instance still wins: add
`"icon": { "kind": "preset", "preset": "azure" }` alongside `driver` and
`displayName`. The presets are OpenAI, Anthropic, Google Gemini, Microsoft
Azure, Amazon Bedrock (AWS), xAI, DeepSeek, Meta, Mistral AI, Qwen, Moonshot
AI, Cohere and OpenRouter. Custom images saved before v0.1.102 keep rendering;
the app never fetches remote icon URLs.

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
- **Choose models per bot.** Open the bot's model picker and use **Re-detect**
  to load the models advertised by the agent. Select a model and, when offered,
  its thinking level. Bot defaults and individual conversation overrides are
  saved independently. **Agent default** leaves the native session's model
  unchanged. An agent that does not advertise models still has this option.
- **Choices come from the agent.** Discovery starts a temporary ACP session
  without sending a prompt. Only confirmed, model-specific thinking options
  are shown; a failed refresh keeps the last successful catalog. ZCode,
  CodeBuddy, Qoder and other custom ACP engines use the same mechanism.
- **`environment`** is passed to the CLI child. Foreign provider keys
  (XAI_API_KEY, OPENAI_COMPAT_API_KEY, …) are deliberately stripped so a
  custom CLI can never bill against another engine's login.
- **Permissions** ride ACP's own `session/request_permission` — if your agent
  asks, the request becomes a normal approval card in chat.
- Multiple instances are fine — one per agent.

### Example: Mistral Vibe

[Mistral Vibe](https://github.com/mistralai/mistral-vibe) ships an ACP entry
point, `vibe-acp`, so it runs as a custom ACP engine with your Mistral account's
own sign-in, not a Mistral API key saved in OpenMausBot.

1. Install it: `uv tool install mistral-vibe` (or `pipx install mistral-vibe`).
   This puts `vibe` and `vibe-acp` in `~/.local/bin`.
2. Sign in once from a terminal: run `vibe --setup` and sign in with your
   Mistral account (Vibe offers a browser sign-in through Mistral AI Studio, or
   an API key). Vibe uses the first credential it finds in the shell
   environment, `~/.vibe/.env`, or the OS keyring, and `vibe-acp` uses it too.
3. Add the instance and restart OpenMausBot:

   ```json
   {
     "instances": {
       "mistral-vibe": {
         "driver": "customAcp",
         "displayName": "Mistral Vibe",
         "icon": { "kind": "preset", "preset": "mistral" },
         "config": { "cli": "/home/you/.local/bin/vibe-acp" }
       }
     }
   }
   ```

   Use the full path when `~/.local/bin` is not on the app's `PATH` (a desktop
   app started from the dock often doesn't have it).
4. Pick **Mistral Vibe** for a bot. Its model menu shows **Agent default**,
   which runs the model Vibe itself uses by default.

OpenMausBot never passes its own `MISTRAL_API_KEY` to the CLI, so turns use the
Vibe sign-in from step 2. Without it, the chat shows `Missing API key for
mistral provider`: sign in again from a terminal (step 2).

### Example: Command Code

[Command Code](https://commandcode.ai) has an ACP mode, `cmd acp`, so it runs as
a custom ACP engine with your own Command Code sign-in. (Checked with
`command-code` 1.88.2.)

1. Install it: `npm install -g command-code`. This puts `cmd` on your `PATH`;
   on Windows the command is `cmdc`, because `cmd` is the Windows command
   prompt.
2. Sign in once from a terminal: run `cmd login` (`cmdc login` on Windows).
   On a server without a browser, create an API key in Command Code Studio
   instead and put it in the instance's `environment` as
   `COMMAND_CODE_API_KEY`; OpenMausBot passes it to the CLI.
3. Add the instance and restart OpenMausBot:

   ```json
   {
     "instances": {
       "command-code": {
         "driver": "customAcp",
         "displayName": "Command Code",
         "config": { "cli": "cmd acp" }
       }
     }
   }
   ```

   Use `"cmdc acp"` on Windows, and the full path when the npm global folder
   is not on the app's `PATH`: `which cmd` on macOS or Linux, or
   `where.exe cmdc` on Windows.
4. Pick **Command Code** for a bot. Its model menu shows **Agent default**,
   which runs Command Code's own default model; **Re-detect** lists the models
   it advertises once you're signed in.

Without a sign-in the chat shows ``Not authenticated. Run `cmd login` in a
terminal first.``: sign in from a terminal (step 2). A wrong
`COMMAND_CODE_API_KEY` shows `401 error: Invalid 'Authorization' header or
token.`

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
  VPS, Boat cloud or built-in browser tools and return their screenshots to the model.
  The existing platform, computer-selection and approval checks still apply.
  Boat turns retain the selected API model in direct chats, rooms and cloud
  routines, as they do for every engine with computer tools.
- Set `config.tools` to `false` for a model without tool support. Image support
  also depends on the chosen model; the driver cannot add vision to a text-only
  model. See [tool verification](verification/openai-tools.md) for scope and tests.

### Example: Alibaba Cloud Model Studio (Qwen)

Use the `openai-compat` instance above with your Model Studio API key and a
model ID enabled for your account. Set `config.url` to the base URL from
your Model Studio workspace, including `/compatible-mode/v1`:

| Region | Base URL |
|---|---|
| Beijing | `https://<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| Virginia | `https://<workspace-id>.us-east-1.maas.aliyuncs.com/compatible-mode/v1` |
| Singapore | `https://<workspace-id>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| Tokyo | `https://<workspace-id>.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1` |

Replace `<workspace-id>` with your workspace ID. The API key must come from
the same region as the endpoint; a mismatch can return HTTP 401 even when
the key is valid. The older `dashscope.aliyuncs.com` and
`dashscope-intl.aliyuncs.com` addresses still work. Both address formats show
the Qwen mark; the mark identifies the service, not the selected model's
capabilities or account access.

See [Alibaba Cloud's OpenAI-compatible API guide](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)
for current addresses, model availability and region requirements.

### Example: GLM through Z.ai or Zhipu BigModel

Use the `openai-compat` instance above with a general API key from your
chosen service. Set `config.url` to its OpenAI-compatible base URL:

| Service | Base URL |
|---|---|
| Z.ai (international) | `https://api.z.ai/api/paas/v4` |
| Zhipu BigModel (mainland China) | `https://open.bigmodel.cn/api/paas/v4` |

Set `environment.MY_ENDPOINT_KEY` to that service's API key and keep
`config.apiKeyEnv` as `MY_ENDPOINT_KEY`. Set `config.model` to an exact model
ID available to your account, such as `glm-5.3`. The driver appends
`/chat/completions` to the base URL and attempts `/models` discovery; a
manually configured model stays selectable if discovery is unavailable.

Both services document this general API setup and their current model IDs
in their OpenAI compatibility guides. See the [Z.ai guide](https://docs.z.ai/guides/develop/openai/python)
and the [Zhipu BigModel guide](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction).

## Notes

- `config.json` is written with mode 0600; values in `environment` are stored
  as plaintext in that file. Prefer keys scoped to the one engine.
- A typo'd `driver` or invalid `config` never breaks the app: the instance
  shows as unavailable with the reason, and the rest of the fleet loads.
