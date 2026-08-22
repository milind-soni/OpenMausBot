# Dormant Hermes work-queue adapter

OpenMausBot exposes a narrow local submission and status surface for the AOS unattended-work plane. It never executes a card. Hermes remains the sole executor, and the source-owned work plane owns request validation, idempotency, quarantine, leases, dispatch, and publishing gates.

The adapter proxies only these fixed routes to `http://127.0.0.1:8817`:

- `GET /health`
- `POST /v1/work`
- `GET /v1/work/<id>`

The normal OpenMausBot server exposes them locally as `/api/unattended-work/health`, `/api/unattended-work`, and `/api/unattended-work/<id>`. `OMB_UNATTENDED_WORK_ENABLED=1` is required before submit or status calls can leave the OpenMausBot process. Any other value, including `true`, remains disabled.

## Isolated adapter runtime

`scripts/install-unattended-adapter.mjs` accepts one exact committed source SHA. It refuses a dirty or drifted worktree, rebuilds the standalone queue page and self-contained server bundle from that checkout, and packages those runtime artifacts with a `source.tar` archive produced by `git archive` for exact-source audit and reproducibility. The archive is provenance material, not an executable runtime input. The installer also creates a separate data home, assigns ports 8827 and 8828, and renders `com.gus.aos-unattended-openmausbot.plist` with `RunAtLoad=false` and `KeepAlive=false`. It does not bootstrap the LaunchAgent or replace `/Applications/OpenMausBot.app`.

The rendered runtime sets `OMB_UNATTENDED_ADAPTER_ONLY=1`. In this mode OpenMausBot loads zero provider instances, starts no routine scheduler, opens no webhook listener, and returns 404 for every API except application health and unattended-work health, submit, and status.

The receipt deliberately reports `source_ready=true`, `dormant_ready=true`, and `live_accepted=false`. Live activation remains a separate attended gate. It requires explicit surface selection plus fresh lane, credential, lease, provider, private Telegram readback, issue-to-draft-PR, and live-soak evidence. The adapter never gains merge, deployment, release, upload, provider-change, credential-value, external-send, force-push, destructive-cleanup, protected-branch, or out-of-worktree authority.
