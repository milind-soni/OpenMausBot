import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import { customMcpServers } from "../config.ts";
import { noteKeyAccepted } from "../key-rejections.ts";
import { McpOAuthManager } from "../mcp-oauth.ts";
import { FAKE_POSTIZ_KEY, startFakePostiz, type FakePostiz } from "../testing/fake-postiz.ts";
import { createPostiz } from "./service.ts";

let fake: FakePostiz;
let dir: string;
let cfg: Pick<AppConfig, "postiz" | "mcpServers">;
let oauth: McpOAuthManager;
let busy = false;
let scope: "team" | "person" = "team";
const forgotten: string[] = [];

beforeAll(async () => {
  fake = await startFakePostiz();
  process.env.OMB_POSTIZ_CLOUD_URL = fake.url;
});
afterAll(async () => {
  delete process.env.OMB_POSTIZ_CLOUD_URL;
  await fake.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-postiz-"));
  cfg = { mcpServers: {} };
  oauth = new McpOAuthManager({ file: join(dir, "mcp-oauth.json") });
  busy = false;
  scope = "team";
  forgotten.length = 0;
});
afterEach(() => {
  oauth.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const postiz = (loopback = true) => createPostiz({
  cfg: () => cfg, mcpOAuth: oauth,
  persistMcpServers: (next) => { cfg = { ...cfg, mcpServers: next }; },
  mcpConfigBusy: { get: () => busy, set: (value) => { busy = value; } },
  mcpPolicyRefusal: (_name, server) => (server as { url: string }).url.includes("blocked.example") ? "Your organization allows only approved MCP servers." : undefined,
  team: { team: null, scopes: { scope: () => scope }, forgetServer: (name) => forgotten.push(name) },
  loopback,
});
/** What config.ts would hold after the route saved this patch. */
const save = async (service: ReturnType<typeof postiz>, patch: { key?: string; url?: string }) => {
  const body = { postiz: { ...patch } };
  const refusal = await service.configCheck(body);
  if (refusal) return refusal;
  cfg = { ...cfg, postiz: { ...cfg.postiz, ...body.postiz } };
  service.configSaved(body);
  return null;
};

describe("the API key", () => {
  it("is checked with initialize and tools/list, nothing saved and no tool run", async () => {
    const service = postiz();
    expect(await service.checkKey(fake.url, FAKE_POSTIZ_KEY)).toEqual({ ok: true, tools: 4 });
    expect(fake.calls).toEqual([]);
    expect(cfg.mcpServers).toEqual({});
    expect(fake.authorizations.at(-1)).toBe(`Bearer ${FAKE_POSTIZ_KEY}`);
  });

  it("says plainly what is wrong with a key or an address", async () => {
    const service = postiz();
    expect(await service.checkKey(fake.url, "not-the-key")).toMatchObject({ ok: false, status: 400, code: "key_rejected", error: expect.stringContaining("didn't accept this API key") });
    expect(await service.checkKey("http://postiz.example.com", FAKE_POSTIZ_KEY)).toMatchObject({ ok: false, code: "address" });
    expect(await service.checkKey("http://127.0.0.1:9", FAKE_POSTIZ_KEY)).toMatchObject({ ok: false, code: "unreachable", error: "Couldn't reach a Postiz server at 127.0.0.1:9. Check the address and try again." });
    expect(await service.checkKey(`${fake.url}/not-postiz`, FAKE_POSTIZ_KEY)).toMatchObject({ ok: false, code: "not_postiz" });
    expect(await service.checkKey("https://blocked.example", FAKE_POSTIZ_KEY)).toMatchObject({ ok: false, status: 403, code: "managed_policy" });
    expect(await postiz(false).checkKey(fake.url, FAKE_POSTIZ_KEY)).toMatchObject({ ok: false, code: "address", error: "Use your Postiz server's https:// address." });
  });

  it("connects Postiz once saved, at that address only, and goes with the key or a changed address", async () => {
    const service = postiz();
    expect(await save(service, { url: fake.url, key: "wrong-key" })).toMatchObject({ code: "key_rejected" });
    expect(cfg.mcpServers).toEqual({});
    expect(await save(service, { url: `${fake.url}/`, key: FAKE_POSTIZ_KEY })).toBeNull();
    // This test's stand-in is Postiz Cloud, which config keeps as no address at all.
    expect(cfg.postiz?.url).toBe("");
    expect(cfg.mcpServers).toEqual({ postiz: { type: "http", url: `${fake.url}/mcp`, headers: {}, enabled: true } });
    expect(service.status()).toMatchObject({ state: "connected", how: "key", host: new URL(fake.url).host, selfHosted: false, keySaved: true });
    // A turn's server carries the key; the stored entry never does.
    expect(customMcpServers({ ...cfg } as AppConfig).postiz).toEqual({ type: "http", url: `${fake.url}/mcp`, headers: { Authorization: `Bearer ${FAKE_POSTIZ_KEY}` } });
    expect(JSON.stringify(cfg.mcpServers)).not.toContain(FAKE_POSTIZ_KEY);

    expect(await save(service, { url: "https://postiz.example.com/api" })).toBeNull();
    expect(cfg.mcpServers).toEqual({});
    expect(customMcpServers({ ...cfg, mcpServers: { postiz: { type: "http", url: `${fake.url}/mcp`, enabled: true } } } as AppConfig).postiz)
      .toEqual({ type: "http", url: `${fake.url}/mcp`, headers: {} });

    expect(await save(service, { url: fake.url, key: FAKE_POSTIZ_KEY })).toBeNull();
    expect(cfg.mcpServers?.postiz).toBeDefined();
    expect(await save(service, { key: "" })).toBeNull();
    expect(cfg.mcpServers).toEqual({});
    expect(service.status()).toMatchObject({ state: "not-connected", how: null, keySaved: false });
  });

  it("shows a revoked key as refused after the next check", async () => {
    const service = postiz();
    expect(await save(service, { url: fake.url, key: FAKE_POSTIZ_KEY })).toBeNull();
    expect((await service.recheck()).tools).toBe(4);
    fake.revoke(FAKE_POSTIZ_KEY);
    try {
      expect((await postiz().recheck()).state).toBe("key-refused");
      // Checked at most every few minutes: the same instance does not ask Postiz again at once.
      const asked = fake.authorizations.length;
      expect((await service.recheck()).state).toBe("key-refused");
      expect(fake.authorizations.length).toBe(asked);
    } finally {
      fake.grant(FAKE_POSTIZ_KEY);
      noteKeyAccepted(`${fake.url}/mcp`, FAKE_POSTIZ_KEY);
    }
  });
});

describe("Postiz Cloud's sign-in", () => {
  it("is set up off, signed in through the MCP sign-in, rechecked, and disconnected", async () => {
    const service = postiz();
    const prepared = service.prepareSignIn();
    expect(prepared).toMatchObject({ ok: true, status: { state: "not-connected", how: "sign-in" } });
    const url = `${fake.url}/mcp-oauth-dynamic`;
    expect(cfg.mcpServers).toEqual({ postiz: { type: "http", url, headers: {}, enabled: false } });

    const started = await oauth.start("postiz", url);
    const authorize = new URL(started.authorizationUrl!);
    expect(authorize.pathname).toBe("/oauth/authorize");
    expect(authorize.searchParams.get("resource")).toBe(url);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const redirect = (await fetch(authorize, { redirect: "manual" })).headers.get("location")!;
    expect(await (await fetch(redirect)).text()).toContain("Signed in");
    expect(oauth.authState("postiz", url)).toBe("signed-in");
    expect(service.status().state).toBe("not-connected");
    cfg = { ...cfg, mcpServers: { postiz: { ...(cfg.mcpServers!.postiz as object), enabled: true } } };
    expect(service.status()).toMatchObject({ state: "connected", how: "sign-in" });
    const token = fake.issued.at(-1)!;
    expect(token).toMatch(/^pos_/u);
    expect(JSON.stringify(service.status())).not.toContain(token);
    // Postiz's tokens never expire and come with no refresh token: the same one is used every turn.
    expect(await oauth.accessToken("postiz", url)).toBe(token);

    expect((await service.recheck()).tools).toBe(4);
    fake.revoke(token);
    expect((await postiz().recheck()).state).toBe("needs-sign-in");

    expect(await service.disconnect()).toMatchObject({ ok: true, status: { state: "not-connected" } });
    expect(cfg.mcpServers).toEqual({});
    expect(oauth.authState("postiz", url)).toBe("none");
    expect(forgotten).toEqual(["postiz"]);
  });

  it("replaces a key connection, and never touches a server named postiz it did not set up", async () => {
    const service = postiz();
    expect(await save(service, { url: fake.url, key: FAKE_POSTIZ_KEY })).toBeNull();
    expect(service.prepareSignIn()).toMatchObject({ ok: true });
    expect(cfg.mcpServers?.postiz).toMatchObject({ url: `${fake.url}/mcp-oauth-dynamic`, enabled: false });

    const mine = { type: "http", url: "https://mcp.postiz.com/mcp/abc123", headers: {}, enabled: true };
    cfg = { ...cfg, mcpServers: { postiz: mine } };
    expect(service.status().state).toBe("taken");
    expect(service.prepareSignIn()).toMatchObject({ ok: false, status: 409, code: "taken" });
    expect(await service.configCheck({ postiz: { key: FAKE_POSTIZ_KEY } })).toMatchObject({ status: 409, code: "taken" });
    expect(await service.disconnect()).toMatchObject({ ok: false, code: "taken" });
    expect(cfg.mcpServers).toEqual({ postiz: mine });
  });

  it("waits for an MCP server edit in flight before writing", async () => {
    const service = postiz();
    busy = true;
    expect(service.prepareSignIn()).toMatchObject({ ok: false, status: 409, code: "busy" });
    const body = { postiz: { key: FAKE_POSTIZ_KEY, url: fake.url } };
    expect(await service.configCheck(body)).toBeNull();
    cfg = { ...cfg, postiz: body.postiz };
    service.configSaved(body);
    expect(cfg.mcpServers).toEqual({});
    busy = false;
    await expect.poll(() => cfg.mcpServers?.postiz).toMatchObject({ url: `${fake.url}/mcp`, enabled: true });
  });

  it("is refused by the organization's policy", () => {
    process.env.OMB_POSTIZ_CLOUD_URL = "https://blocked.example";
    try {
      expect(postiz().status()).toMatchObject({ state: "blocked", message: "Your organization allows only approved MCP servers." });
      expect(postiz().prepareSignIn()).toMatchObject({ ok: false, status: 403, code: "managed_policy" });
    } finally {
      process.env.OMB_POSTIZ_CLOUD_URL = fake.url;
    }
  });
});
