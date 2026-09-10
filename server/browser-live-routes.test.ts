import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";

let fixture: VerificationServer;
let botId: string;
let clientToken: string;
let ownerCookie: string;
const remote = { "x-forwarded-for": "198.51.100.18", "x-forwarded-proto": "https" };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() as any, headers: response.headers };
}

beforeAll(async () => {
  fixture = await launchVerificationServer();
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  expect((await runControlOmb(["doctor"], { env }) as any).ok).toBe(true);
  const created = await runControlOmb(["new-bot", "--name", "Browser profile fixture"], { env }) as any;
  botId = created.bot.id;

  const clientPairing = await call("POST", "/api/auth/pairing", { scopes: ["client"] });
  expect(clientPairing.status).toBe(200);
  const client = await call("POST", "/api/auth/pair", { code: clientPairing.body.code, label: "Browser client fixture" }, remote);
  expect(client.status).toBe(200);
  clientToken = client.body.token;

  const ownerPairing = await call("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  const owner = await call("POST", "/api/auth/pair", { code: ownerPairing.body.code, label: "Browser owner fixture", cookie: true }, remote);
  expect(owner.status).toBe(200);
  ownerCookie = owner.headers.get("set-cookie")!.split(";")[0]!;
}, 30_000);

afterAll(async () => { await fixture?.close(); });

describe("live browser route authorization", () => {
  it.each([["GET", "live"], ["POST", "action"]])("keeps %s %s owner-only", async (method, suffix) => {
    const path = `/api/bots/${botId}/browser/${suffix}`;
    const body = method === "POST" ? { viewerId: "forged", type: "take" } : undefined;
    expect((await call(method, path, body, remote)).status).toBe(403);
    const denied = await call(method, path, body, { ...remote, authorization: `Bearer ${clientToken}` });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain("admin");
    const crossOrigin = await call(method, path, body, { ...remote, cookie: ownerCookie, origin: "https://attacker.invalid" });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body.error).toContain("cross-origin");
    // Authenticated owner reaches the feature gate; no native browser is
    // installed or launched in this fixture.
    const owner = await call(method, path, body, { ...remote, cookie: ownerCookie });
    expect(owner.status).toBe(409);
    expect(owner.body.error).toContain("Enable this bot's browser");
  });

  it("does not let client sessions change the bot's browser identity or shared logins", async () => {
    const headers = { ...remote, authorization: `Bearer ${clientToken}` };
    expect((await call("PATCH", `/api/bots/${botId}`, { browserProfile: "guest" }, headers)).status).toBe(403);
    expect((await call("PATCH", "/api/config", { browserProfiles: [], expectedBrowserProfiles: [] }, headers)).status).toBe(403);
  });
});

describe("profile list compare-and-swap", () => {
  it("rejects stale deletion without losing profiles, assignments, or a later rename", async () => {
    const original = [{ id: "work", name: "Work" }, { id: "personal", name: "Personal" }];
    const created = await call("PATCH", "/api/config", { browserProfiles: original, expectedBrowserProfiles: [] });
    expect(created.status).toBe(200);
    expect(created.body.browserProfiles).toEqual(original);
    expect((await call("PATCH", `/api/bots/${botId}`, { browserProfile: "work" })).status).toBe(200);

    const renamed = [{ id: "work", name: "Renamed work" }, original[1]];
    const saved = await call("PATCH", "/api/config", { browserProfiles: renamed, expectedBrowserProfiles: original });
    expect(saved.status).toBe(200);
    const stale = await call("PATCH", "/api/config", { browserProfiles: [], expectedBrowserProfiles: original });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toContain("another window");
    expect((await call("GET", "/api/config")).body.browserProfiles).toEqual(renamed);
    const currentBot = (await call("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === botId);
    expect(currentBot.browserProfile).toBe("work");

    // A reviewed, current deletion clears assignments on the server, not by
    // optimistic renderer edits. The fixture has no engine or saved logins.
    const removed = await call("PATCH", "/api/config", { browserProfiles: [original[1]], expectedBrowserProfiles: renamed });
    expect(removed.status).toBe(200);
    expect(removed.body.browserProfiles).toEqual([original[1]]);
    const afterRemoval = (await call("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === botId);
    expect(afterRemoval.browserProfile).toBeUndefined();
  });
});
