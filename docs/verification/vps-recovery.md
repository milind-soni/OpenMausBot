# VPS startup and transport recovery

Run the isolated regression fixtures:

```sh
pnpm exec vitest run server/vps-routing.test.ts server/vps-computer.test.ts server/vps-computer.runner.test.ts server/vps-ssh.test.ts server/vps-container-mcp.test.ts server/mcp-bridge.test.ts server/vps-inventory.test.ts server/kill-tree.test.ts
```

`server/vps-routing.test.ts` launches the real server and a fake engine in a temporary home.
Only Docker/SSH are replaced with fixture executables. It holds a screenshot beyond
the old five-second lock deadline, sends a message in both Cloud and Auto, then
releases the screenshot. Both turns must complete with the correct VPS tools mounted.
The old implementation fails both cases with “the VPS is being prepared.”

The other fixtures cover:

- Concurrent preparation shares one operation; an already-ready computer is checked once.
- Concurrent status polls and previews share inspection, without caching pre-stop state.
- Preview and desktop-readiness waits stay bounded, including process cleanup time.
- Stop/Delete remain serialized, and failed preparation releases the next retry.
- Real disposable processes simulate Docker with a stubborn SSH child. Timeout and
  stdin failure must reap the owned child, leave an unrelated detached process alone,
  and allow the next command to succeed.
- OpenSSH parses paths with spaces and long data directories without contacting a VPS.
- The bot's MCP transport and watchdog use the same SSH settings as the preview.

These fixtures do not prove a customer's network, remote Docker daemon, or actual Cua
desktop is healthy. They require no real VPS, Docker daemon, provider key, or live app data.
The existing [cloud preview fixture](cloud-preview.md) covers renderer error/retry behavior.
