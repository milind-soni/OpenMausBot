#!/usr/bin/env node
// Checks that Origin calls work on a deployment: the ICE config the app hands out, a relay-only (TURN) connection
// with those credentials, and two real browser peers joining the call page and exchanging audio and video.
// Credentials are never printed: the report lists only server URLs, candidate types and pass/fail.
//
//   ORIGIN_PEER_A_TOKEN=… ORIGIN_PEER_B_TOKEN=… ORIGIN_WORKSPACE_SLUG=acme \
//     node scripts/testing/check-call-peers.mjs https://origin.example.com [--relay] [--skip-peers]
//
// The two tokens are session tokens of two different members of the same workspace (localStorage
// "origin.sessionToken"). --relay forces the browsers onto TURN (iceTransportPolicy "relay") for the peer test too.
// Without tokens, ORIGIN_TURN_HOST and ORIGIN_TURN_SECRET in the environment are used to mint coturn REST
// credentials locally for the relay test only.
// On NixOS set PLAYWRIGHT_BROWSERS_PATH to a prepared browser directory.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const base = args.find(arg => !arg.startsWith("--"));
const relayOnly = args.includes("--relay"), skipPeers = args.includes("--skip-peers");
const tokenA = process.env.ORIGIN_PEER_A_TOKEN, tokenB = process.env.ORIGIN_PEER_B_TOKEN, slug = process.env.ORIGIN_WORKSPACE_SLUG;
const report = { base: base ?? null, checkedAt: new Date().toISOString(), iceServers: [], relay: null, peers: null };
const redact = servers => servers.map(server => ({ urls: server.urls, hasCredential: Boolean(server.credential) }));

async function iceConfig() {
  if (base && tokenA) {
    const response = await fetch(new URL("/api/local-voice/config", base), { headers: { Authorization: `Bearer ${tokenA}` }, cache: "no-store" });
    assert.ok(response.ok, `/api/local-voice/config answered ${response.status}`);
    return (await response.json()).iceServers;
  }
  const host = process.env.ORIGIN_TURN_HOST, secret = process.env.ORIGIN_TURN_SECRET;
  assert.ok(host && secret, "Give peer tokens and a base URL, or ORIGIN_TURN_HOST and ORIGIN_TURN_SECRET");
  const username = `${Math.floor(Date.now() / 1000) + 600}:check-call-peers`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return [{ urls: `stun:${host}:3478` }, { urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`], username, credential }];
}

/** Two RTCPeerConnections in one page that may only use relay candidates; passes when a data channel round-trips. */
async function relayTest(browser, iceServers) {
  const page = await (await browser.newContext()).newPage();
  await page.setContent("<!doctype html><title>relay</title>");
  return page.evaluate(async servers => {
    const config = { iceServers: servers, iceTransportPolicy: "relay" };
    const a = new RTCPeerConnection(config), b = new RTCPeerConnection(config);
    const types = { a: [], b: [] };
    a.onicecandidate = event => { if (event.candidate) { types.a.push(event.candidate.type); void b.addIceCandidate(event.candidate); } };
    b.onicecandidate = event => { if (event.candidate) { types.b.push(event.candidate.type); void a.addIceCandidate(event.candidate); } };
    const channel = a.createDataChannel("check");
    const echoed = new Promise((resolve, reject) => {
      b.ondatachannel = event => { event.channel.onmessage = message => event.channel.send(`echo:${message.data}`); };
      channel.onopen = () => channel.send("ping");
      channel.onmessage = message => resolve(message.data);
      setTimeout(() => reject(new Error(`no relay connection in 20 s (a: ${a.iceConnectionState}, b: ${b.iceConnectionState}, candidates ${JSON.stringify(types)})`)), 20000);
    });
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    try {
      const reply = await echoed;
      const stats = [...(await a.getStats()).values()];
      const pair = stats.find(row => row.type === "candidate-pair" && row.nominated && row.state === "succeeded");
      const local = pair && stats.find(row => row.id === pair.localCandidateId), remote = pair && stats.find(row => row.id === pair.remoteCandidateId);
      return { ok: reply === "echo:ping", localType: local?.candidateType, remoteType: remote?.candidateType, protocol: local?.relayProtocol ?? local?.protocol, candidateTypes: [...new Set([...types.a, ...types.b])] };
    } catch (error) { return { ok: false, error: String(error.message || error) }; }
    finally { a.close(); b.close(); }
  }, iceServers);
}

/** Two members open the call page, join, and must receive each other's audio and video packets. */
async function peerTest(browser) {
  const peers = [];
  for (const token of [tokenA, tokenB]) {
    const context = await browser.newContext({ baseURL: base, permissions: ["camera", "microphone"], viewport: { width: 1100, height: 760 } });
    await context.addInitScript(({ token, relay }) => {
      localStorage.setItem("origin.sessionToken", token);
      const Native = window.RTCPeerConnection;
      window.__peers = [];
      window.RTCPeerConnection = class extends Native {
        constructor(config = {}) { super(relay ? { ...config, iceTransportPolicy: "relay" } : config); window.__peers.push(this); }
        setConfiguration(config) { return super.setConfiguration(relay ? { ...config, iceTransportPolicy: "relay" } : config); }
      };
    }, { token, relay: relayOnly });
    const page = await context.newPage();
    await page.goto(`/${slug}?view=voice`);
    await page.getByRole("button", { name: /^(Join|Start) call$/ }).click();
    peers.push(page);
  }
  const results = [];
  for (const page of peers) {
    await page.waitForFunction(async () => {
      const peer = window.__peers.find(item => item.connectionState === "connected");
      if (!peer) return false;
      const rows = [...(await peer.getStats()).values()];
      return ["audio", "video"].every(kind => rows.some(row => row.type === "inbound-rtp" && row.kind === kind && row.packetsReceived > 0));
    }, null, { timeout: 40000, polling: 500 });
    results.push(await page.evaluate(async () => {
      const peer = window.__peers.find(item => item.connectionState === "connected");
      const rows = [...(await peer.getStats()).values()];
      const pair = rows.find(row => row.type === "candidate-pair" && row.nominated && row.state === "succeeded");
      const local = pair && rows.find(row => row.id === pair.localCandidateId), remote = pair && rows.find(row => row.id === pair.remoteCandidateId);
      return { connectionState: peer.connectionState, localType: local?.candidateType, remoteType: remote?.candidateType, inbound: rows.filter(row => row.type === "inbound-rtp").map(row => ({ kind: row.kind, packetsReceived: row.packetsReceived })) };
    }));
  }
  for (const page of peers) await page.getByRole("button", { name: /^Leave/ }).click().catch(() => undefined);
  return results;
}

const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
let failed = false;
try {
  const servers = await iceConfig();
  report.iceServers = redact(servers);
  if (servers.some(server => [server.urls].flat().some(url => url.startsWith("turn:")))) {
    report.relay = await relayTest(browser, servers);
    failed ||= !report.relay.ok;
  } else { report.relay = { ok: false, error: "the ICE config has no TURN server" }; failed = true; }
  if (!skipPeers && base && tokenA && tokenB && slug) {
    try { report.peers = { ok: true, relayOnly, results: await peerTest(browser) }; }
    catch (error) { report.peers = { ok: false, relayOnly, error: String(error.message || error).slice(0, 400) }; failed = true; }
  }
} finally { await browser.close(); }
console.log(JSON.stringify(report, null, 2));
process.exitCode = failed ? 1 : 0;
