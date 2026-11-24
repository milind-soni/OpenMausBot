// The standalone companion (`pnpm companion` beside a headless server) forwards a phone as plain loopback carrying only
// its mark: the harness still lets that phone change nothing but keys, and test nothing but the key it pasted.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";

const PHONE = { "x-openmausbot-companion": "1", "x-openmausbot-companion-device": "phone-1" };

async function provider() {
  const heard: string[] = [];
  const server = createServer((req, res) => {
    heard.push(String(req.headers.authorization ?? ""));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { heard, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

it("a phone through the standalone companion changes only keys, keeps them in config.json, and tests only the key it pasted", async () => {
  const saved = await provider();
  const elsewhere = await provider();
  const fixture = await launchVerificationServer();
  const send = async (method: string, path: string, body: unknown, headers: Record<string, string> = PHONE) =>
    (await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })).status;
  const disk = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
  try {
    expect(await send("PUT", "/api/config", { signIn: { admins: ["x@y.z"] } })).toBe(403);
    expect(disk().signIn?.admins ?? []).toEqual([]);
    // That query says the desktop already put the key in its encrypted store; a phone's key is in no such store.
    expect(await send("PUT", "/api/config?secretStorage=external", { mistral: { key: "phone-key" } })).toBe(200);
    expect(disk().mistral.key).toBe("phone-key");

    expect(await send("PUT", "/api/config", { openaiCompat: { url: saved.url, key: "saved-key" } }, {})).toBe(200);
    expect(await send("POST", "/api/keys/test", { provider: "openaiCompat", url: elsewhere.url })).toBe(400);
    expect(await send("POST", "/api/keys/test", { provider: "openaiCompat", key: "pasted-key", url: elsewhere.url })).toBe(200);
    expect(elsewhere.heard).toEqual([]);
    // The server's own model discovery calls the saved address too, so this hears more than the test.
    expect(saved.heard).toContain("Bearer pasted-key");

    // The computer itself still tests its saved key against an address it names.
    expect(await send("POST", "/api/keys/test", { provider: "openaiCompat", url: elsewhere.url }, {})).toBe(200);
    expect(elsewhere.heard).toEqual(["Bearer saved-key"]);
  } finally {
    await fixture.close();
    saved.server.close();
    elsewhere.server.close();
  }
}, 120_000);
