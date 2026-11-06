# VPS install for a white-label reseller

`install.sh` takes a blank Ubuntu 24.04+ or Debian 12+ server to a running reseller
fleet: Node 24, Caddy, OpenMausBot, your default brand and a first workspace.
Read it, run it with `--dry-run` first, then as root:
`sh install.sh --domain example.com --admin you@example.com --reseller-name "Acme Cloud"`.
Options, phases and re-running: [docs/reseller/install-vps.md](../../docs/reseller/install-vps.md).
Offline checks and the disposable-VPS recipe: [docs/verification/white-label-reseller.md](../../docs/verification/white-label-reseller.md#vps-install).
