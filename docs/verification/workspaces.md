# Workspaces screen and the fleet agent

## Sub-features

- A root agent on a Unix socket only the operator's user may open, planning
  and running fleet operations, writing an audit line per action.
- Operator-server routes under `/api/fleet` that forward to the agent, admin
  scope plus the `admin` entitlement, 404 without an agent.
- Settings → Workspaces: list with state and this month's cost, create, users,
  suspend, resume, delete (with keep-data), upgrade all.

## Driving it

```sh
pnpm exec vitest run server/fleet-agent.test.ts server/fleet-cli.test.ts server/fleet.test.ts src/components/WorkspacesSection.test.ts server/request-auth.test.ts
```

The agent test boots the real agent on a temporary socket over a recording
machine with a temporary filesystem root, drives create, list (reading a
workspace's own ledger for the month), users, suspend and delete through the
same client the operator server uses, checks the audit log names every action
and never a key, and checks refusals: bad names, unknown operations, a failed
step reported without the tool's secrets, and a plain message when no agent
exists.

On a real server, after `openmausbot fleet init --domain <domain> --operator
<user>` as root: `systemctl status openmausbot-fleet`, then `ls -l
/run/openmausbot/fleet.sock` must show `root:<user>` and mode 660. Sign in to
the operator workspace and open Settings → Workspaces. Create one, add a
member, suspend and resume it, and confirm `/var/log/openmausbot/fleet.jsonl`
grew a line per action. A workspace other than the operator's must get 502
from `/api/fleet`, because it cannot open the socket.

## Not proven here

The real server steps need root, systemd, nftables and Caddy; the renderer's
forms are proven from fixtures, not driven headlessly.
