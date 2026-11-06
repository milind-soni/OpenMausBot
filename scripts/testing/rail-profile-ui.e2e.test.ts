// This Mac on the rail, for a person whose bots moved to My Cloud: main's own handlers in a real headless Chrome
// (testing/one-workspace-fixture.ts with `profiles`), My Cloud a real Cloud-mode server, this computer its real, frozen server
// until the rail's This Mac starts a fresh profile at the same address, and this computer really lent to My Cloud all along.
// Each picture is the window as the person sees it: the rail's own page beside the page the window shows. Pictures go to
// OMB_ONE_WORKSPACE_SHOTS, else the fixture's folder.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanWorkspaceConfig, profileDir } from "../../electron/clean-workspace.mjs";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { hostTimeout } from "../../server/testing/host-timeout.ts";
import { freePortBlock } from "../../server/testing/ports.ts";
import { launchCloudSendFixture, type CloudSendFixture } from "./cloud-send-fixture.ts";
import { ensureUiBrowser, UI_TOOLS_DIR } from "./control-omb-ui.ts";
import { launchHomeWorld, shotsDir, welcomed, type HomeWorld } from "./one-workspace-fixture.ts";
import { decodePng, encodePng } from "./png.ts";

const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.info("skipping the This Mac rail UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

const MAC = '[data-rail-place="profile:default"]';
const WIDTH = 1280, HEIGHT = 800, SCALE = 2;

(enabled ? describe : describe.skip)("This Mac on the rail, once My Cloud is home", () => {
  let fx: CloudSendFixture;
  let world: HomeWorld;
  let shots = "";
  let cloudEntry = "";
  /** Every look at the lent link while the window switched, and whether it was up each time. */
  const linkSeen: boolean[] = [];
  let watching = false;
  const until = async <T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 30_000, what = "the window"): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read().catch(() => undefined as T);
      if (value !== undefined && ok(value)) return value;
      if (Date.now() > deadline) {
        await world.window.screenshot(join(shots, `failure-${Date.now()}.png`)).catch(() => {});
        throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)} at ${world.window.url}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const page = <T>(expression: string) => world.window.evaluate<T>(expression);
  const rail = <T>(expression: string) => world.rail!.evaluate<T>(expression);
  const myCloud = () => world.environments().environments.find((entry: { origin?: string }) => entry.origin === world.cloudOrigin);
  const lent = () => Boolean(world.lending!.cloudState(myCloud()).connected);
  const onCloud = () => until(() => page<string>("document.body.innerText"), (text) => new URL(world.window.url).origin === world.cloudOrigin && text.includes("Atlas"), 60_000, "My Cloud's page with its bots");
  const railTiles = () => rail<Array<{ id: string; label: string; current: boolean }>>(
    "[...document.querySelectorAll('[data-rail-place]')].map((tile) => ({ id: tile.dataset.railPlace, label: tile.getAttribute('aria-label'), current: tile.getAttribute('aria-current') === 'page' }))");
  /** The window as the person sees it: the rail's page at its left edge, the place's page beside it. */
  const picture = async (name: string) => {
    await world.rail!.screenshot(join(shots, `${name}-rail.png`));
    await world.window.screenshot(join(shots, `${name}-page.png`));
    const left = decodePng(readFileSync(join(shots, `${name}-rail.png`))), right = decodePng(readFileSync(join(shots, `${name}-page.png`)));
    writeFileSync(join(shots, `${name}.png`), encodePng(left.width + right.width, Math.max(left.height, right.height),
      (x, y) => (x < left.width ? (y < left.height ? left.pixel(x, y) : [255, 255, 255]) : y < right.height ? right.pixel(x - left.width, y) : [255, 255, 255])));
  };
  const watchLink = async () => {
    watching = true;
    while (watching) { linkSeen.push(lent()); await new Promise((resolve) => setTimeout(resolve, 50)); }
  };

  beforeAll(async () => {
    fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-profile-${randomBytes(12).toString("hex")}` });
    await welcomed(fx);
    // What a move leaves: the bots on My Cloud, this computer's copy of them frozen.
    for (const name of ["Atlas", "Juno"]) {
      await fx.local("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
      await fx.onCloud("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    }
    const tools = await ensureUiBrowser(process.env);
    if (!tools.chrome) throw new Error("This harness needs the pinned Chrome for Testing");
    const ports = await Promise.all([freePortBlock([0, 1]), freePortBlock([0, 1]), freePortBlock([0]), freePortBlock([0, 1])]) as [number, number, number, number];
    world = await launchHomeWorld(fx, { chrome: tools.chrome, ports, profiles: true });
    shots = shotsDir(fx.root);
    await world.window.cdp.request("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false }, world.window.sessionId);
    await world.rail!.cdp.request("Emulation.setDeviceMetricsOverride", { width: 36, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false }, world.rail!.sessionId);
    // Each page's dev server bundles what it imports on the first visit, then reloads it once: done before anything counts.
    for (const url of [`${world.localOrigin}/`, `${world.cloudOrigin}/`]) {
      await world.window.loadURL(url).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 8_000));
    }
    expect((await fx.local("POST", "/api/move/freeze", { cloud: world.cloudOrigin })).body.frozen).toBe(true);
    // The profile's first config as the app writes it, with the fixture's AIs only, so nothing on this machine's PATH is used.
    const profile = profileDir(fx.desktopDataDir, "default");
    mkdirSync(profile, { recursive: true });
    const { instances } = JSON.parse(readFileSync(join(fx.desktopDataDir, "config.json"), "utf8"));
    writeFileSync(join(profile, "config.json"), JSON.stringify({ ...cleanWorkspaceConfig("en"), instances }));
  }, hostTimeout(300_000));
  afterAll(async () => { watching = false; await world?.close(); await fx?.close(); }, hostTimeout(60_000));

  it("My Cloud opens by default, the rail shows This Mac beside it, and this computer is lent to My Cloud", async () => {
    await world.home.show();
    await onCloud();
    cloudEntry = myCloud()!.id;
    world.lending!.start({ maintainer: false });
    await until(async () => lent(), Boolean, 30_000, "this computer lent to My Cloud");
    await until(async () => ((await fx.onCloud("GET", "/api/shared-computers")).body?.computers ?? []).filter((computer: { online?: boolean }) => computer.online !== false).length,
      (count) => count === 1, 30_000, "My Cloud to see this computer");
    expect(world.railList().map((place) => place.id)).toEqual(["profile:default", cloudEntry]);
    await world.rail!.loadURL(`${world.localOrigin}/rail`);
    const tiles = await until(() => railTiles(), (found) => found.length === 2, 60_000, "the rail's two tiles");
    expect(tiles).toEqual([
      { id: "profile:default", label: "This Mac: a separate place on this computer, with its own bots. The bots on My Cloud stay there.", current: false },
      { id: cloudEntry, label: expect.any(String), current: true },
    ]);
    expect(world.clean!.active()).toBe(false);
    expect(await page<string | null>("document.querySelector('[data-home-line]')?.dataset.homeLine ?? null")).toBeNull();
    await picture("1-my-cloud-with-this-mac-on-the-rail");
  }, hostTimeout(180_000));

  it("This Mac opens a fresh, empty place on this computer; the frozen copy stays frozen and the lent link stays up", async () => {
    const watcher = watchLink();
    await rail(`document.querySelector('${MAC}').click()`);
    await until(() => page<string | null>("document.querySelector('[data-home-line]')?.textContent ?? null"), (text) => Boolean(text?.startsWith("This Mac starts fresh")), 90_000, "This Mac's page");
    expect(new URL(world.window.url).origin).toBe(world.localOrigin);
    expect(new URL(world.window.url).pathname).toBe("/");
    expect(world.running()).toBe(profileDir(fx.desktopDataDir, "default"));
    expect(world.clean!.profile()).toBe("default");
    await until(() => page<string | null>("document.querySelector('[data-window-place]')?.textContent ?? null"), (name) => name === "This Mac", 15_000, "the top bar's name");
    const bots = await page<string[]>("fetch('/api/bots').then((response) => response.json()).then((body) => body.bots.map((bot) => bot.name))");
    expect(bots.filter((name) => ["Atlas", "Juno"].includes(name)), "none of the Cloud's bots, nor the frozen copy's").toEqual([]);
    expect(await page<string>("document.body.innerText")).not.toContain("Atlas");
    expect(await page<string>("document.querySelector('[data-home-line]').textContent"))
      .toContain("The bots you had here are on My Cloud; to bring in an older copy, import its backup in Settings → Backups.");
    // The frozen copy: its marker, and its bots, as the move left them.
    expect(JSON.parse(readFileSync(join(fx.desktopDataDir, "moved.json"), "utf8")).cloud).toBe(world.cloudOrigin);
    expect(existsSync(join(fx.desktopDataDir, "config.json"))).toBe(true);
    await until(() => railTiles(), (found) => found.find((tile) => tile.id === "profile:default")?.current === true, 15_000, "This Mac marked on the rail");
    await until(async () => lent(), Boolean, 15_000, "the lent link");
    expect(((await fx.onCloud("GET", "/api/shared-computers")).body?.computers ?? []).filter((computer: { online?: boolean }) => computer.online !== false)).toHaveLength(1);
    watching = false; await watcher;
    expect(linkSeen.length).toBeGreaterThan(10);
    expect(linkSeen.every(Boolean), "the lent link never dropped while This Mac opened").toBe(true);
    await picture("2-this-mac-fresh");
  }, hostTimeout(180_000));

  it("My Cloud on the rail goes back to the Cloud's bots; This Mac keeps running, so it is one click again, and the link never dropped", async () => {
    linkSeen.length = 0;
    const watcher = watchLink();
    const made = await page<{ bot?: { id: string } }>("fetch('/api/bots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Scout' }) }).then((response) => response.json())");
    expect(made.bot?.id).toBeTruthy();
    await rail(`document.querySelector('[data-rail-place="${cloudEntry}"]').click()`);
    await onCloud();
    expect(await page<string>("document.body.innerText")).not.toContain("Scout");
    expect(await page<string | null>("document.querySelector('[data-home-line]')?.dataset.homeLine ?? null"), "My Cloud's page has no This Mac line").toBeNull();
    expect(world.clean!.profile(), "This Mac's place still runs").toBe("default");
    await until(() => railTiles(), (found) => found.find((tile) => tile.id === cloudEntry)?.current === true, 15_000, "My Cloud marked on the rail");
    await picture("3-back-on-my-cloud");
    await rail(`document.querySelector('${MAC}').click()`);
    await until(() => page<string>("document.body.innerText"), (text) => new URL(world.window.url).origin === world.localOrigin && text.includes("Scout"), 60_000, "This Mac again, as it was left");
    expect(world.running()).toBe(profileDir(fx.desktopDataDir, "default"));
    watching = false; await watcher;
    expect(linkSeen.every(Boolean), "the lent link never dropped either way").toBe(true);
    expect(((await fx.onCloud("GET", "/api/shared-computers")).body?.computers ?? []).filter((computer: { online?: boolean }) => computer.online !== false)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(fx.desktopDataDir, "moved.json"), "utf8")).cloud, "never unfrozen").toBe(world.cloudOrigin);
    await picture("4-this-mac-again");
  }, hostTimeout(180_000));
});
