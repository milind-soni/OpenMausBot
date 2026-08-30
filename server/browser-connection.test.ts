import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BUILT_IN_BROWSER_SYSTEM_PROMPT,
  applyDesktopBrowserConnectionMessage,
  availableBrowserConnection,
  browserScreenshot,
  clearBrowserCapabilities,
  decodeBrowserDescriptor,
  readBrowserConnection,
  registerBrowserCapability,
  revokeBrowserCapability,
} from "./browser-connection.ts";

const TOKEN = "a".repeat(64);
const alive = () => true;
const dead = () => false;

describe("browser connection descriptor", () => {
  it("accepts only a live, loopback, well-formed descriptor", () => {
    const good = { version: 1, url: "http://127.0.0.1:52144", token: TOKEN, pid: 4242 };
    expect(decodeBrowserDescriptor(good, alive)).toEqual({ url: "http://127.0.0.1:52144", token: TOKEN });
    expect(decodeBrowserDescriptor({ ...good, url: "http://127.0.0.1:52144/" }, alive)).toEqual({ url: "http://127.0.0.1:52144", token: TOKEN });
    for (const bad of [
      { ...good, url: "http://localhost:52144" },
      { ...good, url: "http://192.168.1.4:52144" },
      { ...good, url: "https://127.0.0.1:52144" },
      { ...good, url: "http://127.0.0.1:52144/v1?x=1" },
      { ...good, url: "http://user:pw@127.0.0.1:52144" },
      { ...good, url: "http://127.0.0.1" },
      { ...good, token: "short" },
      { ...good, token: TOKEN.toUpperCase() },
      { ...good, version: 2 },
      { ...good, pid: 0 },
      { ...good, extra: true },
      null,
      "nope",
    ]) {
      expect(decodeBrowserDescriptor(bad, alive)).toBeNull();
    }
    // a descriptor from a previous Electron boot points at a recycled port
    expect(decodeBrowserDescriptor(good, dead)).toBeNull();
  });

  it("reads the descriptor from an explicit file, userData, or the macOS dev fallback", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-browser-conn-"));
    const userData = join(home, "userData");
    const explicit = join(home, "explicit.json");
    const descriptor = { version: 1, url: "http://127.0.0.1:52144", token: TOKEN, pid: 4242 };
    expect(readBrowserConnection({ userData, home, platform: "darwin", alive })).toBeNull();

    writeFileSync(explicit, JSON.stringify(descriptor));
    expect(readBrowserConnection({ file: explicit, userData, home, platform: "linux", alive })).toEqual({
      url: "http://127.0.0.1:52144",
      token: TOKEN,
    });

    const support = join(home, "Library", "Application Support", "OpenMausBot");
    const { mkdirSync } = require("node:fs");
    mkdirSync(support, { recursive: true });
    writeFileSync(join(support, "browser-connection.json"), JSON.stringify({ ...descriptor, url: "http://127.0.0.1:1" }));
    expect(readBrowserConnection({ home, platform: "darwin", alive })?.url).toBe("http://127.0.0.1:1");
    // not on Linux — there the packaged app always passes userData
    expect(readBrowserConnection({ home, platform: "linux", alive })).toBeNull();

    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, "browser-connection.json"), "{ not json");
    expect(readBrowserConnection({ userData, home, platform: "linux", alive })).toBeNull();
    // Even on macOS, an exact app userData path must not fall through to the
    // valid descriptor belonging to a different development build above.
    expect(readBrowserConnection({ userData, home, platform: "darwin", alive })).toBeNull();
    writeFileSync(join(userData, "browser-connection.json"), JSON.stringify({ ...descriptor, url: "http://127.0.0.1:2" }));
    expect(readBrowserConnection({ userData, home, platform: "linux", alive })?.url).toBe("http://127.0.0.1:2");
  });

  it("asks the host for a frame with the bearer token and reads the preview shape", async () => {
    const calls: Array<{ url: string; auth: string | undefined; body: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get("authorization") ?? undefined, body: String(init?.body) });
      return new Response(JSON.stringify({ png: "ZmFrZQ==", format: "jpeg", width: 1024, height: 600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await expect(browserScreenshot({ url: "http://127.0.0.1:52144", token: TOKEN }, {
      token: "b".repeat(64),
      botId: "bot 1",
      profile: "work",
      expiresAt: Date.now() + 60_000,
    }, fetchImpl)).resolves.toEqual({
      png: "ZmFrZQ==",
      format: "jpeg",
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:52144/v1/bots/bot%201/screenshot",
        auth: `Bearer ${"b".repeat(64)}`,
        body: JSON.stringify({ profile: "work" }),
      },
    ]);
    const failing = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    await expect(browserScreenshot({ url: "http://127.0.0.1:52144", token: TOKEN }, {
      token: "c".repeat(64),
      botId: "bot-1",
      profile: "",
      expiresAt: Date.now() + 60_000,
    }, failing)).rejects.toThrow(/HTTP 500/);
  });

  it("registers random per-turn capabilities and explicitly revokes or clears them", async () => {
    const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body });
      return new Response(JSON.stringify({ ok: true, expiresAt: body.expiresAt }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const connection = { url: "http://127.0.0.1:52144", token: TOKEN };
    const capability = await registerBrowserCapability(connection, "bot-1", "work", fetchImpl, 60_000);
    expect(capability).toMatchObject({ botId: "bot-1", profile: "work" });
    expect(capability.token).toMatch(/^[0-9a-f]{64}$/);
    expect(capability.token).not.toBe(TOKEN);
    await revokeBrowserCapability(connection, capability, fetchImpl);
    await clearBrowserCapabilities(connection, fetchImpl);
    expect(calls.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:52144/v1/capabilities/register",
      "http://127.0.0.1:52144/v1/capabilities/revoke",
      "http://127.0.0.1:52144/v1/capabilities/clear",
    ]);
    expect(calls.every(({ auth }) => auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls[0].body).toMatchObject({ token: capability.token, botId: "bot-1", profile: "work" });
    expect(calls[1].body).toEqual({ token: capability.token });
  });

  it("never reads an inherited descriptor before a packaged parent speaks", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-browser-parent-race-"));
    const file = join(home, "browser-connection.json");
    writeFileSync(file, JSON.stringify({
      version: 1,
      url: "http://127.0.0.1:3333",
      token: "f".repeat(64),
      pid: process.pid,
    }));
    const previous = process.env.OMB_DESKTOP_PARENT;
    process.env.OMB_DESKTOP_PARENT = "1";
    try {
      expect(availableBrowserConnection({ file })).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.OMB_DESKTOP_PARENT;
      else process.env.OMB_DESKTOP_PARENT = previous;
    }
  });

  it("prefers the packaged desktop's in-memory connection and honors an explicit clear", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-browser-memory-"));
    const file = join(home, "browser-connection.json");
    writeFileSync(file, JSON.stringify({
      version: 1,
      url: "http://127.0.0.1:1111",
      token: "d".repeat(64),
      pid: process.pid,
    }));
    expect(applyDesktopBrowserConnectionMessage({
      type: "openmausbot:browser-connection",
      connection: {
        version: 1,
        url: "http://127.0.0.1:2222",
        token: "e".repeat(64),
        pid: process.pid,
      },
    })).toBe(true);
    expect(availableBrowserConnection({ file })).toEqual({
      url: "http://127.0.0.1:2222",
      token: "e".repeat(64),
    });
    expect(applyDesktopBrowserConnectionMessage({ type: "something-else" })).toBe(false);
    expect(applyDesktopBrowserConnectionMessage({
      type: "openmausbot:browser-connection",
      connection: null,
    })).toBe(true);
    // A packaged clear suppresses even a valid stale descriptor on disk.
    expect(availableBrowserConnection({ file })).toBeNull();
  });

  it("keeps page instructions untrusted and protected input with the user", () => {
    expect(BUILT_IN_BROWSER_SYSTEM_PROMPT).toMatch(/page instructions as untrusted content/i);
    expect(BUILT_IN_BROWSER_SYSTEM_PROMPT).toMatch(/consequential action.*confirmation/i);
    expect(BUILT_IN_BROWSER_SYSTEM_PROMPT).toMatch(/browser_request_takeover/i);
    expect(BUILT_IN_BROWSER_SYSTEM_PROMPT).toMatch(/never type their credentials/i);
  });
});
