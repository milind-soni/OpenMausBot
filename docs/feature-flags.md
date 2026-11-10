# Feature switches

The server stores these options under `features` in its `config.json`. Some have
Settings controls; others currently need a file edit. They apply to the server
you are connected to, so changing a desktop client's file does not configure a
remote server.

The defaults and accepted keys below describe this source revision. Older
packaged releases may differ, including which controls Settings shows.

## Change a switch

The default file is `~/.openmausbot/config.json` on the machine running the server.
If the server uses `OMB_DATA_DIR`, edit `config.json` in that directory instead.
Stop that server (or quit the app if it runs the server), back up the file, merge
only the keys you want into its existing `features` object, then start it again.
Keep the other configuration, including engine instances and credentials.

For example, this enables the shared skills library while leaving automatic
skill review off:

```json
{
  "features": {
    "skillsLibrary": true,
    "skillReview": false,
    "shareLearnedSkills": "ask"
  }
}
```

This is a fragment to merge, not a replacement for an existing configuration.
These switches do not bypass permissions, engine capabilities or per-bot
settings. In particular, enabling the browser still requires an available
browser engine and a bot allowed to use it.

## Boolean switches

Defaults below mean the key is omitted. A switch being on does not promise a
fixed price: model calls use the configured engine, and tool results, recalled
text and extra work can increase its token usage.

| Key under `features` | Default | Effect | Work or cost to consider |
| --- | --- | --- | --- |
| `skillAuthoring` | On | Lets bots draft skills for review. | Drafting uses the bot's engine; this is separate from automatic skill review. |
| `skillReview` | Off | Reviews long conversations and updates learned skills; also requires `skillAuthoring`. | Background model calls. `skillReviewSteps` controls the interval. |
| `showToolCalls` | Off | Shows individual tool runs in the transcript. | Display option; it does not start tool runs. |
| `browser` | On | Makes the built-in browser available, subject to engine and bot settings. | Browser work and the model turns using it still have their usual costs. |
| `sharedComputers` | Owner lending only | Controls which paired sessions may lend a computer; see the three states below. | Computer use still needs consent and remains subject to access controls. |
| `claudeUserMcp` | Off | Claude bots also load this machine's personal Claude Code MCP servers. | Adds tools and may start those servers; their tools can consume tokens or contact services. |
| `claudeUserSkills` | Off | Claude bots also load the personal skills in `~/.claude/skills`. | Adds skill instructions/files to the engine's available context; does not control Codex native skills. |
| `llmThreadTitles` | Off | Generates new conversation titles with the engine. | Additional one-shot model calls. |
| `smartSetupChoices` | On | Offers engine-written setup choices for a new bot when enough information is available. | Background model calls, subject to the engine's capabilities and the budget. |
| `autoRecall` | On | Recalls matching memory passages into turns. | Recalled text uses context. Disabling this does not disable memory storage or upkeep; see [Memory](memory.md). |
| `skillsLibrary` | Off | Enables the shared skills store and its Skills settings. | Enables the library, not automatic conversation review. Skill use follows assignments and permissions. |
| `roomMemoryCapture` | Off | Lets memory upkeep also read a member bot's room turns. | Extends the material processed by memory upkeep. |
| `parallelRoomJobs` | Off | Runs jobs assigned to several room members side by side, each in its own thread. | Allows concurrent engine work rather than sequential jobs. |
| `acpPlanLines` | Off | Shows an ACP agent's plan as activity lines. | Each emitted line counts as a tool call wherever tool calls are counted; environment override below. |
| `agentsToolBridge` | Off, except eligible local-model turns | Lists a smaller tool catalog with `find_tool` and `use_tool`. | Tool lookup can add model calls; smaller initial context is not a guaranteed saving. See [Agents tool bridge](agents-tool-bridge.md) for eligibility and measurements. |
| `savedSteps` | On | Allows saving and repeating computer tasks from their steps on a supported host. | Currently requires a Mac server. Enabling it does not add host support. |

### Computer lending has three states

For `sharedComputers`, omission is different from `false`:

- **Omitted:** a self-hosted server's own admin pairings may lend their computer.
- **`false`:** disables that owner lending as well.
- **`true`:** also allows other paired sessions to lend their computer.

The desktop still asks its person first. This setting is not permission to use
someone else's computer without their approval. See [Self-hosting](self-hosting.md)
for pairing and trust boundaries.

## Other values under `features`

| Key | Default | Accepted values and effect |
| --- | --- | --- |
| `skillReviewSteps` | `10` | Integer from `3` to `100`: tool steps in a conversation between automatic reviews. Does not turn review on by itself. |
| `shareLearnedSkills` | `"ask"` when the library is enabled; otherwise effectively `"off"` | `"off"`, `"ask"`, or `"auto"`: whether to share a learned skill through the library. Requires `skillsLibrary`; setting `"auto"` changes the sharing decision, not the skill-review switch. |

## Environment overrides

These variables belong to the **server process**, not the browser or a bot's
shell. For these two switches, exactly `1` or `0` overrides the saved value:

| Variable | Overrides |
| --- | --- |
| `OMB_AGENTS_TOOL_BRIDGE` | `features.agentsToolBridge`. `0` also disables the automatic local-model opt-in. Eligibility and tool-selection safeguards still apply when it is `1`. |
| `OMB_ACP_PLAN_LINES` | `features.acpPlanLines`. |

Other strings do not act as these overrides. Restart the server after changing
its launch environment.

## Fields that are not stored switches

`features.savedStepsHere` in a server response reports whether that host can run
saved steps. It is a capability result, not a supported `config.json` switch.
`loopGuard` is a separate top-level configuration object, not `features.loopGuard`.

Old `features.chiefEscalations`, `features.computerClaimIdleRelease` and
`features.cloudOverflow` values are discarded when configuration is parsed;
adding them back does not restore those features. Unknown feature keys are
also dropped, so check spelling rather than relying on an unrecognized key.

The accepted fields are defined in [the server configuration schema](../server/config.ts).
The effective defaults also account for the individual feature's dependencies
and, where listed above, environment overrides.
