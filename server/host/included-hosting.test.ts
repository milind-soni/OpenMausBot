import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hostingCredential } from "../included-services.ts";
import { startFakeAppHosting, type FakeAppHosting } from "../testing/fake-app-hosting.ts";
import { createIncludedHosting, HostingRefusal, hostingRefusal } from "./included-hosting.ts";

const TOKEN = "omb_host_client_test_token_0123456789abcdef";
let dataDir = "", fake: FakeAppHosting;

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "included-hosting-client-")));
  fake = await startFakeAppHosting(TOKEN);
});
afterEach(async () => { await fake.stop(); rmSync(dataDir, { recursive: true, force: true }); });

const answering = (body: unknown, seen: Array<{ url: string; init: RequestInit | undefined }> = []) => (async (url: string | URL | Request, init?: RequestInit) => {
  seen.push({ url: String(url), init });
  return Response.json(body);
}) as typeof fetch;
const hosting = (fetcher?: typeof fetch, api = fake.url) => createIncludedHosting({ credential: () => ({ token: TOKEN, api, included: true }), dataDir, ...(fetcher ? { fetch: fetcher } : {}) });

describe("the home's included hosting credential", () => {
  it("is held only with both the relay's address and the token, over https or loopback", () => {
    const url = "https://cloud.example.test/api/cloud/services/hosting/v1";
    expect(hostingCredential({ OMB_CLOUD_HOSTING_URL: `${url}/`, OMB_CLOUD_HOSTING_TOKEN: TOKEN })).toEqual({ token: TOKEN, api: url, included: true });
    expect(hostingCredential({ OMB_CLOUD_HOSTING_URL: "http://127.0.0.1:4100/api/cloud/services/hosting/v1", OMB_CLOUD_HOSTING_TOKEN: TOKEN })?.api).toBe("http://127.0.0.1:4100/api/cloud/services/hosting/v1");
    for (const env of [{}, { OMB_CLOUD_HOSTING_URL: url }, { OMB_CLOUD_HOSTING_TOKEN: TOKEN }, { OMB_CLOUD_HOSTING_URL: "http://cloud.example.test/v1", OMB_CLOUD_HOSTING_TOKEN: TOKEN },
      { OMB_CLOUD_HOSTING_URL: "https://user:pass@cloud.example.test/v1", OMB_CLOUD_HOSTING_TOKEN: TOKEN }, { OMB_CLOUD_HOSTING_URL: "https://cloud.example.test/v1?to=elsewhere", OMB_CLOUD_HOSTING_TOKEN: TOKEN },
      { OMB_CLOUD_HOSTING_URL: "not a url", OMB_CLOUD_HOSTING_TOKEN: TOKEN }]) {
      expect(hostingCredential(env), JSON.stringify(env)).toBeNull();
    }
  });
});

