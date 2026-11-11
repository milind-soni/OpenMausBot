# What the app sends on its own

OpenMausBot does not reach the network in the background unless you turn that on. Your engines, your connected apps
and the people you chat with are still reached when you use them; this page is about the requests nobody asked for.

| What | Where it goes | Turn it on with |
|---|---|---|
| Desktop app update check, 15 seconds after launch and then hourly | GitHub releases | `OMB_AUTO_UPDATE=1` |
| Coding engine updates, 2 minutes after start and then daily | npm registry, GitHub, Google | `OMB_ENGINE_UPDATES=1` |
| Model list refresh, at start and then hourly | `raw.githubusercontent.com` | `OMB_MODEL_MANIFEST_FETCH=1` |
| The managed connected-apps service on the desktop: registration, check-in, tool calls, app events | OpenMausBot's Composio service | `OMB_COMPOSIO_BROKER=on` |

Each is an environment variable of the desktop app or the server. Without them:

- **Updates** are found only with **Check for updates**, and an engine is updated by installing it again.
- **The model list** is the copy that ships with the app.
- **Connected apps** need your own Composio key; see [`composio.md`](composio.md).
- **The account service** is asked nothing at launch until you sign in for the phone app or Cloud.
- **The sidebar** shows the first letter of an app instead of loading its icon from Google.
- **Spawned tools** are asked to stay quiet too: Claude Code runs with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
  unless you set it yourself, and the computer-use driver with telemetry and its update check off.

Usage analytics have their own switch; see [`analytics.md`](analytics.md).
