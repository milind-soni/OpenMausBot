# Android recovery after an early event-stream close

A route that responds HTTP 200 but closes `/api/events` before the initial
`hello` never established a live connection. Android used to reconnect to
that authority indefinitely, displaying “Lost the connection.” even when a
healthy protected fallback was already advertised.

The client now treats that early EOF as a route failure. Existing candidate
selection chooses the next authorized route; it does not permit a downgrade
to an unapproved local address. A stream that did receive `hello` still
reopens on its working route with the saved cursor. The existing one, two,
four, eight, then fifteen second backoff and unauthorized handling remain.

## Isolated verification

From `android/`, with the Android SDK and JDK configured:

```sh
./gradlew :core:test --tests '*SessionStreamRecoveryTest' \
  --tests '*SessionTest.streamEnding*' --tests '*SessionTest.cleanStreamEnd*' \
  --tests '*FailoverTest'
./gradlew :core:test :app:testDebugUnitTest :app:assemblePreview
```

`SessionStreamRecoveryTest` uses the production Session, HTTP client and SSE
parser against two disposable loopback servers. Synthetic `.ts.net` names
exercise the protected-route policy, with a test-only DNS resolver pinned to
loopback. The primary returns a comment-only stream and closes before hello;
the fallback returns hello and a subsequent frame. Recovery must happen in
the same Session without restarting or pairing again. No installed Tailscale,
external host, real token or user workspace is contacted.

Virtual-time regressions also check early-EOF fallback and post-hello
reconnection on the original route with its cursor, including a chunked
stream truncated after hello. Failover tests verify
that an EOF cannot select a disallowed local fallback. Existing tests retain
single-route backoff, unauthorized termination and deliberate disconnect.

## Evidence and limits

Final Android validation passed: 546 core tests and 914 app tests, with no
failures or skips. The preview APK built successfully and its v2 signature
verified. The five added regressions cover early closure, normal closure,
post-hello truncation, credential-safe route selection and actual HTTP/SSE
recovery. No physical phone or real network transition was exercised.

On base `0c327bca`, the new state-machine fallback assertion failed and the
real HTTP fixture timed out without reaching the healthy endpoint. Both pass
with the fix; the healthy-reconnect regression passes before and after.
Evidence logs: `/tmp/moca179-red.log`, `/tmp/moca179-http-red.log`,
`/tmp/moca179-focused.log`, `/tmp/moca179-review-red.log`, and
`/tmp/moca179-android-final.log`.

This addresses one reproduced persistent-offline path in MOCA-179. The
reporter's roughly hourly trigger and physical-device network conditions
have not been reproduced; do not treat this as proof that every reported
connection loss is resolved. No UI or server behavior changes are included.

The first implementation also rotated on any EOF exception; independent review
caught that this could move a live stream unnecessarily. The post-hello
truncation regression failed against that version. Only the dedicated
before-hello closure error now permits fallback.

The broader repository suite was not repeated for this Android-only change.
At the same base `0c327bca`, the earlier queue run recorded 7,348 Vitest passes,
a delegate-session replay assertion also failing on pristine main, and an
Electron proxy timeout that passed on rerun. Broker, Electron unit and packaged
server checks passed separately. Those baseline findings remain documented in
PR #1534; they do not constitute a green repository-wide check for this PR.
