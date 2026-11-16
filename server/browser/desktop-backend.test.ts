import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { DesktopBackend } from "./desktop-backend.ts";
import { DesktopBrowserClient } from "./desktop-bridge.ts";
import { BrowserService } from "./service.ts";
import { FakeChrome } from "./testing/fake-chrome.ts";

type Message = Record<string, unknown>;
const folders: string[] = [];
const parents: NativeParent[] = [];
const services: BrowserService[] = [];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

class NativeParent extends EventEmitter {
  readonly messages: Message[] = [];
  readonly profiles = new Map<string, FakeChrome>();
  closeGate: Promise<void> | undefined;
  leaseGate: Promise<void> | undefined;
  failCdp: string | undefined;
  failClose = false;
  failErase = false;
  failLease = false;
  grant: unknown = "native-view-token";
  fileUrl: unknown;
  #epoch = 0;

  receive(message: Message) { this.emit("message", { data: message }); }

  postMessage(value: unknown): void {
    const message = value as Message;
    this.messages.push(message);
    const profileId = String(message.profileId);
    if (message.type === "openmausbot:native-browser-cdp") {
      const command = JSON.parse(String(message.message)) as Message;
      if (command.method === this.failCdp) {
        this.receive({ type: "openmausbot:native-browser-cdp-message", profileId, message: JSON.stringify({ id: command.id, error: { code: -32000, message: "fixture connect failed" } }) });
      } else this.profiles.get(profileId)?.send(String(message.message));
      return;
    }
    if (message.type === "openmausbot:native-browser-request") void this.#answer(message);
  }

  requests(action: string): Message[] { return this.messages.filter(message => message.action === action); }

