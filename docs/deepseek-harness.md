# DeepSeek Harness

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is an
optional OpenMausBot engine. OpenMausBot talks to the DSH Host API rather than
using DSH as a model-only endpoint, so DSH continues to own its agent loop,
session context, tools, reasoning stream, approvals, questions, steering, and
cancellation.

DSH is currently a developer preview and its protocol can change. When an
upgrade breaks the integration, update both projects before weakening either
side's validation.

## Choose a connection mode

Open **App Settings -> Engines -> DeepSeek Harness**. Both modes accept an
absolute `http://` or `https://` origin. Include a non-default port when needed,
but do not include a path, query string, fragment, or embedded credentials.

### Direct

Direct mode calls the DSH `/api` Host API. It is the simplest option when
OpenMausBot and DSH run on the same machine:

```text
http://127.0.0.1:3080
```

It also supports a routable private-network origin, including a Tailscale
HTTPS origin with an explicit port:

```text
https://dsh-host.example.ts.net:10443
```

No SSH tunnel or port forward is required when the OpenMausBot host can already
reach that origin. The raw DSH Host API does not use paired-device
authentication, however. Treat every non-loopback Direct origin as a trusted
service boundary: restrict it with the private network's ACLs and do not expose
it to an untrusted LAN or the public internet.

Enter the origin, optionally enter an exact DSH agent preset id, then select
**Save settings**. OpenMausBot probes both the Host API and the live model
catalog before marking the engine available.

### Paired

Paired mode uses the device gate from
[`@linxin666/dsh-remote-web-ui`](https://github.com/zhu1090093659/dsh-web-ui).
It is appropriate for a DSH origin exposed through Tailscale Serve or another
private HTTPS route:

1. Install or update the remote web UI plugin on the DSH host.
2. Generate a new device-pairing link in DSH.
3. Paste the complete one-time link into OpenMausBot and select **Pair device**.
4. Confirm that the engine reports **Paired device connected**.

The pairing link determines the saved origin. OpenMausBot sends its one-time
token to that origin's pairing endpoint, stores only the returned device
cookie, and clears the link input. The cookie is write-only: it stays in the
owner-local OpenMausBot configuration and is attached only to HTTP and
WebSocket requests for the configured origin. It is never returned to the
renderer, included in a URL, or copied into events, snapshots, and error text.

Revoking a device in DSH invalidates the saved cookie. An active turn then
fails closed when its authenticated streams are lost: OpenMausBot attempts a
cancel, terminates the local turn, and settles unanswered cards as unavailable.
Paste a fresh DSH pairing link to pair again. A failed or expired link does not
replace the previously saved connection.

## Paired plugin capability

Chat, existing DSH models, and paired sessions use the normal `/remote/api`
channel. Adding models from OpenMausBot additionally requires a plugin build
that exposes the narrow `paired-model-catalog` capability. The capability was
introduced in [dsh-web-ui PR #1016](https://github.com/zhu1090093659/dsh-web-ui/pull/1016).
If the endpoint is absent, OpenMausBot leaves chat available and explains that
only model management needs a plugin update.

Current `dsh-web-ui` `dev` builds include the inherited-catalog correction
confirmed in [issue #1029](https://github.com/zhu1090093659/dsh-web-ui/issues/1029):
installed entries stay inherited through `modelOverrides`, while adding an
unknown custom model materializes every live entry and removes the now-stale
overrides atomically. Update the plugin if its paired catalog predates that
resolved issue; older builds can expose the endpoint from #1016 without these
preservation semantics.

## Models and OpenRouter

The model picker reads DSH's live `llm.models` catalog. It does not keep a
hard-coded list of official models. Every valid provider group DSH reports is
shown, including DeepSeek groups and OpenRouter or other pi-ai providers that
the user has already configured in DSH. One provider failing does not hide the
other successful groups.

To add a model from OpenMausBot, open **Model catalog** in the engine card:

1. Choose an active, existing DSH pi-ai provider such as `openrouter`.
2. Select **Discover**, filter the returned candidates, or enter an exact
   custom model id.
3. Optionally set its display name, context window, maximum output, and
   supported reasoning efforts.
4. Select **Save model**. OpenMausBot refreshes the live DSH catalog only after
   DSH accepts the update.

OpenMausBot never creates a provider route and never reads or edits its API
key. Discovery uses the credential reference already owned by DSH. A model
update is limited to the chosen provider's pi-ai model configuration, preserves
existing entries and fields, and uses DSH's settings revision to reject a
concurrent edit. When Direct mode adopts an unknown model from an inherited
catalog, it first materializes the current ids so the existing choices are not
discarded.

If a bot's selected DSH model disappears after a catalog refresh, the next turn
is refused before dispatch. OpenMausBot also verifies that DSH acknowledged the
exact provider, model, and effort before sending the prompt, so DSH cannot
silently move the turn to a fallback model.

## Reasoning effort and model metadata

Reasoning effort belongs to the exact selected model, not the whole DSH
engine. OpenMausBot shows only the levels advertised for that model:

- DSH `off` is displayed as **None**;
- `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` map directly;
- **Default** omits an explicit effort and lets DSH use the model's default.

Changing to a model that does not support the saved effort clears it to
Default. The server applies the same check to saved bot edits and turn
dispatch, so an unsupported value cannot bypass the UI.

The optional context-window value is returned with the live picker metadata.
The optional maximum-output value is saved as DSH provider metadata; it is not
an OpenMausBot per-turn token limit. Usage appears only when DSH reports bounded
input and output token counts. OpenMausBot does not invent a cost estimate.

## Sessions, presets, and persona

Each OpenMausBot task, including each bot's participation in a room, owns its
own DSH session cursor. That cursor is persisted privately and resumed across
OpenMausBot restarts. Mid-turn messages use DSH steering, and **Stop** maps to
DSH session cancellation.

The optional **Agent preset** field is an exact DSH preset id. It is supplied
when OpenMausBot creates a new DSH session, and that preset determines the DSH
tools, skills, and native prompt assembly. Changing the setting does not
rewrite an already persisted DSH session; start a new OpenMausBot task when a
different preset must apply.

DSH does not expose a separate per-session system-prompt field in this flow.
OpenMausBot therefore prepends a delimited bot-persona block to the first
accepted prompt only. Later turns rely on DSH's persisted session context.

OpenMausBot passes its bot workspace path as `cwd` when it creates or resumes a
session. When DSH runs on another host, the same absolute path must exist there
and refer to the intended workspace. A same-host deployment avoids that path
mapping issue. DSH tools execute where DSH runs.

## Failure recovery and current limits

- Both DSH event streams must be healthy. A brief reconnect is tolerated; a
  sustained loss terminates the active turn, attempts cancellation, and closes
  pending approval or question cards without claiming the action ran.
- A revoked paired device needs a fresh pairing link. Provider reloads and
  connection changes close sockets and settle pending requests before the new
  instance is used.
- A catalog with no usable model makes the provider unavailable. A vanished
  selected model never falls back to another model.
- Model adoption is limited to an existing, active pi-ai provider. Provider
  creation, credential editing, and general DSH settings editing stay in DSH.
- DSH bots keep the tools and skills supplied by their DSH agent preset.
  OpenMausBot-owned computer, Composio, phone, and bot-delegation integrations
  are not mounted into this driver, and image prompts are not currently
  advertised.
- OpenMausBot normalizes streamed text, reasoning, tool activity, approvals,
  and questions, but it does not expose raw DSH envelopes to the app.
