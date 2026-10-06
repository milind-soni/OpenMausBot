import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { InkboxSetup } from "./inkbox-setup.ts";

const identityId = "a1111111-1111-4111-8111-111111111111";
const botId = "b1111111-1111-4111-8111-111111111111";
const handle = "maus-review";
const input = { apiKey: "review-key", botId, ownerPhone: "+15555550199" };
const pairing = { number: "+15555550123", connectText: `connect @${handle}`, smsLink: `sms:+15555550123?&body=connect%20%40${handle}` };
const ready = { ...input, version: 1, enabled: true, pending: false, stage: "ready", identityId, handle, signingSecret: "review-signing", subscriptionId: identityId, pairing };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

function fixture(options: { saved?: unknown; idle?: () => Promise<void> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "inkbox-review-coordinator-"));
  let saved: unknown = structuredClone(options.saved ?? ready);
  let channelCloses = 0;
  const calls: Array<{ path: string; method: string }> = [];
  const tunnel = { id: identityId, agent_identity_id: identityId, tunnel_name: handle, public_host: `${handle}.inkboxwire.com`, status: "active", tls_mode: "edge", zone: "inkboxwire.com" };
  const setup = new InkboxSetup({ directory, port: 18880, botExists: () => true,
    secrets: { available: true, read: async () => saved, write: async value => { saved = structuredClone(value); } },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, method: init?.method ?? "GET" });
      if (path.endsWith("/api-keys/self")) return Response.json({ status: "active", scoped_identity_id: identityId });
      if (path.endsWith(`/identities/${handle}`)) return Response.json({ id: identityId, agent_handle: handle, status: "active", imessage_enabled: true, signing_key_configured: true, tunnel });
      if (path.endsWith(`/tunnels/${identityId}`)) return Response.json({ ...tunnel, currently_connected: false });
      if (path.endsWith("/imessage/triage-number")) return Response.json({ number: pairing.number, connect_command: pairing.connectText });
      throw new Error("Unexpected provider mutation or read");
    },
    makeChannel: () => ({ handle: async () => true, close: () => { channelCloses++; }, idle: options.idle ?? (async () => {}), status: () => ({ configured: true, deliveries: [] }) }),
    tunnel: async () => {
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      return { isConnected: true, wait: () => done, close: async () => finish() };
    },
  });
  cleanup.push(async () => { await setup.close(); rmSync(directory, { recursive: true, force: true }); });
  return { setup, calls, get closes() { return channelCloses; } };
}

it("finishes the prior channel's pending receipt writes before disconnect returns", async () => {
  let finish!: () => void;
  const writing = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture({ idle: () => writing });
  await f.setup.restore();
  let disconnected = false;
  const stopping = f.setup.disconnect().then(() => { disconnected = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(disconnected).toBe(false);
  } finally { finish(); await stopping; }
});

it("resumes a durably saved subscription after a read-only pairing failure", async () => {
  const { pairing: _pairing, ...saved } = ready;
  const f = fixture({ saved: { ...saved, stage: "subscribed" } });
  await f.setup.reconnect();
  expect(f.setup.snapshot().phase).toBe("awaiting_phone");
  expect(f.calls.some(call => call.path.endsWith("/imessage/triage-number"))).toBe(true);
  expect(f.calls.every(call => call.method === "GET")).toBe(true);
});

it("rejects a duplicate setup request without stopping the active connection", async () => {
  const f = fixture();
  await f.setup.restore();
  await expect(f.setup.setup(input)).rejects.toThrow("Disconnect");
  expect(f.closes).toBe(0);
  expect(f.setup.snapshot().phase).toBe("awaiting_phone");
});