  async #answer(message: Message): Promise<void> {
    const profileId = String(message.profileId);
    try {
      let result: Message = {};
      switch (message.action) {
        case "open": {
          const chrome = new FakeChrome();
          chrome.onMessage(text => this.receive({ type: "openmausbot:native-browser-cdp-message", profileId, message: text }));
          chrome.onClose(() => {
            if (this.profiles.get(profileId) === chrome) this.profiles.delete(profileId);
            this.receive({ type: "openmausbot:native-browser-closed", profileId });
          });
          this.profiles.set(profileId, chrome);
          result = { epoch: ++this.#epoch };
          break;
        }
        case "close":
          await this.closeGate;
          if (this.failClose) throw new Error("fixture close failed");
          this.profiles.get(profileId)?.exit("native profile closed");
          break;
        case "erase":
          if (this.failErase) throw new Error("fixture erase failed");
          this.profiles.get(profileId)?.exit("native profile erased");
          break;
        case "grant": result = { token: this.grant }; break;
        case "authorize-file": result = { url: this.fileUrl ?? pathToFileURL(String(message.path)).href }; break;
        case "lease":
          await this.leaseGate;
          if (this.failLease) throw new Error("fixture lease failed");
          result = { epoch: ++this.#epoch };
          break;
      }
      this.receive({ type: "openmausbot:native-browser-result", id: message.id, profileId, result });
    } catch (error) {
      this.receive({ type: "openmausbot:native-browser-result", id: message.id, profileId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  dispose(): void {
    for (const chrome of this.profiles.values()) chrome.exit("fixture ended");
    this.emit("close");
  }
}

function fixture({ ready = true, egress }: { ready?: boolean; egress?: (key: string) => Promise<number> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-desktop-backend-"));
  folders.push(dataDir);
  const parent = new NativeParent(); parents.push(parent);
  const client = new DesktopBrowserClient(parent);
  if (ready) parent.receive({ type: "openmausbot:native-browser-ready", protocol: 1, product: "Chrome/155.0.0.0" });
  const gates: string[] = [];
  const backend = new DesktopBackend({ client, dataDir, egressPort: async key => { gates.push(key); return egress ? egress(key) : 17000; } });
  const open = (key = "bot:a") => backend.open({ key, mode: "headless", fresh: false, viewport: { width: 1280, height: 800 }, downloadDir: join(dataDir, "downloads", key.replace(":", "-")) });
  return { backend, client, parent, dataDir, gates, open };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.closeAll()));
  for (const parent of parents.splice(0)) parent.dispose();
});
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

describe("native desktop backend", () => {
  it("refuses opening without a valid parent handshake before creating a gate or native profile", async () => {
    const f = fixture({ ready: false });
    expect(f.backend.summary().kind).toBe("unavailable");
    await expect(f.open()).rejects.toThrow(/desktop/i);
    expect(f.gates).toEqual([]);
    expect(f.parent.messages).toEqual([]);
    f.parent.receive({ type: "openmausbot:native-browser-ready", protocol: 2, product: "Chrome/155.0.0.0" });
    expect(f.backend.available()).toBe(false);
    f.parent.receive({ type: "openmausbot:native-browser-ready", protocol: 1, product: "Chrome/155.0.0.0" });
    expect(f.backend.summary()).toMatchObject({ kind: "engine", chrome: "Chrome/155.0.0.0" });
    await (await f.open()).close();
  });

  it("keeps profile identities stable within one workspace and distinct across workspaces, profiles, and guests", async () => {
    const a = fixture(); const b = fixture();
    const sameWorkspace = new DesktopBackend({ client: a.client, dataDir: a.dataDir, egressPort: async () => 17000 });
    const identity = a.backend.profileId("bot:a");
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(sameWorkspace.profileId("bot:a")).toBe(identity);
    expect(new Set([identity, b.backend.profileId("bot:a"), a.backend.profileId("bot:b"), a.backend.profileId("temp:a")]).size).toBe(4);
    const persistent = await a.open(); const guest = await a.open("temp:a");
    expect(a.parent.requests("open").map(request => ({ profileId: request.profileId, persistent: request.persistent }))).toEqual([
      { profileId: identity, persistent: true }, { profileId: a.backend.profileId("temp:a"), persistent: false },
    ]);
    await guest.close(); expect(a.backend.recorded("temp:a")).toBe(false);
    await persistent.close(); expect(a.backend.recorded("bot:a")).toBe(true);
  });

  it("waits for the egress gate before opening and passes that gate to the native parent", async () => {
    const gate = deferred();
    const f = fixture({ egress: async () => { await gate.promise; return 17321; } });
    const opening = f.open(); await tick();
    expect(f.gates).toEqual(["bot:a"]);
    expect(f.parent.requests("open")).toEqual([]);
    expect(f.backend.recorded("bot:a")).toBe(false);
    gate.resolve(); const opened = await opening;
    expect(f.parent.requests("open")).toHaveLength(1);
    expect(f.parent.requests("open")[0]).toMatchObject({ proxyPort: 17321, persistent: true, fresh: false });
    await opened.close();
  });

  it("does not open or enroll a profile when its egress gate fails", async () => {
    const f = fixture({ egress: async () => { throw new Error("fixture gate unavailable"); } });
    await expect(f.open()).rejects.toThrow("fixture gate unavailable");
    expect(f.parent.messages).toEqual([]);
    expect(f.backend.recorded("bot:a")).toBe(false);
  });

  it("waits for an opened native profile to acknowledge cleanup when the CDP connection fails", async () => {
    const f = fixture(); const cleanup = deferred();
    f.parent.closeGate = cleanup.promise; f.parent.failCdp = "Target.setDiscoverTargets";
    let settled = false;
    const opening = f.open().then(() => null, error => error as Error).then(result => { settled = true; return result; });
    let settledBeforeCleanup = false;
    try {
      await vi.waitFor(() => expect(f.parent.requests("close").length).toBeGreaterThan(0));
      await tick(); settledBeforeCleanup = settled;
    } finally { cleanup.resolve(); }
    const error = await opening;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("fixture connect failed");
    expect(settledBeforeCleanup).toBe(false);
    expect(f.parent.profiles.size).toBe(0);
  });

  it("removes a failed guest enrollment only after native cleanup succeeds", async () => {
    const f = fixture(); f.parent.failCdp = "Target.setDiscoverTargets";
    await expect(f.open("temp:a")).rejects.toThrow("fixture connect failed");
    await vi.waitFor(() => expect(f.parent.profiles.size).toBe(0));
    expect(f.backend.recorded("temp:a")).toBe(false);
  });

  it("retains enrollment for a failed startup whose native cleanup was refused", async () => {
    const f = fixture(); f.parent.failCdp = "Target.setDiscoverTargets"; f.parent.failClose = true;
    await expect(f.open("temp:a")).rejects.toThrow("fixture connect failed");
    expect(f.backend.recorded("temp:a")).toBe(true);
  });

  it("erases enrolled native state, leaves unknown keys alone, and retains failed erasures for retry", async () => {
    const f = fixture();
    await f.backend.erase("bot:unknown"); expect(f.parent.requests("erase")).toEqual([]);
    await (await f.open()).close(); expect(f.backend.recorded("bot:a")).toBe(true);
    f.parent.failErase = true;
    await expect(f.backend.erase("bot:a")).rejects.toThrow("fixture erase failed");
    expect(f.backend.recorded("bot:a")).toBe(true);
    f.parent.failErase = false; await f.backend.erase("bot:a");
    expect(f.backend.recorded("bot:a")).toBe(false);
    expect(f.parent.requests("erase").every(request => request.profileId === f.backend.profileId("bot:a"))).toBe(true);
    const requests = f.parent.requests("erase").length;
    await f.backend.erase("bot:a"); expect(f.parent.requests("erase")).toHaveLength(requests);
  });

  it("keeps recorded erasure pending when the desktop parent disconnects", async () => {
    const f = fixture(); await (await f.open()).close(); f.parent.emit("close");
    await expect(f.backend.erase("bot:a")).rejects.toThrow(/desktop/i);
    expect(f.backend.recorded("bot:a")).toBe(true);
  });

  it("forwards canonical control, view grants, revocation, and file authorization through the native boundary", async () => {
    const f = fixture(); const opened = await f.open();
    const page = await opened.browser.waitForPage(() => true, 500);
    const native = opened.native!;
    await native.control("person-a", true);
    const token = await native.grant(page.targetId, "view-window-a", "person-a", false);
    expect(token).toBe("native-view-token");
    expect(f.parent.requests("grant").at(-1)).toMatchObject({ targetId: page.targetId, viewerId: "person-a", viewId: "view-window-a", canOperate: false });
    await native.revoke(token);
    expect(f.parent.requests("ungrant").at(-1)).toMatchObject({ token });
    const path = join(f.dataDir, "artifact.html");
    expect(await native.authorizeFile(path, [f.dataDir])).toBe(pathToFileURL(path).href);
    expect(f.parent.requests("authorize-file").at(-1)).toMatchObject({ path, roots: [f.dataDir] });
    await opened.browser.connection.withActor({ kind: "viewer", viewerId: "person-a" }, () => page.session.send("Input.insertText", { text: "fixture" }));
    expect(f.parent.messages.at(-1)).toMatchObject({ actor: { kind: "viewer", viewerId: "person-a" }, epoch: f.client.epoch(f.backend.profileId("bot:a")) });
    await native.control(null, false);
    expect(f.parent.requests("lease").map(request => ({ viewerId: request.viewerId, ready: request.ready }))).toEqual([
      { viewerId: "person-a", ready: true }, { viewerId: null, ready: false },
    ]);
    await opened.close(); await opened.exited;
  });

  it("refuses malformed view grants and artifact authorization answers", async () => {
    const f = fixture(); const opened = await f.open();
    f.parent.grant = 12;
    await expect(opened.native!.grant("T1", "view-a", "person-a", true)).rejects.toThrow(/grant/i);
    f.parent.fileUrl = 12;
    await expect(opened.native!.authorizeFile(join(f.dataDir, "artifact.html"), [f.dataDir])).rejects.toThrow(/artifact/i);
    await opened.close();
  });

  it("preserves the driver's native HTTP-auth flow and the answering person's actor", async () => {
    const f = fixture(); const opened = await f.open(); const page = await opened.browser.waitForPage(() => true, 500);
    const chrome = f.parent.profiles.get(f.backend.profileId("bot:a"))!;
    const sessionId = chrome.sent.find(command => command.method === "Fetch.enable")!.sessionId!;
    chrome.event("Fetch.authRequired", { requestId: "fixture-auth", authChallenge: { source: "Server", origin: "https://fixture.test", realm: "fixture", scheme: "basic" } }, sessionId);
    await vi.waitFor(() => expect(page.auth.pending?.realm).toBe("fixture"));
    await opened.native!.control("person-a", true);
    await opened.browser.connection.withActor({ kind: "viewer", viewerId: "person-a" }, () => page.auth.answer({ username: "fixture-user", password: "fixture-password" }));
    const answer = f.parent.messages.filter(message => message.type === "openmausbot:native-browser-cdp").findLast(message => JSON.parse(String(message.message)).method === "Fetch.continueWithAuth")!;
    expect(answer.actor).toEqual({ kind: "viewer", viewerId: "person-a" });
    expect(JSON.parse(String(answer.message)).params).toEqual({ requestId: "fixture-auth", authChallengeResponse: { response: "ProvideCredentials", username: "fixture-user", password: "fixture-password" } });
    expect(page.auth.pending).toBeNull();
    await opened.close();
  });
});

describe("native control restoration", () => {
  it("restores an existing human controller when BrowserService reopens after a native crash", async () => {
    const f = fixture();
    const service = new BrowserService({ dataDir: f.dataDir, backend: () => f.backend, maxRunning: 4, idleMs: () => 600_000, takeoverMs: 200 });
    services.push(service);
    const profile = service.profile({ key: "bot:a", session: "bot-a" });
    await service.running(profile); await profile.control.take("person-a");
    const profileId = f.backend.profileId("bot:a");
    await f.client.controlSettled(profileId);
    f.parent.profiles.get(profileId)!.exit("fixture native crash");
    await vi.waitFor(() => expect(profile.run).toBeNull());
    expect(profile.control.owner).toBe("person-a"); expect(profile.control.ready).toBe(true);
    const previousLeases = f.parent.requests("lease").length;
    await service.running(profile);
    expect(f.parent.requests("lease").slice(previousLeases).at(-1)).toMatchObject({ viewerId: "person-a", ready: true });
  });

  it("forwards controller changes made while the initial native lease is awaiting acknowledgment", async () => {
    const f = fixture(); const lease = deferred(); f.parent.leaseGate = lease.promise;
    const service = new BrowserService({ dataDir: f.dataDir, backend: () => f.backend, maxRunning: 4, idleMs: () => 600_000, takeoverMs: 200 });
    services.push(service);
    const profile = service.profile({ key: "bot:a", session: "bot-a" });
    await profile.control.take("person-a");
    const starting = service.running(profile);
    try {
      await vi.waitFor(() => expect(f.parent.requests("lease")).toHaveLength(1));
      await profile.control.release("person-a", async () => true);
    } finally { lease.resolve(); }
    await starting;
    await f.client.controlSettled(f.backend.profileId("bot:a"));
    expect(profile.control.owner).toBeNull();
    expect(f.parent.requests("lease").at(-1)).toMatchObject({ viewerId: null, ready: false });
  });

  it("closes an opened native profile when initial control synchronization is rejected", async () => {
    const f = fixture(); f.parent.failLease = true;
    const service = new BrowserService({ dataDir: f.dataDir, backend: () => f.backend, maxRunning: 4, idleMs: () => 600_000, takeoverMs: 200 });
    services.push(service);
    const profile = service.profile({ key: "bot:a", session: "bot-a" });
    await profile.control.take("person-a");
    await expect(service.running(profile)).rejects.toThrow("fixture lease failed");
    expect(profile.run).toBeNull();
    expect(f.parent.profiles.size).toBe(0);
    expect(f.parent.requests("close").length).toBeGreaterThan(0);
  });
});
