# Closed-app phone alerts (harness side)

The harness asks the push relay in the hosted control plane to wake a phone
whose app is not open (`server/phone-push.ts`, contract in
`shared/phone-push.ts`, app side in `docs/ios-companion.md`). Verify it
against `server/testing/fake-control-plane.ts`, never the real control plane.

## Automated

```sh
pnpm exec vitest run server/phone-push.e2e.test.ts server/phone-push.test.ts server/routes/phone-push.test.ts shared/phone-push.test.ts
node --test electron/phone-push-relay.node-test.mjs
```

The e2e test boots the real server in a temporary home with a fake engine that
stops for approval in a room, and the fake relay in-process. Two phones are
registered, one through a paired session that holds the event stream and one
through the companion headers. It proves the room approval produces exactly
one push request, to the phone that is not watching, authenticated with the
installation credential, carrying only kind, names and ids (never the command
the bot asked to run). Revoking the session unregisters its token.

## By hand, on the isolated fixture

```sh
# 1. the fake relay: prints {"url","credential"} and logs each request
node --experimental-strip-types server/testing/fake-control-plane.ts 0 /tmp/relay.jsonl

# 2. the fixture; only a loopback OMB_CONTROL_PLANE_URL and its credential cross
OMB_CONTROL_PLANE_URL=http://127.0.0.1:PORT OMB_INSTALLATION_CREDENTIAL=omb_install_… \
FAKE_CLAUDE_REPLIES='["PRIVATE-REPLY-TEXT /Users/someone/secret.txt sk-live-abc"]' \
node --experimental-strip-types scripts/control-omb.ts launch
```

Then set `URL` to the address the launcher printed, for example:

```sh
URL=<printed launcher address>   # e.g. URL=http://127.0.0.1:PORT
```

1. Register a companion phone (the headers the sidecar adds):
   `curl -X PUT $URL/api/push/device -H 'x-openmausbot-companion: 1' -H 'x-openmausbot-companion-device: fixture-phone' -H 'content-type: application/json' -d '{"token":"<64 hex>","environment":"sandbox","pairing":"fixture-pair-1"}'`
   answers `"push":"on"`, `"relay":"registered"`; the relay log has one
   `register`.
2. `control-omb new-bot`, `PATCH /api/bots/:id {"notifications":true}`,
   `control-omb send` and `wait`: the relay log gains exactly one `send` with
   `kind: "done"`, title `"Scout finished"`, and none of the reply's text.
3. Hold `GET /api/events` with the same companion headers and send again: the
   stream gets the `notify` frame and the relay gets no `send`.
4. `PUT /api/config {"features":{"phonePush":false}}` and send again: no
   `send`; `GET /api/push/device` says `"push":"off"`.
5. `POST /api/live/device-revoked` with the companion headers: the relay log
   gains one `unregister`, and `GET /api/push/device` shows `"device":null`.

Interrupt the launcher with Ctrl-C and stop the fake relay.

## Not covered

No real APNs delivery, iOS app, or deployed control plane: those need the
relay's secrets and the app side. A room reply (`done`) produces no
notification at all today, so the room case is proven through an approval in
the automated test.
