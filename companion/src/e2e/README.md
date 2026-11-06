# End-to-end encrypted phone connection, wire spec v1

The phone and this computer agree on keys at QR pairing, and every connection proves both sides. The same encrypted
connection runs over three routes: straight over Wi-Fi, over Tailscale, and through MausBot Relay, which passes sealed
bytes between the two and can't open them. This file is the normative spec; `vectors/v1.json` is the contract every
implementation (desktop, relay, phones) tests against.

| File | What |
|---|---|
| `credentials.ts` | psk, admission value, keyId, strict base64url, relay token mint and verify |
| `noise.ts` | `Noise_NKpsk0_P256_AESGCM_SHA256` initiator and responder, transport records |
| `yamux.ts` | the yamux profile: codec and an I/O-free stream state machine |
| `descriptor.ts` | the `e2e` pairing descriptor |
| `gen-vectors.ts` | writes `vectors/v1.json` and `vectors/v1.sha256`; `--check` fails if they would change |

Tests: `companion/test/e2e/`.


Everything a Node, Swift or Kotlin implementer needs. MUST and NEVER are binding.


Everything a Node, Swift or Kotlin implementer needs. MUST and NEVER are binding.

## 1. Conventions

- **Bytes.** Binary values in JSON and URLs are base64url without padding ("b64u"). Integers on the wire are big-endian unless stated.
- **P-256 keys.** Public keys are 65-byte uncompressed SEC1 (`0x04‖X‖Y`). An implementation MUST reject points that are off the curve or not
  canonical. CryptoKit, JCA and Node's `ECDH.computeSecret` do this when given the raw point; keep that check.
- **DH(priv, pub)** is P-256 ECDH and outputs the 32-byte X coordinate (CryptoKit `sharedSecretFromKeyAgreement` raw bytes; JCA
  `KeyAgreement("ECDH").generateSecret()`; Node `ECDH.computeSecret`).
- **Primitives.** SHA-256 and HMAC-SHA256. AES-256-GCM with a 12-byte nonce and a 16-byte tag.
- **Strings** are UTF-8. `‖` is concatenation.

## 2. Identities and derived secrets

| Name | What | Where it lives |
|---|---|---|
| `T` | The computer's **transport key**, a long-lived P-256 key pair separate from the HPKE credential key | Private half: Electron secure credential document field `e2eTransportKey` (same pattern as `phoneSecretHpke`, `electron/phone-secret-identity.mjs`), handed to the sidecar in memory. Standalone sidecar: `$OMB_COMPANION_DIR/e2e-key.json`, mode 0600 |
| `keyId` | `SHA256(T.pub)[0:16]` (16 bytes) | Derived |
| `hostId` | 16 random bytes, made by the control plane once per installation | D1 `installations.relay_host_id`; Electron credential document |
| `cred` | A device token `omb_…` (`electron/desktop-companion-client.mjs:11`), or the pairing token `omb_pair_…` while a window is open | Phone keychain; desktop stores only `SHA256(cred)` hex (`companion/src/devices.ts:54`) |
| `psk` | `HMAC-SHA256(key = SHA256(cred), msg = "omb-e2e psk v1" ‖ keyId)` (32 bytes) | Derived on both sides; the desktop computes it from the stored hash |
| `adm` | `HMAC-SHA256(key = SHA256(cred), msg = "omb-relay admission v1" ‖ hostId)` (32 bytes) | The phone sends it to the relay; the relay only ever holds `SHA256(adm)` |

`SHA256(cred)` is the raw 32-byte digest of the token string's UTF-8 bytes. The desktop gets it by hex-decoding `tokenHash`. Knowing `adm`
reveals nothing about `psk`: the two are separate HMAC outputs under different labels.

## 3. Pairing payload (QR link) and descriptors

- **The QR link** (`openmausbot://pair?...`, built by `shared/pairing-link.ts`) keeps every field it has today and gains one query parameter:
  `e2e=<b64u(JSON)>`, where the JSON is:

```json
{"v":1,"k":"<b64u 65-byte T.pub, 87 chars>","h":"<b64u 16-byte hostId, 22 chars>","r":["relay1.openmausbot.com","relay2.openmausbot.com"]}
```

