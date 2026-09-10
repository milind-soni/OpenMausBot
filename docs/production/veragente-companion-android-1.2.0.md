# VerAgente Companion — Android 1.2.0 production record

Date: 2026-09-10 UTC
Target: `srv-silvestre` (`100.91.245.113`, Tailnet)
Compatibility source: official tag `android-v1.2.0`, commit `d70a2f5024c2ee965ebff8c4d3abf9976794fff3`

## Deployed topology

- Existing white-label harness remains `veragente-omb-1`; its image, environment, data bind and public route were not changed.
- `veragente-companion-1` runs the unmodified `companion/` tree from the official Android 1.2.0 tag under `node:24-bookworm`.
- Companion shares the harness network namespace, so its upstream remains `127.0.0.1:8799` without exposing the harness.
- Device port is published only on the existing Tailnet address: `100.91.245.113:8810`.
- Control is bound only on host loopback: `127.0.0.1:8811`. A supervised loopback relay maps it to the sidecar's loopback control socket in the shared namespace.
- Device registry persists at `/opt/data/veragente/companion-state` (mode 0700).
- Compose supervision uses `restart: unless-stopped`.

No network, firewall, Traefik, DNS, Hermes, Tailscale, branding, or public-web-route configuration was changed.

## Verification evidence

- Isolated red-capable trial used alternate ports 18810/18811 against the real harness namespace; Companion health and control both returned HTTP 200 and isolated state was mode 0700.
- Official tag Companion suite under Node 24: 13 files, 223 tests passed.
- Production listeners: `100.91.245.113:8810`; `127.0.0.1:8811`; no Tailnet listener on 8811.
- Remote Tailnet probe: Companion health HTTP 200; remote 8811 connection refused.
- Native invitation was generated through loopback control without logging its code or URL. Its scheme/host, 52-byte token, address and endpoint shape passed the Android 1.2.0 `PairingInvite.parse` contract.
- A temporary device credential was redeemed through the real Companion. `GET /api/bots` returned two bots and identified `Hermes Pessoal` and `Gerente Infra`; the validator device was then revoked. Message history was not claimed because the correct thread IDs were not safely derivable from that response.
- Companion restart followed by health and control state checks passed.
- No ADB device was attached: physical Android E2E is `NOT_PROVEN`.

## Rollback

Pre-change material is in `/opt/data/veragente/backups/companion-20260910T225720Z` (compose file and redacted-at-rest Docker inspect capture; permissions are host controlled).

Run on `srv-silvestre`:

```sh
cd /opt/data/veragente
sudo docker compose down
sudo cp /opt/data/veragente/backups/companion-20260910T225720Z/docker-compose.yml ./docker-compose.yml
sudo docker compose up -d
sudo docker compose ps
```

The rollback removes the auxiliary Companion/relay definitions and returns the harness to the exact pre-change Compose definition. Persistent companion state and source are deliberately left in place for forensic recovery; they can be removed separately only after rollback acceptance.

## Gates

- Official Android 1.2.0 compatibility: PASS
- Isolated red-capable rehearsal: PASS
- Production supervision and persistence: PASS
- 8810 restricted to existing Tailnet address: PASS
- 8811 loopback-only: PASS
- Harness/API sharing: PASS
- Native invite parse structure: PASS
- Bots API and named Hermes profiles: PASS
- History via Companion API: NOT_PROVEN
- Physical Android E2E: NOT_PROVEN
- White-label web preservation: PASS (deployment did not modify its image, data, route or branding)
