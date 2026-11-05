import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createCloudAccountClient } from "../cloud-account.mjs";

export const accessToken = `omc_${"T".repeat(43)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await sleep(5); } assert.fail("Fixture did not reach the expected state"); }
export async function fixture(t, options = {}) {
  const f = { now: 1_800_000_000_000, requests: [], browsers: [], states: [], saved: null, approved: false, revoked: false,
    sessionStatus: 200, invalidIdentity: false, invalidEntitlement: false, badUrl: false, failWrite: false, slowToken: null,
    entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 }, timer: null, delay: null, cloud: undefined, expiresIn: 600,
    disk: { status: 404, body: "<!doctype html>not here" }, x: { status: 404, body: { error: "unsupported" } }, pages: { status: 404, body: { error: "unsupported" } }, sessionPage: null, sessionError: null, tokenPage: null, publicConfig: { status: 404, body: { error: "not_found" } },
    offer: undefined, checkout: { status: 404, body: "<!doctype html>not here" }, interest: { status: 200, body: { ok: true } },
    upgradePreview: { status: 404, body: { error: "not_found" } }, upgrade: { status: 404, body: { error: "not_found" } }, teams: undefined, teamPairing: { status: 404, body: { error: "not_found" } }, moved: { status: 404, body: { error: "not_found" } }, moveStatus: { status: 404, body: { error: "not_found" } },
    // An Admin before the app's Cancel and Keep: neither route, and the session's `clouds` absent.
    clouds: undefined, feedback: { status: 404, body: { error: "Not found." } }, renewal: () => ({ status: 404, body: { error: "Not found." } }) };
  const identity = () => ({ cloudContractVersion: 1, expiresAt: f.now + 86400_000, device: { id: "fixture-device" }, account: { id: "fixture-account", email: "person@example.test" } });
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    f.requests.push({ route: req.url, method: req.method, token: req.headers.authorization, version: req.headers["x-openmausbot-version"], body });
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/cloud/desktop/authorize") return send(201, { cloudContractVersion: 1, deviceCode: "A".repeat(43), userCode: "ABCDE-FGHJK",
      verificationUriComplete: f.badUrl ? "https://untrusted.example.test" : `${f.origin}/cloud/desktop?code=ABCDE-FGHJK`, expiresIn: f.expiresIn, interval: 5 });
    if (req.url === "/api/public/config" && req.method === "GET") {
      f.requests.at(-1).cookie = req.headers.cookie;
      if (typeof f.publicConfig.body === "string") { res.writeHead(f.publicConfig.status, { "content-type": "text/html" }); return res.end(f.publicConfig.body); }
      return send(f.publicConfig.status, f.publicConfig.body);
    }
    if (req.url === "/api/cloud/desktop/disk" && req.headers.authorization === `Bearer ${accessToken}`) {
      if (typeof f.disk.body === "string") { res.writeHead(f.disk.status, { "content-type": "text/html" }); return res.end(f.disk.body); }
      return send(f.disk.status, f.disk.body);
    }
    if (req.url === "/api/cloud/desktop/services/x" && req.headers.authorization === `Bearer ${accessToken}`) return send(f.x.status, f.x.body);
    if (/^\/api\/cloud\/desktop\/teams\/[^/]+\/pairing$/.test(req.url) && req.method === "POST" && req.headers.authorization === `Bearer ${accessToken}`) return send(f.teamPairing.status, f.teamPairing.body);
    if (req.url === "/api/cloud/desktop/services/pages" && req.headers.authorization === `Bearer ${accessToken}`) return send(f.pages.status, f.pages.body);
    if (req.url === "/api/cloud/desktop/moved" && req.method === "POST" && req.headers.authorization === `Bearer ${accessToken}`) return send(f.moved.status, f.moved.body);
    if (req.url === "/api/cloud/desktop/move-status" && req.method === "POST" && req.headers.authorization === `Bearer ${accessToken}`) return send(f.moveStatus.status, f.moveStatus.body);
    if (req.url === "/api/cloud/desktop/feedback" && req.method === "POST" && req.headers.authorization === `Bearer ${accessToken}`) return send(f.feedback.status, f.feedback.body);
    const renewal = /^\/api\/cloud\/desktop\/clouds\/([^/]+)\/(cancel|keep)$/.exec(req.url);
    if (renewal && req.method === "POST" && req.headers.authorization === `Bearer ${accessToken}`) { const answer = f.renewal(renewal[2], renewal[1]); return send(answer.status, answer.body); }
    for (const [route, answer] of [["/api/cloud/desktop/checkout", f.checkout], ["/api/cloud/desktop/interest", f.interest],
      ["/api/cloud/desktop/upgrade/preview", f.upgradePreview], ["/api/cloud/desktop/upgrade", f.upgrade]]) {
      if (req.url !== route || req.method !== "POST" || req.headers.authorization !== `Bearer ${accessToken}`) continue;
      if (typeof answer.body === "string") { res.writeHead(answer.status, { "content-type": "text/html" }); return res.end(answer.body); }
      return send(answer.status, answer.body);
    }
    if (req.url === "/api/cloud/desktop/token") {
      if (f.tokenPage) { res.writeHead(f.tokenPage, { "content-type": "text/html" }); return res.end("<!doctype html>Just a moment"); }
      if (f.slowToken) await f.slowToken;
      return f.approved ? send(200, { ...identity(), accessToken }) : send(400, { error: "authorization_pending" });
    }
    if (req.url === "/api/cloud/desktop/session" && req.headers.authorization === `Bearer ${accessToken}`) {
      if (req.method === "DELETE") { if (f.sessionPage) { res.writeHead(f.sessionPage, { "content-type": "text/html" }); return res.end("<!doctype html>Attention required"); } if (f.sessionStatus === 503) return send(503, { error: "unavailable" }); f.revoked = true; return send(200, { revoked: true }); }
      if (f.revoked) return send(401, { error: "invalid_token" });
      if (f.sessionPage) { res.writeHead(f.sessionPage, { "content-type": "text/html" }); return res.end("<!doctype html>Attention required"); }
      if (f.sessionError) return send(f.sessionError.status, f.sessionError.body);
      if (f.sessionStatus !== 200) return send(f.sessionStatus, { error: "unavailable" });
      return send(200, { ...identity(), ...(f.invalidIdentity ? { account: { id: "someone-else", email: "other@example.test" } } : {}),
        entitlement: f.invalidEntitlement ? { plan: "pro", status: "active" } : f.entitlement, ...(f.cloud === undefined ? {} : { cloud: f.cloud }),
        ...(f.offer === undefined ? {} : { offer: f.offer }), ...(f.teams === undefined ? {} : { teams: f.teams }), ...(f.clouds === undefined ? {} : { clouds: f.clouds }) });
    }
    send(404, { error: "not_found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  f.client = createCloudAccountClient({ origin: f.origin, fixture: true, deviceName: "Fixture computer", platform: "darwin", appVersion: "0.1.fixture", now: () => f.now,
    store: { read: async () => f.saved, write: async value => { if (f.failWrite) throw new Error("fixture storage failure"); f.saved = structuredClone(value); } },
    openBrowser: async url => { f.browsers.push(url); }, onState: state => f.states.push(state),
    setTimer: (callback, delay) => { f.timer = callback; f.delay = delay; return 1; }, clearTimer: () => { f.timer = null; f.delay = null; }, ...options });
  f.tick = () => { const callback = f.timer; assert.ok(callback); f.timer = null; callback(); };
  f.connect = async () => { await f.client.begin(); f.approved = true; f.tick(); await until(() => f.client.state().status === "connected"); };
  t.after(async () => { f.client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return f;
}
