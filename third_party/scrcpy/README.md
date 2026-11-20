# scrcpy server provenance

OpenMausBot shows the screen of a USB Android phone with the official scrcpy
server 5.0.1. The server file comes from Genymobile's GitHub release:

<https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1>

| Release asset | SHA-256 |
| --- | --- |
| `scrcpy-server-v5.0.1` | `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536` |

The file is not checked into git and is not part of any package. The server
downloads it on first use from

<https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1>

into `scrcpy/scrcpy-server-v5.0.1` in its data directory (`~/.openmausbot`
unless `OMB_DATA_DIR` says otherwise), and uses it only when its SHA-256
equals the digest above. Every later use verifies the saved file again.

On a server without internet access, download the release asset on another
machine, check its digest, and save it at that path under that name.

OpenMausBot copies the file to the phone with `adb push`, runs it there with
`app_process`, and removes it when the view closes. Nothing is installed on
the phone. The file is used unmodified; OpenMausBot's own client
(`server/phone-screen/`) speaks the protocol of this one release, so a new
scrcpy version needs the client checked against it before the pin moves.

scrcpy is licensed under the Apache License 2.0:
<https://github.com/Genymobile/scrcpy/blob/v5.0.1/LICENSE>.
