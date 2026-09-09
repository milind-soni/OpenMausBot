# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Email **soni.mil2001@gmail.com** with
the details (or use GitHub's private vulnerability reporting on this repo if enabled). You'll get a
response as soon as possible, normally within a few days.

## Scope notes for researchers

- The harness server binds **127.0.0.1 only**. Packaged builds allow anonymous loopback reads, but
  public mutations require either the desktop's private per-launch capability or a paired session;
  built-in agent integrations use narrower per-turn capabilities. Anything that makes it reachable
  from off-machine without a paired session, lets one bot reuse another turn's capability, or lets
  a local *unprivileged other user* drive it is a vulnerability.
- API keys live in `~/.openmausbot/config.json` and are write-only through the API (`configured`
  booleans out, never values). Any path that echoes a stored secret back — API response, SSE event,
  log line, argv visible in `ps` — is a vulnerability.
- Agents run real CLIs (`claude`, `codex`) with the user's own privileges, and the permission broker
  is the consent layer for risky actions. Bypasses of the broker (approving without a user decision,
  spoofing the broker socket) are vulnerabilities unless that bot is explicitly set to **Full
  access**. Full access is a standing user decision to approve provider permission requests; it must
  never answer questions or silently broaden product-level confirmations such as credentials,
  routines, skills, or peer communication.
- Spawning must never route user-influenced strings through a shell. Report any `shell: true` /
  `cmd.exe` string-building you find.
