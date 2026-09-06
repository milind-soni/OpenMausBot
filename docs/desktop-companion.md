# Desktop-to-desktop companion mode

Every OpenMausBot desktop build can play either role:

- **Host mode** is the normal app. It owns the agents, conversations, credentials, routines, and computers.
- **Client mode** controls a paired host through the same authenticated, default-deny companion API used by the phone app.

The roles are platform-independent. A Windows, macOS, or Ubuntu build can host, and any other desktop build can be its client. One app installation uses one role at a time; disconnecting a client returns that installation to host mode without deleting its local host data.

This mode is separate from the desktop app's **Server** menu. The Server menu
loads a remote server's web UI directly using that server's browser session.
Desktop companion mode instead keeps the bundled UI and native integrations on
the client, sends API traffic through the default-deny companion boundary, and
provides the per-device VPS viewer and client-local Mac voice behavior described
below. The two connection types intentionally do not share credentials.

## Pair over secure HTTPS

1. On the host, open **Settings → Remote access** and finish **Secure HTTPS pairing**.
2. Open a pairing window so the host displays a six-digit code.
3. On the client, open **Settings → Remote access**.
4. Enter the host's managed `https://…openmausbot.com` companion address and the six-digit code.
5. Choose **Pair and switch to client mode**. The client restarts and opens the host's bot UI.

The HTTPS address uses the host's managed outbound tunnel. TLS is verified by the operating system, and the client does not need Tailscale. HTTPS is intentionally restricted to OpenMausBot-managed companion names so a typo cannot redirect a paired-device token to an unrelated site.

## Pair over Tailscale

1. Install Tailscale on both computers, sign into the same tailnet, and leave MagicDNS enabled.
2. On the host, open **Settings → Remote access**, turn on Remote access, and open **Pair over Tailscale** to display a six-digit code.
3. On the client, open **Settings → Remote access**.
4. Enter the host's full `.ts.net` MagicDNS name and the six-digit code.
5. Choose **Pair and switch to client mode**. The client restarts and opens the host's bot UI.

To switch that installation back, open **Settings → Remote access** and choose **Disconnect and use this computer**.

## Control a VPS desktop remotely

A desktop client can open an agent's self-hosted VPS display through either paired transport. On the host, enable **Cloud desktop access** for that paired desktop in **Settings → Remote access**. On the client, open the bot's **Computer** panel and choose **Take control**.

The Computer panel also shows a periodically refreshed VPS screenshot. Preview and live control share the same per-device permission, which defaults off. The VPS still publishes no VNC port. The host opens its existing loopback-only SSH tunnel, the companion creates a random device-scoped viewer path, and the client relays noVNC HTTP and WebSocket traffic through its loopback Electron service. Closing the viewer removes the companion session, closes the SSH tunnel, and hands control back to the agent.

Remote clients can preview, open, and close the viewer only. VPS provisioning, replacement, sleep, removal, SSH aliases, Local VM controls, and host browser surfaces remain available only on the host.

The client Calendar supports scheduled routines end to end: create, edit, move, resize, pause, delete, run now, cancel an active run, and acknowledge failures. Scheduled calls and webhooks remain host-only and are omitted from client mode.

The remote Computer panel includes the host panel's per-agent **Scheduled tasks** card. It lists that agent's next routines and active run, opens the full schedule view, and creates a new schedule already assigned to the agent.

A Mac remote client supports dictation and live calls against any host: Apple Speech runs locally on the Mac, and only the transcript crosses the paired connection. When a Mac client selects a built-in system voice, reply speech is synthesized and played locally on that Mac; ElevenLabs reply audio is synthesized by the host and relayed byte for byte. A Windows remote client still needs a future Windows speech-to-text implementation for microphone input.

The host must be running and awake. Cleartext HTTP is accepted only for a `.ts.net` MagicDNS hostname because that connection is encrypted inside Tailscale's WireGuard tunnel. Raw IP addresses, LAN hostnames, URL credentials, paths, queries, and fragments are rejected.

## Security model

Pairing creates an independent device identity on the host. The resulting bearer token is:

- stored only in Electron's OS-encrypted credential document on the client;
- never returned through the preload bridge, inserted into the page, placed in a URL, or written to browser storage;
- injected by a loopback-only Electron relay after browser `Origin` headers are removed;
- sent only to the exact saved managed HTTPS or `.ts.net` origin; absolute-form request targets cannot redirect it elsewhere.

The host companion remains the authorization boundary. Its route list defaults to deny, strips sensitive response fields, and can revoke the desktop client from **Settings → Remote access** like any other paired device. Interactive desktop access is a separate per-device capability that defaults off. Client mode does not expose host-only settings, local browser surfaces, Local VM controls, plugin credentials, destructive account revocation, or the event inspector. Connected Apps may be viewed and authorized remotely while their tokens and execution remain on the host.

The desktop client matches the reviewed companion feature surface: chats, rooms, streamed responses, approvals, inline Connected Apps authorization, search, routines, attachments, and a narrowly scoped cloud/VPS viewer the host explicitly grants to that paired device. Expanding the desktop client must be done by explicitly reviewing and adding companion routes; it must not bypass the companion API or proxy the full harness.

## Runtime shape

```text
desktop renderer
      │ same-origin HTTP/SSE, no bearer
      ▼
Electron relay 127.0.0.1:8798 (fallbacks: 18798, 28798)
      │ bearer injection over verified managed HTTPS or Tailscale/WireGuard
      ▼
host companion :8810
      │ authentication + route allowlist + response scrubbing
      ▼
host harness 127.0.0.1:8799
```

While client mode is active, Electron does not start its local harness, companion sidecar, computer-use daemon, or browser engine host. The renderer still uses ordinary same-origin API calls and `EventSource`, so the existing UI and streaming store do not learn or handle a second transport.
