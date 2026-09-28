# Jack Control Plane Jev team routing

OpenMausBot remains the team UI and executor. When configured, the top-level
human-facing Chief of Staff turn can ask Jack Control Plane for a bounded Jev
recommendation. The tool is not mounted for ordinary teammates, child turns,
rooms, or unattended runs.

## Configuration

Configure these values in the OpenMausBot server process environment; never put
the token in an agent profile, prompt, shared MCP config, or repository file:

```text
JACK_CONTROL_PLANE_TEAM_ROUTE_ENABLED=1
JACK_CONTROL_PLANE_TEAM_ROUTE_ENDPOINT=https://<private-control-plane-host>/v1/team-route/suggest
JACK_CONTROL_PLANE_MAUSBOT_TOKEN=<dedicated-scoped-token>
```

The endpoint must be HTTPS with the exact `/v1/team-route/suggest` path. On Jack
Control Plane, configure its separate `CONTROL_PLANE_MAUSBOT_TOKEN` identity
with only `decisions:team-route`, and keep `MAUSBOT_TEAM_ROUTE=1` plus
`OPS_DECISION_ADAPTER=1` disabled until the owner authorizes activation.

When enabled, OpenMausBot passes the token only to the MCP child for the
top-level direct turn of a Chief of Staff. The app's roster endpoint validates
that every candidate id is currently reachable before the CP request is sent.
Only a fixed category and `{id, role}` pairs are sent; task text, transcript,
customer data, and secrets are excluded.

## Behavior and limits

Jev returns an advisory suggestion. It does not assign work. The Chief shows
the suggestion and confidence to Jack, then waits for explicit confirmation.
After confirmation, the Chief uses OpenMausBot's existing team assignment tool
and normal approval flow. If Jack confirms a different person or request is
ambiguous, the Chief asks a short clarification.

HTTP 429 is surfaced with the upstream `Retry-After`, when present. OpenMausBot
does not retry automatically. If the header is absent, it reports that fact and
does not assign anyone; Control Plane blocks further Jev calls for that
endpoint/credential until an operator restarts that process.

The integration is inactive when the feature flag, HTTPS endpoint, scoped
token, or Chief-turn gate is missing. No deploy, service restart, or production
configuration change is performed by this code change.
