import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "./i18n";
import { nativeArtifactAvailable, requestNativeArtifact } from "./native-artifact";

type Facts = NonNullable<Parameters<typeof nativeArtifactAvailable>[0]>;
type Config = NonNullable<Facts["config"]>;

const config = (over: Partial<Config> = {}): Config => ({
  composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" }, rooms: { turnTimeoutMinutes: 20 },
  localVm: { mode: "shared", maxInstances: 1 },
  features: { skillAuthoring: false, browser: true }, browserEngine: { kind: "engine", engine: "native" },
  ...over,
});
const facts = (over: Partial<Facts> = {}): Facts => ({ selectedId: "pepper", bots: [{ id: "pepper" }], config: config(), ...over });
const capable = { nativeBrowser: { available: true } };

beforeEach(() => setLocale("en"));
afterEach(() => vi.unstubAllGlobals());

describe("native artifact availability", () => {
  it("offers the native action for the selected bot's own, shared and guest built-in profiles", () => {
    expect(nativeArtifactAvailable(facts(), capable)).toBe(true);
    expect(nativeArtifactAvailable(facts({
      bots: [{ id: "pepper", browserProfile: "shared" }],
      config: config({ browserProfiles: [{ id: "shared", name: "Work" }, { id: "my-chrome", name: "My Chrome", browser: "chrome" }] }),
    }), capable)).toBe(true);
    expect(nativeArtifactAvailable(facts({ bots: [{ id: "pepper", browserProfile: "guest" }] }), capable)).toBe(true);
  });

  it("requires an explicit native desktop capability, independent of a bridge or platform", () => {
    vi.stubGlobal("window", { ogb: { platform: "win32", nativeBrowser: {} } });
    expect(nativeArtifactAvailable(facts(), {})).toBe(false);
    expect(nativeArtifactAvailable(facts(), { nativeBrowser: { available: false } })).toBe(false);
  });

  it.each([
    ["no state", null],
    ["no config", facts({ config: null })],
    ["no selected bot", facts({ selectedId: undefined })],
    ["a different selection", facts({ selectedId: "another-chat" })],
    ["browser disabled for the bot", facts({ bots: [{ id: "pepper", browser: false }] })],
    ["computer access off", facts({ bots: [{ id: "pepper", computer: "off" }] })],
    ["browser feature off", facts({ config: config({ features: { skillAuthoring: false, browser: false } }) })],
    ["browser feature absent", facts({ config: config({ features: undefined }) })],
    ["legacy engine", facts({ config: config({ browserEngine: { kind: "engine", engine: "agent-browser" } }) })],
    ["image-stream engine", facts({ config: config({ browserEngine: { kind: "engine", engine: "chrome" } }) })],
    ["unavailable browser", facts({ config: config({ browserEngine: { kind: "unavailable", engine: "native" } }) })],
    ["installing browser", facts({ config: config({ browserEngine: { kind: "engine", engine: "native", installing: true } }) })],
    ["failed browser setup", facts({ config: config({ browserEngine: { kind: "engine", engine: "native", installError: "Unavailable" } }) })],
  ] satisfies Array<[string, Facts | null]>)("leaves the existing file action in place for %s", (_name, state) => {
    expect(nativeArtifactAvailable(state, capable)).toBe(false);
  });

  it("keeps My Chrome on the existing file-opening path while the built-in shared profile remains native", () => {
    const state = facts({
      bots: [{ id: "pepper", browserProfile: "personal-chrome" }, { id: "salt", browserProfile: "built-in" }],
      config: config({ browserProfiles: [{ id: "personal-chrome", name: "Personal", browser: "chrome" }, { id: "built-in", name: "Work" }] }),
    });
    expect(nativeArtifactAvailable(state, capable)).toBe(false);
    expect(nativeArtifactAvailable({ ...state, selectedId: "salt" }, capable)).toBe(true);
  });
});

describe("the native artifact request", () => {
  const message = { threadId: "team/alpha?x=1#part", messageId: "reply %2F/42" };
  const filePath = "D:\\fixture output\\index #1.html";
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("encodes each message path segment, preserves the file path and forwards the cancellation signal", async () => {
    const fetch = vi.fn(async () => response({ nativeBrowserOpened: true, botId: "pepper" }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await expect(requestNativeArtifact(filePath, message, controller.signal)).resolves.toBe("pepper");
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/threads/team%2Falpha%3Fx%3D1%23part/messages/reply%20%252F%2F42/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"path":"D:\\\\fixture output\\\\index #1.html","openNativeBrowser":true}',
      signal: controller.signal,
    });
  });

  it("surfaces the server's refusal and never retries a file-opening write", async () => {
    const fetch = vi.fn(async () => response({ error: "This file belongs to another message." }, 403));
    vi.stubGlobal("fetch", fetch);
    await expect(requestNativeArtifact(filePath, message)).rejects.toThrow("This file belongs to another message.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a failed response", { nativeBrowserOpened: true, botId: "pepper" }, 409],
    ["no open confirmation", { botId: "pepper" }, 200],
    ["an explicit refusal", { nativeBrowserOpened: false, botId: "pepper" }, 200],
    ["a truthy non-boolean confirmation", { nativeBrowserOpened: "false", botId: "pepper" }, 200],
    ["no bot identity", { nativeBrowserOpened: true }, 200],
    ["an empty bot identity", { nativeBrowserOpened: true, botId: "" }, 200],
    ["a non-string bot identity", { nativeBrowserOpened: true, botId: 17 }, 200],
    ["a malformed error", { error: { message: "Internal detail" } }, 403],
    ["an empty body", null, 200],
  ] satisfies Array<[string, unknown, number]>)("refuses %s with the ordinary opening error", async (_name, body, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => response(body, status)));
    await expect(requestNativeArtifact(filePath, message)).rejects.toThrow("Could not open this page in your browser.");
  });

  it("handles a non-JSON refusal without claiming that a page opened", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unavailable", { status: 503 })));
    await expect(requestNativeArtifact(filePath, message)).rejects.toThrow("Could not open this page in your browser.");
  });

  it("preserves an in-flight abort without retrying or replacing its cause", async () => {
    const controller = new AbortController();
    const aborted = new DOMException("Cancelled", "AbortError");
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(aborted), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const result = requestNativeArtifact(filePath, message, controller.signal);
    controller.abort();
    await expect(result).rejects.toBe(aborted);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