describe("the included hosting client", () => {
  it("reads the list and the allowance, sending the token as a bearer to the relay", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const listing = await hosting(answering({
      apps: [{ key: "portfolio", title: "Portfolio", url: "https://mb-3f9c2a17d04e8b65.netlify.app", state: "ready", visibility: "private",
        createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:02:10.000Z", publishedAt: "2026-11-11T10:02:10.000Z" }],
      allowance: { apps: { used: 3, max: 10 }, publishes: { used: 12, max: 200, resetsAt: "2026-12-01T00:00:00.000Z" }, limits: { maxBytes: 26214400, maxFileBytes: 8388608, maxFiles: 500 } },
    }, seen)).list();
    expect(listing).toEqual({
      apps: [{ key: "portfolio", title: "Portfolio", url: "https://mb-3f9c2a17d04e8b65.netlify.app/", state: "ready", visibility: "private",
        createdAt: Date.parse("2026-11-11T10:00:00.000Z"), publishedAt: Date.parse("2026-11-11T10:02:10.000Z") }],
      allowance: { apps: { used: 3, max: 10 }, publishes: { used: 12, max: 200, resetsAt: Date.parse("2026-12-01T00:00:00.000Z") }, limits: { maxBytes: 26214400, maxFileBytes: 8388608, maxFiles: 500 } },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${fake.url}/apps`);
    expect(new Headers(seen[0]!.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.init?.redirect).toBe("error");
  });

  it("takes an app with no visibility, an unknown state or missing times, and drops what is not an app", async () => {
    const { apps, allowance } = await hosting(answering({
      apps: [{ key: "shop", title: "Shop\nfront", url: "https://mb-aa.netlify.app", state: "ready", publishedAt: "2026-11-11T10:02:10.000Z" }, { key: "new", state: "brand_new_state" },
        { key: "odd", url: "javascript:alert(1)", state: "ready" }, { key: "plain", url: "http://mb-bb.netlify.app", state: "ready" }, { key: "auth", url: "https://a:b@mb-cc.netlify.app", state: "ready" },
        { title: "no key" }, "text", null, { key: "../escape" }],
    })).list();
    expect(apps).toEqual([
      { key: "shop", title: "Shop front", url: "https://mb-aa.netlify.app/", state: "ready", createdAt: null, publishedAt: Date.parse("2026-11-11T10:02:10.000Z") },
      { key: "new", title: "", url: null, state: "processing", createdAt: null, publishedAt: null },
      { key: "odd", title: "", url: null, state: "ready", createdAt: null, publishedAt: null },
      { key: "plain", title: "", url: null, state: "ready", createdAt: null, publishedAt: null },
      { key: "auth", title: "", url: null, state: "ready", createdAt: null, publishedAt: null },
    ]);
    expect(allowance).toEqual({ apps: { used: 0, max: 0 }, publishes: { used: 0, max: 0, resetsAt: null }, limits: { maxBytes: 25 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024, maxFiles: 500 } });
  });

  it("takes a loopback address for an app only when the relay itself is that stand-in", async () => {
    const live = `${fake.origin}/live/mb-1/`;
    expect((await hosting(answering({ apps: [{ key: "a", url: live }] })).list()).apps[0]!.url).toBe(live);
    expect((await hosting(answering({ apps: [{ key: "a", url: live }] }), "https://cloud.example.test/api/cloud/services/hosting/v1").list()).apps[0]!.url).toBeNull();
    expect((await hosting(answering({ apps: [{ key: "a", url: "http://127.0.0.1:1/live/mb-1/" }] })).list()).apps[0]!.url).toBeNull();
  });

  it("names an app by its bot and project folder: stable, and different for another bot or folder", async () => {
    const made = hosting();
    mkdirSync(join(dataDir, "workspaces", "mira", "bakery"), { recursive: true });
    mkdirSync(join(dataDir, "workspaces", "mira", "rota"), { recursive: true });
    mkdirSync(join(dataDir, "workspaces", "otto", "bakery"), { recursive: true });
    symlinkSync(join(dataDir, "workspaces", "mira", "bakery"), join(dataDir, "workspaces", "mira", "alias"), process.platform === "win32" ? "junction" : "dir");
    const key = await made.keyFor("mira", join(dataDir, "workspaces", "mira", "bakery"));
    expect(key).toMatch(/^app-[0-9a-f]{32}$/);
    expect(await made.keyFor("mira", join(dataDir, "workspaces", "mira", "bakery", "."))).toBe(key);
    expect(await made.keyFor("mira", join(dataDir, "workspaces", "mira", "alias"))).toBe(key);
    const others = [await made.keyFor("mira", join(dataDir, "workspaces", "mira", "rota")), await made.keyFor("otto", join(dataDir, "workspaces", "otto", "bakery")),
      await made.keyFor("otto", join(dataDir, "workspaces", "mira", "bakery"))];
    expect(new Set([key, ...others]).size).toBe(4);
    await expect(made.keyFor("mira", join(dataDir, "nowhere"))).rejects.toThrow();
  });

  it("never puts the token in a refusal, whatever the relay or the network did", async () => {
    const echo = (async () => Response.json({ error: "brand_new", message: `the token was ${TOKEN}`, token: TOKEN }, { status: 400 })) as unknown as typeof fetch;
    const failing = (async () => { throw new Error(`connect failed with ${TOKEN}`); }) as unknown as typeof fetch;
    for (const fetcher of [echo, failing]) {
      const refusal = await hosting(fetcher).list().catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(HostingRefusal);
      expect(JSON.stringify([refusal, (refusal as Error).message, (refusal as Error).stack])).not.toContain(TOKEN);
    }
    expect(hostingRefusal(0, {}).code).toBe("unavailable");
  });

  it("counts an app the relay no longer has as deleted, and reports any other failure", async () => {
    await expect(hosting().remove("app-gone")).resolves.toBeUndefined();
    fake.failNext(502, { error: "upstream_error" });
    await expect(hosting().remove("app-gone")).rejects.toMatchObject({ code: "unavailable" });
    await expect(hosting().makePublic("app-gone")).resolves.toBeNull();
  });
});
