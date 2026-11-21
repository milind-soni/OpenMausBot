# Data: where Edu Bot keeps its files

Edu Bot has its own identity on the computer, separate from the upstream OpenMausBot app. Both can be installed on
the same machine without sharing data, settings or links.

| What | Where |
| --- | --- |
| Workspace data (bots, chats, settings, `config.json`) | `~/.edubot`, or the folder `OMB_DATA_DIR` names |
| Phone and device pairing state | `~/.edubot-companion` (`OMB_COMPANION_DIR` overrides it) |
| Another local workspace you add | `~/.edubot-<name>` |
| A bot's short-lived private secrets | `.edubot-secrets` inside that bot's workspace |
| Desktop window state and encrypted credentials | Electron's user-data folder: `~/.config/Edu Bot` on Linux, `~/Library/Application Support/Edu Bot` on macOS, `%APPDATA%\Edu Bot` on Windows |
| Saved servers for the `edubot` command | `~/.config/edubot` (`$XDG_CONFIG_HOME/edubot`, `%APPDATA%\edubot`) |
| Sentinel health scans | `~/.local/state/edubot-sentinel` (macOS: `~/Library/Application Support/edubot-sentinel`) |

The names come from one module, `electron/app-identity.mjs`, which the desktop app, the server and the interface all
import.

## An existing OpenMausBot folder is never read or moved

If `~/.edubot` does not exist, Edu Bot creates a new, empty one. It does not look inside `~/.openmausbot` (or the
older `~/.opengrokbot`), does not copy or rename it, and does not delete it. The old folder stays exactly as it was,
so the OpenMausBot app keeps working with it.

Edu Bot also never uploads `~/.openmausbot` when it syncs files to a Cloud: it is on the same private list as
`~/.edubot`, `~/.ssh` and other app folders.

There is no supported import from OpenMausBot yet. Copying the folder by hand is untested: paths saved inside it
(in bots' notes and chats, for example) may still point at `~/.openmausbot`, and credentials the OpenMausBot desktop app encrypted stay with that app.

## Other identifiers

| Identifier | Value |
| --- | --- |
| Application id (Linux desktop entry, macOS bundle, Windows AppUserModelId) | `io.github.eduardomoraga.edubot` |
| Links the desktop app opens | `edubot://` (`thread`, `bot`, `cloud`, `organization`, `install`, `team`, `use-my-computer`) |
| Command line | `edubot` (`pnpm omb` in a checkout) |
| Linux install folder and command | `/opt/edu-bot/edu-bot` |
| Linux browser sandbox policy | AppArmor profile `edubot-browser` |

Two identifiers keep their OpenMausBot values on purpose, because the only phone apps that exist are the published
MausBot apps for iOS and Android, and Edu Bot does not control them:

- **Phone pairing links** stay `openmausbot://pair?…`. That is the only link scheme the phone apps register, so a QR
  code with any other scheme would not open them.
- **Nearby discovery** stays the Bonjour service type `_openmausbot._tcp`. That is the type the phone apps browse
  for. The computer's mDNS host name is Edu Bot's own (`edubot-<hash>.local`).

Environment variables keep their `OMB_` prefix.