- **Field rules:**
  - `v` MUST be 1.
  - `k` is required.
  - `h` and `r` are present only when the computer has a relay token (signed in, relay enabled, and the device isn't restricted to "Wi-Fi and
    Tailscale only").
  - `r` lists 1 to 4 hostnames in the order to try. Each MUST match `^relay[1-9][0-9]?\.openmausbot\.com$`.
  - `routes` is optional, `"any"` or `"local"`. `"local"` means the computer restricted this device to Wi-Fi and
    Tailscale; it never comes with `h` or `r`. Absent means `"any"`, so a descriptor without `h` and `r` and without
    `"local"` only says the computer has no relay right now (signed out, or outside the rollout). The QR never carries
    `"local"`: a restriction is set per phone after pairing, and reaches it through the endpoint list.
  - The encoded value is at most 1,024 bytes.
- **Phone parsing rules:**
  - A malformed `e2e` rejects the whole invite. That includes bad base64, bad JSON, a bad point, `h` without `r` or `r` without `h`, and a host
    outside the allowlist.
  - `v > 1` shows "Update the MausBot app to pair with this computer". It NEVER falls back to plain pairing.
  - Old app builds ignore the unknown parameter, as they do today.
- **Direct routes** come from the existing `endpoints` and `hosts` parameters. The phone turns each `lan`, `bonjour` or `tailnet` URL
  `http://H:P` into `ws://H:P/v1/e2e`. A `hosted` URL is never used for E2E.
- **Pair response.** `POST /api/pair` returns 200 with `{token, device, serverName, hosts?, endpoints?}` plus `"e2e": {…same object…}`.
- **Endpoint list.** `GET /api/companion/endpoints` returns `{serverName, hosts?, endpoints[]}` plus `"e2e": {…}`. The response is built for
  the device that asks: `h` and `r` are left out if that device is restricted.
- **Pinning:**
  - A phone that holds a QR-pinned `k` MUST NEVER replace it from a network response.
  - A phone paired before this feature (no `k`) accepts `k` once from `/api/companion/endpoints`, over the route it already trusts (trust on
    first use), and pins it from then on.
  - A pin mismatch is a hard stop (section 12).

## 4. Routes and URLs

| Route | URL the phone dials | WebSocket subprotocol | Prologue `transport` byte |
|---|---|---|---|
| Wi-Fi | `ws://<lan or bonjour host>:<port>/v1/e2e` | `omb-e2e.v1` | `0x02` (direct) |
| Tailscale | `ws://<name>.ts.net:<port>/v1/e2e` | `omb-e2e.v1` | `0x02` (direct) |
| Relay | `wss://<r[i]>/v1/phone` | `omb-relay.v1` | `0x01` (relay) |

The sidecar serves `/v1/e2e` on its existing `:8810` upgrade handler (`companion/src/index.ts:145`). It refuses any upgrade that carries an
`Origin` header, the same rule as `companion/src/proxy.ts:637-639`.

## 5. Handshake: `Noise_NKpsk0_P256_AESGCM_SHA256`

This follows the Noise Protocol Framework rev 34 (its §5 processing rules, §9 PSK rules, §11.2 AESGCM and §12 HASH/HKDF) with DH = P-256 as in
section 1, `DHLEN` = 32 and public keys encoded at 65 bytes.

**Pattern:**

```
NKpsk0:
  <- s
  ...
  -> psk, e, es
  <- e, ee
```

**Symmetric state** (Noise §5.2):
- `h`: protocol name `"Noise_NKpsk0_P256_AESGCM_SHA256"` (31 bytes) padded with zeros to 32 bytes.
- `ck = h`.
- `k` empty, `n = 0`.
- `HKDF(ck, ikm, num)` is Noise's HKDF (HMAC-SHA256, `temp = HMAC(ck, ikm)`, `out_i = HMAC(temp, out_{i-1} ‖ byte(i))`).
- `MixHash`, `MixKey`, `MixKeyAndHash`, `EncryptAndHash` and `DecryptAndHash` are exactly as Noise defines them.
- `ENCRYPT(k, n, ad, p)` is AES-256-GCM with nonce `0x00000000 ‖ uint64_be(n)` and AAD `ad`.

**Prologue** (11 bytes): `"omb-e2e/1" ‖ 0x00 ‖ transport`, with `transport` from section 4.

**Initialization, both sides:** `MixHash(prologue)`, then `MixHash(T.pub)` for the responder's pre-message `s`.

**Message 1, phone to computer**, one WebSocket binary message:
1. `MixKeyAndHash(psk)`.
2. Generate an ephemeral `e`. Write `e.pub` (65 bytes). `MixHash(e.pub)`, then `MixKey(e.pub)` (the psk rule).
3. `MixKey(DH(e.priv, T.pub))`.
4. Write `EncryptAndHash(payload1)`, where `payload1` is UTF-8 JSON of at most 512 bytes:
   `{"v":1,"conn":"<b64u 16 random bytes>","app":"<platform/version, ≤40 chars>"}`.

The message is `e.pub(65) ‖ ciphertext(len(payload1) + 16)`.

**Computer processing message 1:**
- Compute `es = DH(T.priv, re)` once.
- Run the symmetric state from the post-initialization snapshot once per candidate `psk`. The candidates are every paired device that is allowed
  on this transport, plus the open pairing window if there is one (at most 21).
- Process `psk, e, es` for each candidate and try `DecryptAndHash`. The first success identifies the device.
- No match, a bad point, or a `payload1` with `v ≠ 1` or missing `conn`: close with 4001 (section 11). Never answer with anything else.
- A device restricted to "Wi-Fi and Tailscale only" is not a candidate when `transport = 0x01`.

**Message 2, computer to phone:**
1. Generate `e`. Write `e.pub`. `MixHash(e.pub)`, then `MixKey(e.pub)`.
2. `MixKey(DH(e.priv, re))`.
3. Write `EncryptAndHash(payload2)`, where `payload2` is `{"v":1,"conn":"<echo of payload1.conn>"}`.

**Phone processing message 2:**
- A decrypt failure means the computer doesn't hold the pinned key's private half, or the message was tampered with. Hard stop (section 12).
- If `v ≠ 1` or `conn` doesn't match: hard stop.

**Split** (Noise `Split()`): `HKDF(ck, empty, 2)` gives `k_pc`, the key for phone→computer messages, then `k_cp`, the key for
computer→phone messages. Each starts at `n = 0`. The final `h` is the session's `handshakeHash`. Logs may record `hex(h[0:4])`.

**Deadline:** both sides close if the handshake isn't complete 10 s after the WebSocket opens (or after relay `ready`, section 9).

## 6. Transport messages

- After `Split`, every WebSocket binary message in each direction is exactly one AEAD record:
  `ENCRYPT(k_dir, n_dir, ad = empty, plaintext)`, where the plaintext is exactly one yamux frame (section 7).
- The receiver tracks its own `n` for that direction. A record that fails to open closes the session with 4000, with no retry and no skipping.
  Because `n` is never sent, any drop, reorder, replay or reflection fails to open.
- A record is at most 65,535 bytes, so the plaintext is at most 65,519.
- A text WebSocket message after the handshake is a protocol error (4000).
- Either side closes the session (code 1000) before `n` reaches 2^32. The phone then reconnects. At a realistic 100 records a second that is
  more than 400 days.

## 7. Multiplexing: the yamux profile

This uses the yamux wire format (`hashicorp/yamux` spec): a 12-byte header of `version:u8 = 0`, `type:u8`, `flags:u16`, `streamId:u32` and
`length:u32`.

| Item | Value |
|---|---|
| Types | 0 Data, 1 WindowUpdate, 2 Ping, 3 GoAway |
| Flags | SYN 0x1, ACK 0x2, FIN 0x4, RST 0x8 |
| Who opens streams | The phone only. Odd IDs 1, 3, 5, … increasing, never reused. A computer-opened stream or an even ID from the phone means GoAway(1), then close 4000 |
| Open | WindowUpdate {SYN} with `length = 1,835,008`, which raises the 256 KiB starting window to 2 MiB. The phone may send Data before the ACK, within 256 KiB |
| Accept | WindowUpdate {ACK} with `length = 1,835,008` |
| Refuse | WindowUpdate {RST}, length 0 |
| Max Data payload | 65,507 bytes (65,519 − 12) |
| Per-stream receive window | 2 MiB. Send a WindowUpdate once at least 1 MiB has been consumed. Data beyond the window means GoAway(1), then close 4000 |
| Concurrent streams per session | 64, counting un-ACKed opens. The 65th is answered with RST |
| Half close | FIN on Data or WindowUpdate. A stream ends when both FINs are seen, or on RST |
| Keepalive | Each side sends Ping {SYN, length = opaque u32} every 20 s. The peer answers Ping {ACK, same value}. No answer within 10 s closes the session (1001) |
| GoAway | StreamId 0, `length` = 0 normal, 1 protocol error, 2 internal error, 3 removed. 0 is sent before a planned close (quit, sleep, restart). 3 goes only from the computer to the phone, when the person removed this device, right before the 4001 close |
| Session flow | No session-wide window. Backpressure comes from the WebSocket: a sender stops writing records while the socket's buffered amount is above 1 MiB |
| Stream ID ceiling | At `streamId > 2^31 − 1` the phone opens a new session |

## 8. Stream semantics

- **Every stream is a raw, two-way byte pipe** from the phone's HTTP stack to the sidecar's E2E origin listener.
  - The listener is a private Unix socket or named pipe served by the same proxy handler as the managed origin
    (`companion/src/index.ts:147-148`): allowlist, device-token auth, gzip and WebSocket upgrades.
  - The bytes are HTTP/1.1 as the phone's stack writes them, including keep-alive, chunked bodies, `Upgrade: websocket`, `Range` and SSE.
  - The E2E layer never parses them. v1 has no other stream services.
- **Computer side:**
  - On SYN it connects to the E2E origin socket.
  - If that fails it sends RST; once connected it sends ACK.
  - Phone FIN calls `socket.end()`. Origin end sends FIN. An error on either side sends RST.
  - It grants window only as origin writes drain.
- **Phone side:**
  - **iOS:** a loopback listener per session, `NWListener` on `127.0.0.1:<random>`. Each accepted TCP connection becomes one stream.
    - Before opening the stream the listener reads the first request head (up to 16 KiB, 2 s deadline). The head MUST carry
      `X-OMB-Loopback: <b64u 32-byte per-launch secret>`.
    - Anything else is closed without opening a stream.
    - `CompanionClient` adds that header on every request for an E2E connection, including `viewerSocketRequest` and `BrowserLiveClient`.
  - **Android:** an in-process `javax.net.SocketFactory` that returns a `java.net.Socket` subclass backed by one stream. There is no port.
    - The companion `OkHttpClient` uses it together with a `Dns` that maps `h-<hostIdHex>.e2e.invalid` to a placeholder address.
    - `setSoTimeout` MUST be honoured, so OkHttp's existing read timeouts (90 s for SSE) keep working.
    - The outer WebSocket client is a separate `OkHttpClient` that uses the normal socket factory.

## 9. Relay protocol (outside the encryption)

- **Hosts.** The relay nodes are `relay1.openmausbot.com` and `relay2.openmausbot.com`, WSS on 443. Caddy terminates TLS and proxies to the
  relay on `127.0.0.1:8080`. Auth is always the **first WebSocket message**, which works with every WebSocket client (Node's built-in client
  included).
- **Pre-auth rules:**
  - The relay accepts exactly one text message of at most 4 KiB within 5 s.
  - Anything else before auth, a binary message included, closes with 4400.
  - The WebSocket `maxPayload` is 70,000 bytes on every socket, before and after auth (1009 if exceeded).

**Host control socket** (`GET /v1/host`, subprotocol `omb-relay.v1`, text JSON only):

| Dir | Message | Meaning |
|---|---|---|
| host→relay | `{"t":"auth","v":1,"token":"<relay token>"}` | First message. Sent again to refresh before `exp`. Must keep the same `hid` |
| relay→host | `{"t":"hello","v":1,"node":"relay1","sessionsMax":16}` | Auth accepted |
| host→relay | `{"t":"admit","set":["<b64u SHA256(adm)>",…]}` | The full replacement admission set, at most 32 entries. Required within 5 s of `hello`, and again on every pair, revoke, restriction change, or pairing window open or close. Sessions whose `adm` leaves the set are closed with 4404 |
| relay→host | `{"t":"open","sid":"<b64u 16 bytes>"}` | A phone is waiting. The host must open a data socket within 10 s |
| relay→host | `{"t":"restarting","reconnectInMs":0,"tryForMs":15000}` | Deploy or shutdown. Reconnect after `reconnectInMs + random(0, tryForMs)` |
| relay→host | close 4409 | A newer control socket for the same `hid` took over. Spliced sessions are not affected |

**Host data socket** (`GET /v1/host/data`): the first message is `{"t":"data","v":1,"sid":"…","token":"<relay token>"}`. The token's `hid` must
own the `sid`, and a `sid` is single-use with a 10 s life. The relay then splices and the socket carries only binary.

**Phone socket** (`GET /v1/phone`):
- The first message is `{"t":"phone","v":1,"hid":"<b64u hostId>","adm":"<b64u adm>"}`.
- If that host isn't connected to this node **or** `SHA256(adm)` isn't in its set, the relay closes with **4404** (both cases, so online status
  doesn't leak).
- Otherwise it sends `open` to the host, waits for the data socket, and sends `{"t":"ready"}` to the phone. From then on only binary passes.
- The phone sends handshake message 1 after `ready`. Binary from the phone before `ready` means 4400.

**Close codes:**

| Code | Sent by | Meaning | Phone or host does |
|---|---|---|---|
| 4400 | relay | Malformed or out-of-order message | Treat as a bug; back off |
| 4401 | relay | Host token invalid or expired | Host fetches a new token |
| 4404 | relay | Computer not connected here, or not admitted | Phone tries the next `r[]` node; when all are tried, "asleep or offline" |
| 4408 | relay | The host didn't open a data socket in time | Retry once, then back off |
| 4409 | relay | Replaced by a newer host control socket | Host: stop (the newer one wins) |
| 4429 | relay | Rate, size or byte limit | Back off, at least 30 s |
| 4503 | relay | Restarting or full. Reason is JSON `{"retryInMs":N}` | Wait N plus jitter, then try the next node |
| 4000 | either end | E2E protocol error (AEAD, framing, window) | Hard stop for this session; reconnect with backoff |
| 4001 | computer | Handshake rejected (no psk matched), or the device was removed (after GoAway(3)) | Phone: on a direct route, or after GoAway(3), "This phone was removed from your computer. Pair again." Through the relay without GoAway(3), the relay may have written it: retry with backoff |
| 4002 | either end | Handshake deadline passed | Retry with backoff |

**Relay token** (minted by the control plane, checked by the relay offline):
- Format: `b64u(payloadJSON) "." b64u(Ed25519 signature over the ASCII bytes of the first part)`.
- Payload: `{"v":1,"kid":"k1","hid":"<b64u>","iid":"<installation id>","iat":<s>,"exp":<s>}` with `exp = iat + 12 h`.
- The relay holds public keys only: `RELAY_TOKEN_KEYS = {"k1":"<b64u 32-byte Ed25519 public key>"}`, up to 2 for rotation.

**Control plane endpoint:** `POST /v1/installations/self/relay-token` with `Authorization: Bearer <omb_install_…>`.
- **Request body:** `{"appVersion":"0.1.150","devices":{"e2e":2,"legacy":1}}`. The counts are for adoption gates and carry no
  identifiers.
- **200 response:** `{"token","hostId","nodes":["relay1.openmausbot.com","relay2.openmausbot.com"],"expiresAt","refreshAfter"}`.
  - `refreshAfter = iat + 1 h`.
  - `nodes` is ordered by rendezvous hash: highest `SHA256(hostId ‖ nodeName)[0:8]` first. A future US node is ranked first when the
    request's `cf.continent` is NA or SA.
- **Other responses:**
  - `503 relay_unavailable`: rollout off or kill switch. The desktop stays on Wi-Fi and Tailscale.
  - `401`: install credential expired, which leads to recovery as today.
  - `429`: more than 60 a hour.

## 10. Timers and limits

| What | Value |
|---|---|
| Handshake deadline | 10 s, both ends |
| yamux ping | Every 20 s; dead if no answer in 10 s |
| Relay WebSocket ping (to every socket it owns) | Every 20 s; dead if no pong in 10 s |
| Phone direct attempt timeout / relay attempt timeout | 5 s / 10 s |
| Host reconnect after loss | Immediate, then 1, 2, 4 … 60 s with ±20% jitter |
| Host reconnect after `restarting` / 4503 | `reconnectInMs + random(0, tryForMs)`; default random 1–15 s |
| Sleep detection (desktop) | A wall-clock jump of more than 5 s against the monotonic clock, checked every 2 s, or Electron `powerMonitor` `resume`: redial now |
| Host returns to its first node | While on a later node, try the first every 10 min ±2 min. Move when it accepts: open the new control socket, then close the old one |
| Token refresh | Every 1 h. On failure retry with backoff; spliced sessions survive an expired control socket |
| Relay per-IP | 60 new sockets a minute (token bucket), 256 open sockets (allows for carrier NAT) |
| Relay per host | 1 control socket, 16 phone sessions, admission set of 32 |
| Relay backpressure | Pause the source when the destination's buffered amount is above 1 MiB; resume below 256 KiB. No drain progress for 60 s means close 4429 |
| Relay heavy session | Averaging more than 50 Mbit/s over 30 min: throttle to 20 Mbit/s |
| Relay per-host byte budget | 50 GB a day, then 4429 plus an alert (abuse brake) |
| Relay global | 30,000 sockets per node, then 4503 `{"retryInMs":5000}`. Alert at 70% |

## 11. Fail-closed rules (MUST)

1. There is no plaintext mode, and no message from the relay can switch encryption off or change keys, versions or cipher.
2. A pin mismatch, a message 2 that fails to decrypt, `v ≠ 1`, or a `conn` mismatch stops the session. The phone shows "Couldn't verify your
   computer. Pair again." and does **not** retry that connection automatically.
3. Once a connection has a pinned `k`, the phone NEVER again uses the plain HTTP routes (`lan`, `bonjour`, plain `tailnet`) or the `hosted`
   tunnel route for that connection. E2E routes only.
4. Once a device has completed an E2E session (`DeviceRecord.e2eAt`), the sidecar refuses that device's token on the plain `:8810` listener
   (`426 {"error":"update_app"}`). The only exception is `/api/health`.
5. Every AEAD failure, unexpected yamux frame or window violation closes the whole session. Nothing is skipped.
6. Key and pin comparisons are full-length and constant-time.

## 12. What the phone shows (error → one line)

| Evidence | Line |
|---|---|
| Every route failed and the relay answered 4404 from every node | "Your computer is asleep or offline." |
| The phone has no network (path monitor) | "You're offline." |
| Direct routes failed and the relay couldn't be reached | "Can't reach MausBot Relay right now. Trying again…" |
| Restricted device, not on the home Wi-Fi or the tailnet | "This phone is set to Wi-Fi and Tailscale only." |
| Message 2 failed / pin mismatch | "Couldn't verify your computer. Pair again from your computer's Settings." |
| GoAway(3) inside the session, or close 4001 on a direct route | "This phone was removed from your computer. Pair again." |
| Close 4001 through the relay with no GoAway(3) before it | Nothing yet: a relay can forge close codes, so keep retrying with backoff. It reads as "removed" only if a direct route also answers 4001 |
| `e2e.v > 1` or 426 | "Update the MausBot app to connect to this computer." |
| 4429 / 4503 lasting more than 30 s | "MausBot Relay is busy. Trying again…" |

## 13. Rules the vectors pin

These make the sections above exact where an implementation could otherwise choose. Each one has a V6 case.

**Handshake**
- Message 1 is 81 to 593 bytes (`65 + 16` to `65 + 512 + 16`), message 2 the same. Anything else is refused before any
  crypto: the computer closes 4001, the phone hard-stops.
- `payload1`: a JSON object with `v` equal to the number 1, `conn` the b64u of exactly 16 bytes, and `app` (optional) a
  string of at most 40 characters. Key order and whitespace are free. Anything else closes 4001.
- `payload2` is checked the same way: `v` must be 1 and `conn` must equal the one sent.
- The computer tries every candidate psk, not only until the first match, so timing doesn't reveal which device it is.
- Vector tests feed `payload1` and `payload2` as exact bytes, since JSON encoders differ in key order.

**Records**
- A record is 16 to 65,535 bytes. An empty or longer one closes the session (4000).

**yamux**
- One record's plaintext is exactly one frame: Data is `12 + length` bytes, every other type exactly 12.
- Refused at decode (GoAway(1), then close 4000): `version ≠ 0`; `type > 3`; a flag bit above 0x8; Data `length > 65,507`;
  Data or WindowUpdate on stream 0; Ping or GoAway on a stream other than 0; Ping flags other than exactly SYN or exactly
  ACK; GoAway with any flag.
- A stream opens only with a WindowUpdate whose flags are exactly SYN; SYN on Data, or with another flag, is refused. The
  open's `length` is the window delta like any WindowUpdate (1,835,008 when sent).
- Only the computer sends ACK, only on WindowUpdate, and once per stream. ACK from the phone, or a second ACK, is refused.
- A frame for an odd stream ID at or below the highest opened, whose stream has ended (both FINs, or RST either way), is
  ignored: an RST and the peer's last frames cross. A frame for an even ID, or an ID above the highest opened, is refused.
- Data or FIN after the peer's FIN is refused.
- FIN is sent as WindowUpdate {FIN} with length 0, RST as WindowUpdate {RST} with length 0. FIN on Data is accepted.
- Window accounting: each side's receive window for a stream starts at 256 KiB and grows by every delta it grants (the
  open's 1,835,008 on the phone, the accept's 1,835,008 on the computer, and later WindowUpdates). Data beyond it is
  refused. The grant is sent once consumed-but-ungranted bytes reach 1 MiB, as one WindowUpdate for all of them.
- The computer answers a SYN that would be the 65th concurrent stream, or any SYN after it has sent GoAway, with RST.
- The computer sends no Data on a stream before it has sent the ACK.

**Descriptor**
- `v` must be an integer. `v > 1` means "update the app" whatever the other fields hold; `v < 1`, a string, or a missing
  `v` rejects.
- Unknown fields are ignored. Field order is free.
- `routes`, when present, must be the string `"any"` or `"local"`, and `"local"` with `h` or `r` rejects.

**Removal**
- A close code travels outside the encryption, and over the relay the relay writes it. When a device is removed, the
  computer first sends GoAway with `length` 3 inside the session, then closes with 4001. The phone treats only that
  GoAway(3), or a 4001 on a direct route, as removed. A 4001 from the relay without it (including at the handshake, where
  no session exists yet) means "couldn't confirm": retry with backoff and try a direct route. The computer refuses a
  GoAway(3) from the phone as a protocol error.
- base64url is strict everywhere (descriptor, keys, `h`, `conn`, tokens): the URL-safe alphabet only, no padding, and
  canonical (unused low bits of the last character are zero). Decode, re-encode and compare is enough.

**Relay token**
- At most 2,048 characters, exactly one `.`, both halves strict b64u, a 64-byte signature.
- Payload: `v` = 1, `kid` matching `^k[0-9]{1,3}$`, `hid` the b64u of 16 bytes, `iid` a string of 1 to 64 characters,
  `iat` and `exp` positive integers with `iat < exp ≤ iat + 43,200`.
- A `kid` not in `RELAY_TOKEN_KEYS` fails as `kid`; a bad signature as `signature`; `now ≥ exp` as `expired`; a refresh
  with a different `hid` as `hid`. Error names are informative: only pass or fail is required.

## 14. Test vectors

`vectors/v1.json` holds V1 to V9; `vectors/v1.sha256` pins it. Copies elsewhere check the SHA-256 so a stale copy fails.
Binary is hex unless a field name ends in `B64u`. Implementations take fixed ephemeral keys and exact payload bytes in
tests.

| # | Case |
|---|---|
| V1 | Derivations: `T.pub`, `keyId`, `SHA256(cred)`, `psk` and `adm` for a device and a pairing token, the DH outputs, and which encodings of a point are valid |
| V2 | Handshake over the relay (`0x01`) with the device psk: prologue, `h`, `ck` and `k` after every step, both messages, `k_pc`, `k_cp`, final `h` |
| V3 | The same over a direct route (`0x02`) with the pairing psk |
| V4 | Transport records of the V2 session: nonce, frame and record for each direction |
| V5 | yamux frames byte for byte |
| V6 | Must fail: handshake (computer closes 4001, or phone hard-stops), records (fails at which record), frames (decode), and session scripts |
| V7 | Pairing descriptors: valid ones and their parsed form; invalid ones and `reject` or `update` |
| V8 | Relay token: mint, and verify cases |
| V9 | Relay protocol messages for the vector host (informative) |

**Session scripts (V6 `sessions`).** Run the steps against a fresh mux in `role`. `{"open":true}` opens a stream from the
phone. `{"consume":{"stream":1,"bytes":N}}` reports N bytes consumed. `{"in":{"header":…,"payload":…}}` delivers one
frame; `"fill": 0` instead of `payload` means `length` zero bytes. With `"accept":"immediate"` the computer accepts each
stream as it opens; with `"never"` it doesn't. The expectation is either `errorAt` (the index of the step that must be
refused) or `sent` (every frame the mux sent, in order).
