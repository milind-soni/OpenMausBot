# OpenCode

OpenCode is an optional OpenMausBot engine. OpenMausBot runs the maintained
OpenCode CLI through its ACP stdio interface, so sessions, streaming, coding
tools, permission requests, MCP integrations, resume, and cancellation use the
same runtime as the other ACP engines.

## Setup

1. Install the official CLI using the
   [OpenCode installation guide](https://opencode.ai/docs/).
2. Connect the providers you want in the OpenCode app, run
   `opencode auth login`, or save the provider's key in OpenMausBot under
   Settings → API keys → **Keys for other OpenCode providers**. On an OMB
   Cloud, which has no terminal, save the key there.
3. Restart OpenMausBot. It reuses OpenCode's existing connections and model
   configuration automatically.

For OpenRouter, Fireworks AI, DeepSeek, Cline or your own provider, see
[Other model providers](../apps/docs/content/docs/providers/model-providers.mdx).

OpenCode includes anonymous free models. A Zen, Go, OpenRouter, or other
provider connection expands the catalog according to the installed CLI. An
OpenCode API key can optionally be stored under Settings → API keys. It is
write-only and injected as `OPENCODE_API_KEY` only into the OpenCode child
process; it is not sent to the renderer, logs, analytics, snapshots, error
messages, or command arguments.

Keys for OpenCode's other providers go under **Keys for other OpenCode
providers** in the same place, each under the environment name OpenCode reads
it from: `VENICE_API_KEY` for Venice, `GROQ_API_KEY` for Groq, and so on. This
works on the desktop and on My Cloud, where there is no terminal to export
them in. Each key is write-only (Settings shows its name, never the key), is
kept in the server's own config, and is passed only to the OpenCode process;
saving one reloads the engines, so OpenCode lists that provider's models
straight away. On a Cloud, a hosted team or an organization's desktop,
OpenCode still never reads provider keys from the server's own environment;
the keys saved here are the exception. Names OpenMausBot keeps for itself
(`OPENCODE_*`, `OMB_*`, and the keys it saves for other engines, such as
`XAI_API_KEY`) are refused, and up to 20 keys can be saved.

OpenMausBot does not copy or rewrite `auth.json`. The OpenCode CLI remains the
owner of provider authentication, and the same Zen or Go connection used by
the OpenCode desktop/TUI is used by OpenMausBot.

## Models

The model picker runs `opencode models --verbose` against the configured binary
and preserves every exact `provider/model` ID returned by the CLI. This can
include Zen (`opencode/*`), Go (`opencode-go/*`), third-party providers, custom
configuration, and local endpoints. If discovery temporarily fails, the last
successful catalog is used, followed by a small anonymous-model fallback.

Before every prompt, ACP receives `session/set_config_option` with
`configId: "model"` and the exact selected provider-qualified model ID.

## Testing

Normal unit and ACP protocol tests do not require a subscription. Live tests
must be explicitly enabled and must never print credentials or upload native
protocol logs from a credentialed run.
