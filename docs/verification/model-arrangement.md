# Agents and model connections

Settings places agent apps and direct model connections in separate sections. An
agent app runs the conversation and uses a model; a direct API or endpoint supplies
a model while OpenMausBot runs the conversation. The bot settings summary says
which agent runs the bot, which model is selected when known, and where inference
runs when evidenced. The picker groups its choices the same way. A bot keeps its
existing `instanceId` and model ID; the description is derived from those values
and does not migrate selections.

## Responsibility map

| Connection | Agent loop and tools | Model and route | History and compaction | Permissions |
| --- | --- | --- | --- | --- |
| Direct hosted APIs (`openai-compat`, Grok API, MiniMax API, Mistral, Cerebras, Groq, Meta) | OpenMausBot's chat runtime mounts its enabled tools and MCP connections. | The picker selects the model. Settings → API keys stores the key and, for compatible APIs, the endpoint. | OpenMausBot retains the transcript and wire history. The harness can checkpoint supported long conversations. | OpenMausBot's tool gate and approval settings. |
| Direct compatible endpoint on loopback | The same OpenMausBot loop; a local endpoint changes inference location, not the agent. | The picker selects the model; Settings → API keys supplies the URL. | Same as other direct calls. | Same as other direct calls. |
| Connected runtimes (Claude Code, Codex, OpenCode, pi, and the other registered agent drivers) | The runtime has its own loop and tools. OpenMausBot supplies only supported, enabled integrations; the runtime may have its own MCP settings. | The picker can send a reported model selection. A runtime may choose its own provider or endpoint; that location is not generally reported to OpenMausBot. | OpenMausBot retains the app transcript. The runtime may keep a native session and compact it. Harness checkpoints depend on the selected driver and helper capability; they are not universal. | Native runtime modes and OpenMausBot's gates both matter. Available modes differ by driver. |
| Custom agent command (`customAcp`) | The configured agent command owns its loop; OpenMausBot offers supported integrations. | The placeholder `agent-default` supplies no model identity. Model choice belongs to the agent configuration. | Native behavior is unknown. OpenMausBot retains the app transcript. | Residual requests use OpenMausBot's gate; native behavior is specific to the command. |

`access` groups account, key, and custom setup paths; it does not identify the
agent. In particular, the Claude API key entry still runs Claude Code. A
reported `loaded` model indicates a local model, while a compatible endpoint
on loopback proves a local route. An effective URL at one of the registered
official API hosts identifies a hosted API route. A `custom` catalog entry alone proves neither;
a non-loopback URL can still point to a local network server. The picker reports
location as unknown in those cases. Added compatible endpoints provide a
sanitized URL in `/api/instances`; configured direct API URLs are sanitized by
the instance description, and the built-in compatible endpoint also has its
URL in configuration status. Other runtimes generally do not expose their
effective provider URL.

Switching the selected instance can change tools, approval modes, and native
session continuity even when the model name stays the same. The picker shows
this consequence while browsing another instance. It retains the existing
Ask-permission confirmation only when the target driver cannot honor the
current permission mode.

## Verification

Run the focused behavior and UI tests:

```sh
node_modules/.bin/vitest run src/lib/model-arrangement.test.ts src/components/ModelPicker.test.ts src/components/ModelPicker.simple.test.ts src/components/ModelPicker.interaction.test.ts
```

For real renderer verification, use the isolated `control-omb ui launch`
fixture described in [bot-continuity.md](bot-continuity.md). It exercises
selection and persistence against a fake provider without accessing the user's
app or bots. This does not establish what an external runtime's unreported
model or endpoint actually is.
