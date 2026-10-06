import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { InkboxSetup } from "./inkbox-setup.ts";
import { createInkboxSetupRoutes } from "./routes/inkbox-setup.ts";
import { dispatchRoutes } from "./routes/table.ts";
import { json, readBody } from "./harness/http.ts";
import { resolveRequestAuth } from "./request-auth.ts";
import { SessionRegistry } from "./sessions.ts";

it("loads secure routing before ingress and starts provider restore only after the production API listens", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const prepare = source.indexOf("await inkboxSetup.prepareRestore()");
  const ingress = source.indexOf("webhookIngress = await listenWebhookIngress");
  const listen = source.indexOf('server.listen(PORT, "127.0.0.1",');
  const restore = source.indexOf("void inkboxSetup.restore()");
  expect(prepare).toBeGreaterThan(0);
  expect(listen).toBeGreaterThan(ingress);
  expect(prepare).toBeLessThan(ingress);
  expect(restore).toBeGreaterThan(listen);
  expect(source).not.toContain("await inkboxSetup.restore()");
});

it("serves settings and disconnects a stalled provider restore without opening a tunnel or falling back to legacy ingress", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-inkbox-slow-startup-"));
  const sessions = new SessionRegistry({ file: join(directory, "sessions.json") });
  const identityId = "a1111111-1111-4111-8111-111111111111";
  const botId = "b1111111-1111-4111-8111-111111111111";
  let saved = { apiKey: "fixture-startup-key", version: 1, enabled: true, pending: false, stage: "ready", identityId, botId,
    ownerPhone: "+14155550199", handle: "maus-startup", signingSecret: "fixture-startup-signing", broadEvents: true,
    pairing: { number: "+15555550123", connectText: "connect @maus-startup", smsLink: "sms:+15555550123" } };
  let providerStarted!: () => void;
  const started = new Promise<void>(resolve => { providerStarted = resolve; });
  let calls = 0;
  let aborted = false;
  let legacyCalls = 0;
  let restore: Promise<void> | undefined;
  const setup = new InkboxSetup({ directory, port: 18880, botExists: id => id === botId,
    secrets: { available: true, read: async () => structuredClone(saved), write: async doc => { saved = structuredClone(doc) as typeof saved; } },
    // Deliberately never finishes on its own: the UI must remain usable even
    // when provider startup outlasts every desktop boot deadline.
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://inkbox.ai/api/v1/api-keys/self");
      calls++; providerStarted();
      return new Promise<Response>((_resolve, reject) => {
        const cancel = () => { aborted = true; reject(new Error("Fixture provider aborted")); };
        if (init?.signal?.aborted) cancel(); else init?.signal?.addEventListener("abort", cancel, { once: true });
      });
    },
    makeChannel: () => { throw new Error("Stalled discovery must not create a channel"); },
    tunnel: async () => { throw new Error("Stalled discovery must not open a tunnel"); },
  });
  const route = createInkboxSetupRoutes({ setup });
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === "/inkbox") {
        if (setup.hasConfiguration) { await setup.handle(req, res); return; }
        legacyCalls++; return json(res, 200, { legacy: true });
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const gate = resolveRequestAuth(req, { sessions, cookieName: "fixture_session", streamPath: "/events", url,
        loopbackMutationToken: "fixture-startup-desktop" });
      if (!gate.auth) return json(res, gate.status, { error: gate.error });
      if (!await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: gate.auth, json, readBody })) json(res, 404, {});
    })().catch(() => json(res, 500, { error: "Fixture failed" }));
  });
  try {
    await setup.prepareRestore();
    expect(setup.hasConfiguration).toBe(true);
    expect(calls).toBe(0);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => { restore = setup.restore(); resolve(); }));
    await started;
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const request = (path: string, method = "GET") => fetch(`${base}${path}`, { method,
      headers: { "x-openmausbot-desktop-owner": "fixture-startup-desktop" }, signal: AbortSignal.timeout(2_000) });
    const status = await request("/api/inkbox/setup");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ phase: "connecting", botId, canReconnect: false });
    const conflicting = await request("/api/inkbox/setup/reconnect", "POST");
    expect(conflicting.status).toBe(409); await conflicting.body?.cancel();
    const inbound = await request("/inkbox", "POST");
    expect(inbound.status).toBe(503); await inbound.body?.cancel();
    const stopped = await request("/api/inkbox/setup/disconnect", "POST");
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ phase: "disconnected" });
    await restore;
    expect(saved.enabled).toBe(false);
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
    expect(legacyCalls).toBe(0);
  } finally {
    await setup.close(); await restore;
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    sessions.close(); rmSync(directory, { recursive: true, force: true });
  }
});
