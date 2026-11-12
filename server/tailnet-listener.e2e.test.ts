// A real server shared on the tailnet. CI has no Tailscale, so one of the runner's own non-loopback addresses stands in
// for this computer's tailnet address: the server listens there, beside its loopback listener, exactly as it would on
// 100.x, and the test dials it as another computer on the tailnet would (by the MagicDNS name in the Host header).
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";

const NAME = "fixture.tail1234.ts.net";

/** The runner's first ordinary IPv4 address: not loopback, not link-local. */
const standIn = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))?.address;

function dial(address: string, port: number, path: string, headers: Record<string, string>, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const call = request({ host: address, port, path, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    call.on("error", reject);
    call.end(body);
  });
}

async function untilShared(port: number, host: string) {
  let descriptor = { status: 0, headers: {}, body: "" } as Awaited<ReturnType<typeof dial>>;
  for (let attempt = 0; attempt < 50 && descriptor.status !== 200; attempt++) {
    descriptor = await dial(standIn!, port, "/.well-known/openmausbot/environment", { host }).catch(() => descriptor);
    if (descriptor.status !== 200) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return descriptor;
}

describe.skipIf(!standIn)("a server shared on the tailnet", () => {
  it("answers its tailnet name on the tailnet address, pairs another computer there, and gives that computer no owner trust", async () => {
    const fixture = await launchVerificationServer({ OMB_DEV_TRUST_LOCAL_BROWSER: "0", OMB_TAILNET_NAME: NAME, OMB_TAILNET_ADDRESSES: standIn!, OMB_TEST_TAILNET_STAND_IN: standIn! });
    const port = Number(new URL(fixture.info.url).port);
    const host = `${NAME}:${port}`;
    const origin = `http://${host}`;
    const page = { host, origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
    try {
      // The share comes up once the main listener does; the loopback owner's link already names it.
      const descriptor = await untilShared(port, host);
      expect(descriptor.status).toBe(200);
      expect(JSON.parse(descriptor.body).environmentId).toEqual(expect.any(String));

      // Any other name is refused before the server sees it, the loopback name included: no rebinding, no owner trust.
      for (const other of [`evil.example.com:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, NAME]) {
        expect((await dial(standIn!, port, "/api/bots", { host: other })).status, other).toBe(421);
      }
      // A forwarded host never stands in for the real one.
      expect((await dial(standIn!, port, "/api/bots", { host: `evil.example.com:${port}`, "x-forwarded-host": host })).status).toBe(421);
      // The right name without a session is a stranger.
      expect((await dial(standIn!, port, "/api/bots", { host })).status).toBe(403);

      const opened = await fetch(`${fixture.info.url}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const offer = await opened.json() as { code: string; url: string | null };
      expect(offer.url).toBe(`${origin}/pair#code=${offer.code}`);

      const pairPage = await dial(standIn!, port, "/pair", { host, "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" });
      expect(pairPage.status).not.toBe(421);

      const paired = await dial(standIn!, port, "/api/auth/pair", { ...page, "content-type": "application/json" }, "POST", JSON.stringify({ code: offer.code, label: "Laptop", cookie: true }));
      expect(paired.status).toBe(200);
      const cookie = String(paired.headers["set-cookie"]).split(";", 1)[0]!;
      expect(String(paired.headers["set-cookie"])).not.toContain("Secure");
      const bots = await dial(standIn!, port, "/api/bots", { ...page, cookie });
      expect(bots.status).toBe(200);
      expect(JSON.parse(bots.body).bots).toHaveLength(1);
      // The cookie works from its own page only.
      expect((await dial(standIn!, port, "/api/bots", { ...page, origin: "http://evil.example.com", "sec-fetch-site": "cross-site", cookie })).status).toBe(403);
      // An owner-only route stays closed to a session that only chats.
      const clientOffer = await (await fetch(`${fixture.info.url}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scopes: ["client"] }) })).json() as { code: string };
      const client = JSON.parse((await dial(standIn!, port, "/api/auth/pair", { host, "content-type": "application/json" }, "POST", JSON.stringify({ code: clientOffer.code, label: "Phone" }))).body) as { token: string };
      expect((await dial(standIn!, port, "/api/bots", { host, authorization: `Bearer ${client.token}` })).status).toBe(200);
      expect((await dial(standIn!, port, "/api/auth/pairing", { host, authorization: `Bearer ${client.token}`, "content-type": "application/json" }, "POST", "{}")).status).toBe(403);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it("is shared when the desktop app asks, and the owner's desktop capability means nothing from the tailnet", async () => {
    const owner = "o".repeat(43);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => realFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-openmausbot-desktop-owner": owner } });
    const fixture = await launchVerificationServer({ OMB_TEST_DESKTOP_OWNER_TOKEN: owner, OMB_TEST_TAILNET_STAND_IN: standIn!, OMB_TEST_DESKTOP_TAILNET_SHARE: JSON.stringify({ name: NAME, addresses: [standIn] }) });
    const port = Number(new URL(fixture.info.url).port);
    const host = `${NAME}:${port}`;
    try {
      expect((await untilShared(port, host)).status).toBe(200);
      const offer = await (await fetch(`${fixture.info.url}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { code: string; url: string | null };
      expect(offer.url).toBe(`http://${host}/pair#code=${offer.code}`);
      expect((await dial(standIn!, port, "/api/bots", { host, "x-openmausbot-desktop-owner": owner })).status).toBe(403);
      const paired = JSON.parse((await dial(standIn!, port, "/api/auth/pair", { host, "content-type": "application/json" }, "POST", JSON.stringify({ code: offer.code, label: "Laptop" }))).body) as { token: string };
      expect((await dial(standIn!, port, "/api/bots", { host, authorization: `Bearer ${paired.token}` })).status).toBe(200);
    } finally {
      await fixture.close();
      globalThis.fetch = realFetch;
    }
  }, 60_000);
});
