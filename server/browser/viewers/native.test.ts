import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { removeTempDir } from "../../testing/cleanup.ts";
import { BrowserService } from "../service.ts";
import { FakeBackend, FakeChrome } from "../testing/fake-chrome.ts";
import { Viewer, type ViewerOutput } from "./core.ts";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of close.splice(0)) await cleanup(); });

it("revokes a native grant that arrives after its viewer has left", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-native-viewer-"));
  const backend = new FakeBackend(() => new FakeChrome());
  const open = backend.open.bind(backend);
  let grant!: (token: string) => void;
  let started!: () => void;
  const granting = new Promise<void>(resolve => { started = resolve; });
  const revoked: string[] = [];
  backend.open = async request => ({ ...await open(request), native: {
    grant: () => { started(); return new Promise(resolve => { grant = resolve; }); },
    revoke: async token => { revoked.push(token); }, control: async () => {}, authorizeFile: async () => "file:///report.html",
  } });
  const service = new BrowserService({ dataDir, backend: () => backend, maxRunning: 1, idleMs: () => 60_000 });
  close.push(async () => { await service.closeAll(); await removeTempDir(dataDir); });
  const target = { key: "bot:native", session: "bot-native" };
  const output: ViewerOutput[] = [];
  const attached = service.attachViewer(target, { nativeView: true, owner: "view", person: "person", canOperate: true, maxWidth: 1280, maxHeight: 800 }, item => output.push(item));
  await granting;
  const viewer = [...service.profile(target).hub.viewers][0] as Viewer;
  await viewer.close();
  grant("retired-native-token");
  await attached;
  expect(revoked).toEqual(["retired-native-token"]);
  expect(output.some(item => item.type === "nativeView" && item.token)).toBe(false);
});

it.each(["grant", "revoke"])("cleans the viewer session when a native %s is rejected", async failure => {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-native-viewer-error-"));
  const backend = new FakeBackend(() => new FakeChrome());
  const open = backend.open.bind(backend);
  let failGrant = false, failRevoke = false;
  backend.open = async request => ({ ...await open(request), native: {
    grant: async () => { if (failGrant) throw Error("Invalid native browser view."); return "token"; },
    revoke: async () => { if (failRevoke) throw Error("Native profile belongs to another server."); },
    control: async () => {}, authorizeFile: async () => "file:///report.html",
  } });
  const service = new BrowserService({ dataDir, backend: () => backend, maxRunning: 1, idleMs: () => 60_000 });
  close.push(async () => { await service.closeAll(); await removeTempDir(dataDir); });
  const target = { key: "bot:native", session: "bot-native" };
  await service.agentRpc(target, "tools/call", { name: "agent_browser_open", arguments: {} });
  const profile = service.profile(target), output: ViewerOutput[] = [];
  const viewer = new Viewer(profile.hub, { nativeView: true, owner: "view", person: "person", canOperate: true, maxWidth: 1280, maxHeight: 800 }, item => output.push(item));
  if (failure === "grant") {
    failGrant = true;
    await expect(viewer.bind(profile.active())).resolves.toBeUndefined();
    expect(output.some(item => item.type === "gone")).toBe(true);
  } else {
    await viewer.bind(profile.active());
    failRevoke = true;
    await expect(viewer.teardown()).resolves.toBeUndefined();
  }
  expect(viewer.session).toBeNull();
  expect(backend.chrome.sent.some(item => item.method === "Target.detachFromTarget")).toBe(true);
});
