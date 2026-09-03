"use strict";
// Real-Electron proof that an installed extension actually reaches a page in
// the built-in browser surface. Unit tests use session doubles; this is the
// one that would catch Electron changing under us.
//
// It drives the real createBrowserSurfaceManager with the real coordinator,
// against a state file shaped exactly like the server's, and reports one
// JSON line on stdout.
const { cpSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { app, BaseWindow, WebContentsView, session } = require("electron");

const { createBrowserExtensionCoordinator, hashExtensionDir } = require("../browser-extensions.cjs");
const { createBrowserSurfaceManager } = require("../browser-surface.cjs");
const { browserPartition } = require("../browser-snapshot.cjs");

if (process.platform === "linux") app.commandLine.appendSwitch("no-sandbox");

const EXTENSION_SOURCE = join(__dirname, "browser-extension");
const out = {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const dataDir = join(tmpdir(), `omb-ext-fixture-${process.pid}`);
  const id = "local-abcdef123456";
  const version = "1.0.0";
  const installed = join(dataDir, "browser-extensions", id, version);
  cpSync(EXTENSION_SOURCE, installed, { recursive: true });

  writeFileSync(join(dataDir, "browser-extensions.json"), JSON.stringify({
    version: 1,
    extensions: [{
      id,
      name: "OpenMausBot Surface Fixture",
      version,
      manifestVersion: 3,
      enabled: true,
      source: { type: "local", path: EXTENSION_SOURCE },
      contentSha256: hashExtensionDir(installed),
      permissions: ["storage"],
      hostPermissions: [],
      warnings: [],
      installedAt: new Date().toISOString(),
    }],
  }));

  // A page the content script matches. It must look public: the surface
  // refuses loopback and private addresses, correctly, so a local server
  // cannot be the target. Serve an https origin from inside the session
  // instead, and stub the DNS answer the policy checks.
  const pageUrl = "https://fixture.invalid/";
  const botSession = session.fromPartition(browserPartition("fixture-bot"));
  botSession.protocol.handle("https", (request) => (
    new URL(request.url).hostname === "fixture.invalid"
      ? new Response("<!doctype html><title>fixture</title><h1>fixture page</h1>", {
        headers: { "content-type": "text/html" },
      })
      : new Response("", { status: 404 })
  ));

  const extensions = createBrowserExtensionCoordinator({ dataDir, log: () => {} });
  const owner = new BaseWindow({ show: false, width: 1280, height: 800 });
  const manager = createBrowserSurfaceManager({
    owner,
    createView: (options) => new WebContentsView(options),
    extensions,
    // The fixture host has no real DNS; the policy only needs a public answer.
    resolveHost: async () => ({ endpoints: [{ address: "93.184.216.34", family: "ipv4" }] }),
  });

  // ── the bot's own session: persistent, so extensions load ──
  const entry = manager.ensure("fixture-bot", "");
  await sleep(1200);
  // Through the real navigate path, so the awaited loadSafe seam is what
  // gets exercised — not a bare loadURL that skips it.
  out.navigated = await manager.navigate("fixture-bot", pageUrl).then(
    (page) => page?.url ?? true,
    (error) => `navigate-failed: ${error?.message ?? error}`,
  );
  const view = owner.contentView.children[0];
  await sleep(2500);

  const read = async (expression) => {
    try {
      return await view.webContents.executeJavaScript(expression);
    } catch (error) {
      return `eval-failed: ${error?.message ?? error}`;
    }
  };
  out.contentScriptRan = await read(`document.documentElement.dataset.ombExtension === "1"`);
  out.webAccessibleResourceFetch = await read(`document.documentElement.dataset.probeFetch`);
  out.partition = entry?.partition ?? null;

  const viewSession = view.webContents.session;
  out.loadedInSession = viewSession.extensions.getAllExtensions().map((candidate) => candidate.name);
  out.sessionHasExtension = extensions.sessionHasExtension(
    viewSession,
    viewSession.extensions.getAllExtensions()[0]?.id,
  );

  // ── a Guest view: in-memory, so nothing may load ──
  const guest = manager.ensure("fixture-bot", "guest");
  await sleep(800);
  out.guestPartitionIsPersistent = String(guest?.partition ?? "").startsWith("persist:");
  const guestView = owner.contentView.children.find((candidate) => candidate !== view);
  out.guestLoadedCount = guestView
    ? guestView.webContents.session.extensions.getAllExtensions().length
    : "no-guest-view";

  manager.closeAll();
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (error) {
    out.fatal = String(error?.stack ?? error);
  }
  process.stdout.write(`FIXTURE_RESULT ${JSON.stringify(out)}\n`);
  app.exit(0);
});
