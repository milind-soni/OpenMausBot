# Dictation from a browser

Self-hosted workspaces can offer microphone dictation to their authenticated
browser clients through an optional, local transcription worker. Native macOS
dictation keeps its existing recognizer and behavior. Other clients use the
worker only when the operator enables it and the browser supports microphone
capture and MediaRecorder over HTTPS (or localhost).

Press the microphone to record, then press it again to stop and transcribe.
The resulting text is appended to the current draft. Review it and press Send.
Cancel, Escape, changing conversations, or leaving the page discard the capture
or pending transcription. Edits made during recording or transcription are
preserved. Send waits for completion or cancellation. Recording stops just
before the two-minute limit; uploads are limited to 10 MiB.

## Optional local worker

The example worker in `deploy/dictation/` uses faster-whisper on the CPU with
int8 inference. It needs a separate Python environment and enough memory for
the chosen model. It is not installed or started by OpenMausBot. There is no
paid transcription API or additional Node dependency.

Create a virtual environment and install its dependencies:

```sh
python3 -m venv .venv-stt
.venv-stt/bin/python -m pip install -r deploy/dictation/requirements.txt
```

On Windows, use `.venv-stt\Scripts\python.exe` for the Python commands. Download
the model once with the operator's consent; this step needs internet access:

```sh
.venv-stt/bin/python -c 'from faster_whisper import WhisperModel; WhisperModel("small", device="cpu", compute_type="int8", download_root="./dictation-models")'
```

Start the worker with the same model cache. Offline mode is the default:

```sh
OMB_STT_MODEL=small OMB_STT_MODEL_DIR=./dictation-models \
  HF_HUB_OFFLINE=1 .venv-stt/bin/python deploy/dictation/server.py
```

In a separate terminal, configure the workspace server's environment with
`OMB_DICTATION_URL=http://127.0.0.1:8810` and start it normally. Restart the
workspace server after changing that environment variable. Keep the worker
on the same host or inside the same network namespace as the server. Never
publish its port: only the workspace API authenticates clients. For managed
deployments, use a dedicated unprivileged account and process memory/CPU limits.

The worker's environment options are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMB_STT_MODEL` | `small` | Cached model name or a staged local model directory |
| `OMB_STT_MODEL_DIR` | Library default | Model download/cache directory |
| `OMB_STT_OFFLINE` | `1` | Only use staged models; `0` explicitly allows model downloads |
| `OMB_STT_PORT` | `8810` | IPv4 loopback port |
| `OMB_STT_THREADS` | `4` | CPU inference threads |

Unsetting `OMB_DICTATION_URL` and restarting the workspace disables browser
dictation. Stopping the worker also makes it unavailable; clients refresh
availability every 30 seconds without waking a sleeping Cloud.

## Privacy and access

Audio travels from the browser to the authenticated workspace API, then to
the operator-configured IPv4 loopback worker. The API refuses external URLs,
credentials, path overrides and redirects. Clients cannot select a backend
URL or access the worker directly through this API. The endpoints use the
existing session, origin and client-scope gates.

The example worker accepts only its exact `127.0.0.1:PORT` Host header,
refuses Origin and browser-only fetch-metadata headers, and requires an audio
Content-Type before occupying its inference slot. This prevents web pages
from bypassing the workspace API with simple form uploads or DNS rebinding.
Local processes on the server remain within the operator's trust boundary.

The worker decodes at most 120 seconds, runs one inference at a time, and
keeps audio in memory. Neither the API nor the worker saves recordings or
logs transcript contents. Returned text enters the app's normal draft
persistence. Cancelling rejects late results and releases the microphone;
an inference already running may finish before the worker becomes free.

The transcription language follows the UI language. Microphone permission is
granted in the browser on the device where the person is speaking. HTTP on
a remote address cannot provide microphone capture. Browser and OS support
still require testing on the intended client.

See [verification](verification/server-dictation.md) for automated coverage
and the checks that require a physical microphone.
