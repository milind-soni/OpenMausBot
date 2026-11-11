# Qwen Audio Realtime: web-client verification

Qwen is an optional Live provider for the web client and self-hosted harness.
The existing OpenAI/Azure WebRTC path is retained. The native mobile apps are
not implemented or qualified by this change; see #5156 for the transport and
OpenAI-key preflight question.

## Configuration

Select **Qwen Audio Realtime** in Call settings. Choose the region, optional
workspace, `qwen-audio-3.1-realtime-flash` or `qwen-audio-3.1-realtime-plus`,
and a voice. Save the Qwen key through its provider-specific credential form.
The server exposes only configured/key-target booleans, not the key value.
The credential must belong to the selected region/workspace. Changing its
credential target invalidates the previous binding.

HTTP credential saves and removals through `/api/config` include a top-level
`qwenKeyTarget: { region, workspace }` snapshot alongside `live.qwen.key`.
The server returns 409 if that snapshot is missing or the destination changed
before the write. Reload Call settings before retrying. The snapshot is not
persisted; `keyFor` is always derived by the server.

The on-disk native `live.provider` enum is unchanged for program-rollback
compatibility. Qwen settings live under `live.qwen`; the public settings API
reports the effective provider as `qwen` when enabled. There is no fallback to
an OpenAI key, environment credential or arbitrary/redirected provider host.

A preset is not proof of provider availability forever. The catalog contains
69 voices accepted by a Beijing Flash `session.update` handshake during local
integration testing. That test is not acoustic verification of all voices,
Plus, Singapore, or a private workspace. Some TTS-list voices are not accepted
by the realtime service. Preserve custom/cloned IDs without silently replacing
them, and show the explicit unsupported-voice error if the provider rejects one.

## Transport and authorization

The web client advertises `transports: ["ws-pcm"]` to `POST /api/live/session`.
For Qwen the server responds with a `ws-pcm` descriptor rather than an SDP
answer, with the fixed `/api/live/media` route and 16 kHz input / 24 kHz output.
The media socket must bind to the exact authenticated call/session and has one
consumer. It cannot submit arbitrary provider control events or approval
commands. Session revocation closes the bound media channel.

`credit-v1` is explicitly negotiated. A bounded consumption-credit window
stops downlink draining when the browser cannot make progress. Sequence and
clear-epoch checks prevent duplicate or stale credits from reviving cancelled
audio. Legacy clients keep their original bind behavior. Audio capture uses
an AudioWorklet with bounded frame credits and a one-second stale-frame limit;
old or incomplete spoken requests must not be replayed after a long stall.

The original bot receives the completed spoken request, executes its own
ordinary task lifecycle, and reports asynchronous results for readout. The
realtime model is not a replacement tool-executing agent. Client playback
credits are untrusted flow-control signals, not proof the user heard audio or
consented. Qwen approvals require the existing clickable approval cards.

When a running bot turn has no request identifier, a new Qwen spoken request
waits in the existing queue so its eventual result can be matched and read out.
Turns with a request identifier remain eligible for mid-turn steering.

Completed turns are reclaimed while pending delegations retain their result
route until the controller releases them after its final update. The 256-entry
limits apply to live state; a long-running task must not be evicted to make
room for completed turns. Bounded recent-ID caches reject duplicate events.

After a ready PCM connection closes or the server reports it is ending, capture
stops immediately and the client waits up to three seconds for the matching
server end state. An idle or expired
call uses that end reason; missing final state remains a dropped call with a
retry action.

Silent PCM uploads do not reset the call's idle timeout. Provider-detected
speech, bot work and pending result audio keep an active call from timing out;
revocation and the playback-stall budget still apply. If a result finishes
generating before its queued audio is sent, an interruption marks that result
as incompletely spoken. Playback credits remain flow-control signals only.

## Repeatable offline checks

Use the repository-pinned Node and pnpm versions, then run:

```sh
pnpm exec vitest run \
  server/qwen-live-config.test.ts \
  server/qwen-live-config.e2e.test.ts \
  server/qwen-live-socket.test.ts \
  server/qwen-live-state.test.ts \
  server/qwen-live-flow.test.ts \
  server/qwen-live-playback.test.ts \
  server/qwen-live-credit.test.ts \
  server/qwen-live-credit-flow.test.ts \
  server/qwen-live-media.e2e.test.ts \
  server/qwen-live-steering.e2e.test.ts \
  server/routes/live-media.test.ts \
  server/routes/live-media-heartbeat.test.ts \
  server/routes/live.test.ts \
  server/live-call-controller.test.ts

pnpm exec vitest run \
  src/lib/live-pcm.test.ts \
  src/lib/live-pcm-worklet.test.ts \
  src/lib/live-pcm-media.test.ts \
  src/lib/live-call-media.test.ts \
  src/lib/qwen-audio-output.test.ts \
  src/lib/qwen-voices.test.ts \
  src/components/QwenAudioOutputSettings.dom.test.ts \
  src/components/keys/KeysPage.dom.test.ts

pnpm typecheck
pnpm i18n:check
pnpm build:server
pnpm exec vite build
```

The server tests use provider stand-ins and disposable, loopback-only data.
They check credential isolation, exact session ownership, untrusted control
rejection, tool/result correlation, card-only approval, interruption, bounded
queues, paused playback recovery and cleanup. The heartbeat test uses real
WebSockets with a controlled interval clock and checks that peer-supplied
close text is not logged. DSP/browser tests use synthetic audio and stand-ins
for device APIs; they do not certify physical sound or mobile hardware.

## Manual provider/device qualification

Never use a person's running app or real conversations as a test fixture.
Launch an isolated fixture as described in [README.md](README.md), use a
disposable bot and explicit fixture URL. The `control-omb launch` command
serves the API, not the renderer. Keep it running and, in a second terminal,
start Vite with `OMB_PORT` set to the port in the printed fixture URL:

```sh
OMB_PORT=<fixture-port> pnpm exec vite --host 127.0.0.1 --strictPort
```

Open the Vite URL printed by this command for the manual call. Vite proxies
both API requests and WebSocket traffic to the isolated fixture. Continue to
use the fixture URL for `control-omb` commands. Stop Vite and interrupt the
fixture launcher with Ctrl-C when finished so it cleans up its temporary data.

Keep optional live-provider tests separate from credential-free regression
tests. Use only synthetic speech and requests if supplying a test-owned Qwen
credential.

Verify: a completed spoken request reaches the original bot; greetings while a
task is pending do not cancel/resubmit it; the final result is read out;
interruption clears old audio; a short AudioContext suspension can resume the
same call; sustained stale upload fails without replaying a partial command;
and microphone, timers, socket and call slot are released on hangup/revocation.
Read back the exact task, conversation and call state, not just a click result.

Output-device routing uses actual `AudioContext.setSinkId` capability detection
and stores preferences only in the current browser. Unsupported or denied
output switching must leave the call usable and disclose the system fallback.
A suspended/interrupted context has an explicit resume action; playback with
queued audio still has a 60-second no-progress budget. This does not promise
survival across arbitrary background freezes, lock screen or network loss.

## Client-version and scope limits

- Refresh browser pages after installing or rolling back a server/renderer.
  Already-loaded JavaScript is not updated by a server restart. In particular,
  an official server without `transports` support may reject a new page's
  strict session-request shape until that page is refreshed.
- Installing the server patch does not rebuild a native Android/iOS app. Its
  OpenAI key prompt and native call/audio path require maintainer guidance and
  a separate mobile integration.
- No auto-reconnect/replay of spoken requests is attempted. The media ping and
  close-code diagnostics improve liveness/observability, not a guarantee that
  intermittent disconnects are solved.
- No patient, production-chat, account, or deployment evidence is needed in
  public verification artifacts.
