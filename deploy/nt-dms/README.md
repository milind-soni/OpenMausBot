# anant on NT DMS

Operations scripts for the AnAnt server at `https://anant.nttan.com`, a Docker
Compose deployment with the bots' sandbox (`compose.yaml:compose.box.yaml`) on
a shared Ubuntu 24.04 host whose own Caddy terminates TLS and proxies to
`127.0.0.1:8090`.

| File | Installed as | What it does |
|---|---|---|
| `anant-update` | `/usr/local/sbin/anant-update` | Builds a commit of `main` into `/opt/openmausbot/releases/<commit>`, backs up, switches, verifies, rolls back on failure |
| `anant-backup` | `/usr/local/sbin/anant-backup` | Uploads the core data (databases, settings, engine sign-ins, paired devices) to the R2 bucket `anant-backup` |
| `anant-backup.cron` | `/etc/cron.d/anant-backup` | Runs the backup at 03:00 Asia/Bangkok |
| `r2-backup.env.example` | `/etc/mausbot/r2-backup.env` (root, `600`) | rclone settings; the key is an R2 token scoped to `anant-backup` |

## Update

Push to `main`, then on the server:

```sh
sudo anant-update             # newest main
sudo anant-update <commit>    # a specific commit
sudo anant-update --rollback  # the release that ran before
sudo anant-update --status
```

A switch counts as done when the server is healthy, `anant.nttan.com` reports
the version in that commit's `package.json`, and the sandbox self-check has no
failures beyond the warn-only ones. Three releases and their images are kept.

## Backup

Each night writes `anant-core-<day mod 3>.tgz`, so the bucket always holds the
three most recent nights. The archive leaves out bot task workspaces, chat
attachments, the bots' browser profiles, downloads and caches. It holds engine
sign-ins and device sessions, so the bucket must stay private.

To restore, stop the project, download an archive and unpack it over the
`openmausbot_data` volume:

```sh
cd /opt/openmausbot/current && sudo docker compose stop
mp=$(sudo docker volume inspect -f '{{.Mountpoint}}' openmausbot_data)
sudo tar -xzpf anant-core-N.tgz -C "$mp"
sudo docker compose start
```

## Installing the scripts

```sh
sudo install -m 755 anant-update anant-backup /usr/local/sbin/
sudo install -m 644 anant-backup.cron /etc/cron.d/anant-backup
```
