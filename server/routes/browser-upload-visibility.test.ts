import { existsSync, mkdtempSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { BrowserService } from "../browser/service.ts";
import { FakeBackend, FakeChrome } from "../browser/testing/fake-chrome.ts";
import type { ViewerOutput } from "../browser/viewers/core.ts";
import { json, readBody } from "../harness/http.ts";
import { createVisibilityHost } from "../host/visibility-host.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createBrowserViewerRoutes, type BrowserViewerRouteDeps } from "./browser-viewers.ts";
import { createUpgrades } from "./upgrades.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("does not store or deliver a held upload after revocation while the viewer is still closing", async () => {
  const home = mkdtempSync(join(tmpdir(), "omb-upload-visibility-"));
  let bot = { id: "b1", name: "Bot", threadId: "t1", visibility: "everyone" };
  const store = { get bots() { return [bot]; }, groups: [], bot: () => bot, botByThread: () => bot, groupByThread: () => null };
  const visibility = createVisibilityHost({ store: () => store as never, routines: () => null, team: true,
    audiencesFor: () => ({ person: "alice", of: () => "team" }), threadsReferencing: () => [] });
  const auth: RequestAuth = { kind: "session", via: "bearer", scopes: ["client"], session: {
    id: "alice", email: "alice@example.test", tokenHash: "fixture", label: "Alice", scopes: ["client"],
    createdAt: 1, lastSeenAt: 1, expiresAt: Date.now() + 60_000,
  } };
  const current = () => visibility.visibleTo(visibility.viewerFor(auth)).bot("b1");
  const reading = deferred(), offered = deferred<Extract<ViewerOutput, { type: "fileChooser" }>>();
  const closingStarted = deferred(), finishClose = deferred();
  const backend = new FakeBackend(() => new FakeChrome());
  const service = new BrowserService({ dataDir: home, backend: () => backend, maxRunning: 4, idleMs: () => 600_000, takeoverMs: 20_000 });
  const target = { session: "browser-b1", key: "bot:b1" };
  let closing: Promise<void> | undefined;
  const server = createServer();
  let upload: ReturnType<typeof request> | undefined;
  try {
    await service.agentRpc(target, "tools/call", { name: "agent_browser_open", arguments: { url: "https://example.test/" } });
    const viewer = await service.attachViewer(target, { owner: "alice", person: "alice", canOperate: true, maxWidth: 1280, maxHeight: 800, pace: "hi" }, (output) => {
      if (output.type === "frame") output.ack();
      if (output.type === "fileChooser") offered.resolve(output);
    });
    await viewer.input({ type: "takeControl" });
    const page = [...backend.chrome!.pages.values()].at(-1)!;
    const session = backend.chrome!.sentTo(page).find((entry) => entry.method === "Page.enable" && entry.sessionId?.startsWith("S"))!.sessionId!;
    backend.chrome!.event("Page.fileChooserOpened", { frameId: page.targetId, mode: "selectMultiple", backendNodeId: 1 }, session);
    const picker = await offered.promise;
    const release = viewer.releaseInput.bind(viewer);
    viewer.releaseInput = async () => { closingStarted.resolve(); await finishClose.promise; return release(); };
    const route = createBrowserViewerRoutes({
      upgrades: createUpgrades(), dataDir: home, person: () => "alice", audience: () => "team",
      browser: async () => ({ botId: "b1", session: target.session, spec: { command: "omb-cdp", args: ["bot:b1"], env: {} } }),
      authorize: async () => null, current, restartRefusal: () => null,
      viewers: {
        fileChooserOffered: (_browser, owner, chooser) => { reading.resolve(); return service.fileChooserOffered(target.session, owner, chooser); },
        answerFileChooser: (_browser, owner, chooser, paths, isCurrent) => {
          const answering = service.answerFileChooser(target.session, owner, chooser, paths, isCurrent);
          finishClose.resolve();
          return answering;
        },
      } as BrowserViewerRouteDeps["viewers"],
    });
    server.on("request", (req, res) => {
      void (async () => {
        if (!current()) return json(res, 404, { error: "no such bot" });
        const url = new URL(req.url!, "http://localhost");
        await route({ req, res, url, path: url.pathname, method: req.method!, auth, json, readBody });
      })().catch((error) => json(res, 500, { error: error.message }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bots/b1/browser/upload?chooser=${picker.id}`;
    upload = request(url, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" } });
    const response = new Promise<number>((resolve, reject) => {
      upload!.on("error", reject);
      upload!.on("response", (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    });
    upload.flushHeaders();
    await reading.promise;
    bot = { ...bot, visibility: "admins" };
    visibility.forgetVisibility();
    closing = viewer.close();
    await closingStarted.promise;
    const fresh = await fetch(url, { method: "POST" });
    expect(fresh.status).toBe(404);
    await fresh.text();
    upload.end('--test\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nfixture\r\n--test--\r\n');
    const status = await response;
    finishClose.resolve();
    await closing;
    const writes = backend.chrome!.sent.filter((entry) => entry.method === "DOM.setFileInputFiles").length;
    expect({ status, writes, stored: existsSync(join(home, "browser-uploads")) }).toEqual({ status: 409, writes: 0, stored: false });
  } finally {
    finishClose.resolve();
    upload?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closing;
    await service.closeAll();
    await removeTempDir(home);
  }
});
