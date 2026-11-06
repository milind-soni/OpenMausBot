// This computer's own workspaces on the rail: main's own handlers in a real headless Chrome (testing/one-workspace-fixture.ts
// with `profiles`), this computer's real server swapped between their folders at one address, the rail's own page in a tab of
// its own, and, once My Cloud is home, this computer really lent to My Cloud all along. Every path a person can take is walked
// through the real pages: ＋ and its naming step (Back, Close, Escape, an empty or taken name), switching in every order (a
// turn under way, two quick clicks), a workspace's menu (Rename, Colour, Remove asked first, the open one, the last one), an
// app restart, the rail past eight, the cloud badge in both looks, and a person with no Cloud, whose rail appears with a second
// place. Each picture is the window as the person sees it: the rail's own page over or beside the page the window shows.
// Pictures go to OMB_ONE_WORKSPACE_SHOTS, else the fixture's folder.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanWorkspaceConfig, profileDir, profilesDir } from "../../electron/clean-workspace.mjs";
import { parseCloudList } from "../../electron/cloud-list.mjs";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { hostTimeout } from "../../server/testing/host-timeout.ts";
import { freePortBlock } from "../../server/testing/ports.ts";
import { launchCloudSendFixture, type CloudSendFixture } from "./cloud-send-fixture.ts";
import { ensureUiBrowser, UI_TOOLS_DIR } from "./control-omb-ui.ts";
import { launchHomeWorld, shotsDir, welcomed, type HomeWorld } from "./one-workspace-fixture.ts";
import { decodePng, encodePng } from "./png.ts";

const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.info("skipping the rail workspaces UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

const MAC = '[data-rail-place="profile:default"]';
const WIDTH = 1280, HEIGHT = 800;

/** One world's helpers: waiting, both pages, the rail's tiles and the window's picture. */
function harness(get: () => { world: HomeWorld; shots: string }) {
  const until = async <T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 30_000, what = "the window"): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read().catch(() => undefined as T);
      if (value !== undefined && ok(value)) return value;
      if (Date.now() > deadline) {
        await get().world.window.screenshot(join(get().shots, `failure-${Date.now()}.png`)).catch(() => {});
        throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)} at ${get().world.window.url}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const page = <T>(expression: string) => get().world.window.evaluate<T>(expression);
  const rail = <T>(expression: string) => get().world.rail!.evaluate<T>(expression);
  const tiles = () => rail<Array<{ id: string; label: string; current: boolean; cloud: boolean; local: boolean }>>(
    "[...document.querySelectorAll('[data-rail-place]')].map((tile) => ({ id: tile.dataset.railPlace, label: tile.getAttribute('aria-label'), current: tile.getAttribute('aria-current') === 'page', cloud: Boolean(tile.querySelector('[data-rail-cloud]')), local: Boolean(tile.querySelector('[data-rail-local]')) }))");
  const onLocal = () => /^https?:/.test(get().world.window.url) && new URL(get().world.window.url).origin === get().world.localOrigin;
  /** The window as the person sees it: the rail at its left edge beside the page, or, while a sheet of the rail's is open,
   * the rail's see-through view over the whole window. */
  const picture = async (name: string) => {
    const { world, shots } = get();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await world.rail!.screenshot(join(shots, `${name}-rail.png`));
    await world.window.screenshot(join(shots, `${name}-page.png`));
    const over = decodePng(readFileSync(join(shots, `${name}-rail.png`))), under = decodePng(readFileSync(join(shots, `${name}-page.png`)));
    const covers = world.railCovers(), width = covers ? under.width : over.width + under.width, height = Math.max(over.height, under.height);
    writeFileSync(join(shots, `${name}.png`), encodePng(width, height, (x, y) => {
      const base = covers ? (y < under.height ? under.pixel(x, y) : [255, 255, 255] as [number, number, number])
        : x < over.width ? [255, 255, 255] as [number, number, number] : y < under.height ? under.pixel(x - over.width, y) : [255, 255, 255] as [number, number, number];
      if (x >= over.width || y >= over.height) return base;
      const top = over.pixel(x, y), alpha = over.alpha(x, y) / 255;
      return [0, 1, 2].map((at) => Math.round(top[at]! * alpha + base[at]! * (1 - alpha))) as [number, number, number];
    }));
    for (const part of ["rail", "page"]) rmSync(join(shots, `${name}-${part}.png`), { force: true });
  };
  /** A click on the rail's page, once React has drawn what is clicked. */
  const click = (selector: string) => until(() => rail<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`),
    Boolean, 10_000, selector);
  /** A right-click on a tile, then its menu as React drew it. */
  const menu = async (id: string) => {
    await rail(`document.querySelector('[data-rail-place="${id}"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    await until(() => rail<boolean>(`Boolean(document.querySelector('[data-rail-menu="${id}"]'))`), Boolean, 10_000, `${id}'s menu`);
  };
  /** Typing as a person does into a field of the rail's page (React's own value setter, then its input event). */
  const fill = (selector: string, value: string) => rail(`(() => { const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const key = (target: "rail" | "page", name: string) => (target === "rail" ? rail : page)(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(name)}, bubbles: true })), window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(name)}, bubbles: true }))`);
  const bots = () => page<string[]>("fetch('/api/bots?messages=0').then((response) => response.json()).then((body) => body.bots.map((bot) => bot.name))");
  return { until, page, rail, tiles, onLocal, picture, click, menu, fill, key, bots };
}

(enabled ? describe : describe.skip)("workspaces of this computer's own on the rail, once My Cloud is home", () => {
  let fx: CloudSendFixture;
  let world: HomeWorld;
  let shots = "";
  let cloudEntry = "";
  const gate = join(mkdtempSync(join(tmpdir(), "omb-rail-gate-")), "finish");
  writeFileSync(gate, "");
  const h = harness(() => ({ world, shots }));
  const { until, page, rail, tiles, onLocal, picture, click, menu, fill, key, bots } = h;
  /** Every look at the lent link and at the server's folder while the window switched. */
  const linkSeen: boolean[] = [];
  const foldersSeen = new Set<string>();
  let watching = false, watcher: Promise<void> = Promise.resolve();
  const myCloud = () => world.environments().environments.find((entry: { origin?: string }) => entry.origin === world.cloudOrigin);
  const lent = () => Boolean(world.lending!.cloudState(myCloud()).connected);
  const onCloud = () => until(() => page<string>("document.body.innerText"), (text) => new URL(world.window.url).origin === world.cloudOrigin && text.includes("Atlas"), 60_000, "My Cloud's page with its bots");
  const lentCount = async () => ((await fx.onCloud("GET", "/api/shared-computers")).body?.computers ?? []).filter((computer: { online?: boolean }) => computer.online !== false).length;
  const current = async () => (await tiles()).find((tile) => tile.current)?.id ?? null;
  const shown = (id: string, text?: string) => until(async () => ({ current: await current(), local: onLocal(), body: await page<string>("document.body.innerText") }),
    (seen) => seen.current === id && (id === cloudEntry ? !seen.local : seen.local) && (!text || seen.body.includes(text)), 90_000, `${id} on screen${text ? ` with ${text}` : ""}`);
  const lineOf = () => page<string | null>("document.querySelector('[data-home-line]')?.textContent ?? null");
  const workId = () => world.registry!.list().find((entry) => entry.name === "Work")?.id ?? "work";

  beforeAll(async () => {
    fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-profile-${randomBytes(12).toString("hex")}`,
      desktopEngine: `process.env.FAKE_CLAUDE_MODE = "slow"; process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(gate)};` });
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
    await world.setSize(WIDTH, HEIGHT);
    // The session lists My Cloud as the person's own, as the Admin does: so its circle is a rail even alone, for ＋.
    // The Admin lists https addresses only; this one's is the fixture's own edge.
    world.account.state = { ...world.account.state, clouds: parseCloudList([{ id: "c-home", name: "My Cloud", color: null, role: "owner", tier: "pro", runsOn: "cloud",
      status: "ready", origin: "https://omb-u-fixture.fly.dev", teamId: null, primary: true }])!.map((cloud) => ({ ...cloud, origin: world.cloudOrigin })) };
    // Each page's dev server bundles what it imports on the first visit, then reloads it once: done before anything counts.
    for (const url of [`${world.localOrigin}/`, `${world.cloudOrigin}/`]) {
      await world.window.loadURL(url).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 8_000));
    }
    expect((await fx.local("POST", "/api/move/freeze", { cloud: world.cloudOrigin })).body.frozen).toBe(true);
    const profile = profileDir(fx.desktopDataDir, "default");
    mkdirSync(profile, { recursive: true });
    const { instances } = JSON.parse(readFileSync(join(fx.desktopDataDir, "config.json"), "utf8"));
    writeFileSync(join(profile, "config.json"), JSON.stringify({ ...cleanWorkspaceConfig("en"), instances }));
  }, hostTimeout(300_000));
  afterAll(async () => { watching = false; await watcher; await world?.close(); await fx?.close(); }, hostTimeout(60_000));

  it("My Cloud opens by default: This Mac beside it, a small cloud on My Cloud's tile only, in the light look and the dark; this computer lent to My Cloud", async () => {
    await world.home.show();
    await onCloud();
    cloudEntry = myCloud()!.id;
    world.lending!.start({ maintainer: false });
    await until(async () => lent(), Boolean, 30_000, "this computer lent to My Cloud");
    await until(lentCount, (count) => count === 1, 30_000, "My Cloud to see this computer");
    watching = true;
    watcher = (async () => { while (watching) { linkSeen.push(lent()); foldersSeen.add(world.running()); await new Promise((resolve) => setTimeout(resolve, 50)); } })();
    expect(world.railList().map((place) => place.id)).toEqual(["profile:default", cloudEntry]);
    await world.rail!.loadURL(`${world.localOrigin}/rail`);
    const found = await until(() => tiles(), (seen) => seen.length === 2, 60_000, "the rail's two tiles");
    expect(found).toEqual([
      { id: "profile:default", label: "This Mac: a separate place on this computer, with its own bots. The bots on My Cloud stay there.", current: false, cloud: false, local: false },
      { id: cloudEntry, label: expect.stringMatching(/, Cloud$/), current: true, cloud: true, local: false },
    ]);
    const ring = await rail<{ badge: number; ring: string; tile: number }>(`(() => { const badge = document.querySelector('[data-rail-cloud]'); const tile = badge.parentElement;
      return { badge: badge.getBoundingClientRect().width, ring: getComputedStyle(badge).borderTopColor, tile: tile.getBoundingClientRect().width }; })()`);
    expect(ring.badge, "a small circle at the tile's corner").toBeGreaterThanOrEqual(13);
    expect(ring.badge).toBeLessThan(ring.tile);
    await world.theme(false);
    await onCloud();
    const lightRing = await until(() => rail<string>("getComputedStyle(document.querySelector('[data-rail-cloud]')).borderTopColor"), Boolean, 15_000, "the badge in the light look");
    await picture("01-rail-cloud-badge-light");
    await world.theme(true);
    await until(() => rail<string>("getComputedStyle(document.querySelector('[data-rail-cloud]')).borderTopColor"), (color) => color !== lightRing, 15_000, "the badge's ring in the dark look");
    await picture("01-rail-cloud-badge-dark");
    await world.theme(false);
  }, hostTimeout(180_000));

  it("This Mac opens fresh; the frozen copy stays frozen; My Cloud and back keeps This Mac running and as it was left", async () => {
    await click(MAC);
    await until(lineOf, (text) => Boolean(text?.startsWith("This Mac starts fresh")), 90_000, "This Mac's page");
    expect(world.running()).toBe(profileDir(fx.desktopDataDir, "default"));
    expect((await bots()).filter((name) => ["Atlas", "Juno"].includes(name)), "none of the Cloud's bots, nor the frozen copy's").toEqual([]);
    expect(await page<string>("fetch('/api/bots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Scout' }) }).then((response) => response.status)")).toBe(201);
    await picture("02-this-mac-fresh");
    await click(`[data-rail-place="${cloudEntry}"]`);
    await onCloud();
    expect(world.clean!.profile(), "This Mac's place still runs").toBe("default");
    await click(MAC);
    await shown("profile:default", "Scout");
  }, hostTimeout(240_000));

  it("＋: the choices with New workspace first; Escape, Close and Back each leave cleanly; an empty name can't be made and a taken one says so", async () => {
    const choose = () => until(async () => world.railCovers() && await rail<boolean>("Boolean(document.querySelector('[data-place-add=\"choose\"]'))"), Boolean, 15_000, "＋'s choices over the window");
    await click("[data-rail-add]");
    await choose();
    expect(await rail<string[]>("[...document.querySelectorAll('[data-place-add-choice]')].map((choice) => choice.dataset.placeAddChoice)")).toEqual(["local", "server"]);
    expect(await rail<string>("document.querySelector('[data-place-add-choice=\"local\"]').textContent")).toContain("New workspace on this computer");
    await picture("03-plus-choices-light");
    await world.theme(true);
    await picture("03-plus-choices-dark");
    await world.theme(false);
    await key("rail", "Escape");
    await until(async () => !world.railCovers() && !(await rail("Boolean(document.querySelector('[data-place-add-sheet]'))")), Boolean, 10_000, "Escape closing the sheet");
    await click("[data-rail-add]");
    await choose();
    await click('[data-place-add-choice="local"]');
    await until(() => rail("Boolean(document.querySelector('[data-place-add=\"local\"]'))"), Boolean, 10_000, "the naming step");
    await rail("[...document.querySelectorAll('[data-place-add=\"local\"] button')].find((button) => button.textContent === 'Back').click()");
    await choose();
    await click('[data-place-add-sheet] [aria-label="Close"]');
    await until(async () => !world.railCovers(), Boolean, 10_000, "Close closing the sheet");
    expect(world.registry!.list().map((entry) => entry.id), "nothing made").toEqual(["default"]);
  }, hostTimeout(120_000));

  it("＋ → New workspace → Work, in a colour: it opens fresh, This Mac keeps its data, and the window and the line call it Work", async () => {
    await click("[data-rail-add]");
    await until(() => rail("Boolean(document.querySelector('[data-place-add-choice=\"local\"]'))"), Boolean, 15_000, "＋'s choices");
    await click('[data-place-add-choice="local"]');
    await until(() => rail("Boolean(document.querySelector('[data-place-add=\"local\"]'))"), Boolean, 15_000, "the naming step");
    expect(await rail<string>("document.querySelector('[data-local-name]').value"), "the first name no place here has").toBe("Work");
    await fill("[data-local-name]", "   ");
    expect(await rail<boolean>("document.querySelector('[data-local-create]').disabled"), "no name: nothing to make").toBe(true);
    await fill("[data-local-name]", "this mac");
    await click("[data-local-create]");
    await until(() => rail<string | null>("document.querySelector('[data-local-problem]')?.textContent ?? null"), (text) => text === "Another place here has that name. Choose another.", 10_000, "the taken name said");
    await picture("04-plus-name-taken");
    await fill("[data-local-name]", "Work");
    await click('[data-place-add="local"] [data-swatch="rose"]');
    await picture("04-plus-name-work");
    await click("[data-local-create]");
    await until(async () => !world.railCovers(), Boolean, 15_000, "the sheet closing once made");
    await shown(`profile:${workId()}`);
    await until(lineOf, (text) => text === "Work starts fresh: a separate place on this computer, with its own bots, chats and files.", 30_000, "Work's line");
    await until(() => page<string | null>("document.querySelector('[data-window-place]')?.textContent ?? null"), (name) => name === "Work", 15_000, "the top bar naming Work");
    expect(world.running()).toBe(profileDir(fx.desktopDataDir, workId()));
    expect(await bots(), "fresh: no Scout").not.toContain("Scout");
    const work = (await tiles()).find((tile) => tile.id === `profile:${workId()}`)!;
    expect([work.local, work.cloud, work.label]).toEqual([true, false, "Work: a separate place on this computer, with its own bots"]);
    expect(world.registry!.get(workId())?.color).toBe("rose");
    await picture("05-work-fresh");
  }, hostTimeout(180_000));

  it("This Mac ↔ Work ↔ My Cloud in every order: each shows what was left there, the frozen copy never runs, the link never drops", async () => {
    const work = `profile:${workId()}`;
    foldersSeen.clear();
    const steps: Array<[string, string]> = [["profile:default", "Scout"], [cloudEntry, "Atlas"], [work, ""], [cloudEntry, "Atlas"], ["profile:default", "Scout"], [work, ""], ["profile:default", "Scout"]];
    for (const [id, text] of steps) {
      await click(`[data-rail-place="${id}"]`);
      await shown(id, text || undefined);
      if (id === work) expect(await bots()).not.toContain("Scout");
    }
    expect(foldersSeen.has(fx.desktopDataDir), "switching between workspaces never starts the frozen copy's server").toBe(false);
    expect(JSON.parse(readFileSync(join(fx.desktopDataDir, "moved.json"), "utf8")).cloud).toBe(world.cloudOrigin);
    expect(linkSeen.every(Boolean), "this computer stayed lent to My Cloud throughout").toBe(true);
    expect(await lentCount(), "one lent computer, whichever workspace is open").toBe(1);
  }, hostTimeout(400_000));

  it("a switch while a turn runs: the circle says it opens once the bot finishes, the turn finishes there, and its reply is there on return", async () => {
    await click(`[data-rail-place="profile:${workId()}"]`);
    await shown(`profile:${workId()}`);
    if (!(await bots()).length) await page("fetch('/api/bots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Chief', modelSelection: { instanceId: 'claude', model: 'claude-sonnet-5' } }) })");
    await world.window.loadURL(`${world.localOrigin}/`);
    const composer = "textarea[aria-label^=\"Message\"]";
    await until(() => page<boolean>(`Boolean(document.querySelector('${composer}'))`), Boolean, 60_000, "Work's composer");
    rmSync(gate, { force: true });
    await page(`document.querySelector('${composer}').focus()`);
    await world.window.cdp.request("Input.insertText", { text: "Sort the quarterly notes" }, world.window.sessionId);
    for (const type of ["keyDown", "keyUp"]) await world.window.cdp.request("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, world.window.sessionId);
    const busy = await until(async () => (await fetch(`${fx.desktopBase}/api/move/freeze`, { headers: { "x-openmausbot-desktop-owner": fx.ownerCapability } }).then((response) => response.json())).busy as string | undefined,
      (name) => typeof name === "string" && name.length > 0, 30_000, "the turn under way");
    await click(MAC);
    await until(() => tiles(), (seen) => seen.find((tile) => tile.id === "profile:default")?.label === `This Mac opens once ${busy} finishes`, 15_000, "This Mac's circle saying it waits");
    expect(world.running(), "Work still runs while its bot answers").toBe(profileDir(fx.desktopDataDir, workId()));
    await picture("06-switch-waits-for-turn");
    writeFileSync(gate, "");
    await shown("profile:default", "Scout");
    await click(`[data-rail-place="profile:${workId()}"]`);
    await shown(`profile:${workId()}`);
    await until(() => page<string>("document.body.innerText"), (text) => text.includes("reply to:") && text.includes("Sort the quarterly notes"), 30_000, "the reply, there on return");
    expect(await page<string>("document.body.innerText"), "it finished: never cut short").not.toContain("turn interrupted");
  }, hostTimeout(240_000));

  it("two quick clicks on two tiles: only the last opens, and the rail and the window agree", async () => {
    await rail(`document.querySelector('${MAC}').click(); document.querySelector('[data-rail-place="${cloudEntry}"]').click(); document.querySelector('[data-rail-place="profile:${workId()}"]').click();`);
    await shown(`profile:${workId()}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await current(), JSON.stringify({ list: world.railList(), profile: world.home.profile(), active: world.environments().activeId, url: world.window.url, running: world.running() })).toBe(`profile:${workId()}`);
    expect(world.running()).toBe(profileDir(fx.desktopDataDir, workId()));
    await rail(`document.querySelector('[data-rail-place="profile:${workId()}"]').click(); document.querySelector('${MAC}').click();`);
    await shown("profile:default", "Scout");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect([await current(), world.running()]).toEqual(["profile:default", profileDir(fx.desktopDataDir, "default")]);
  }, hostTimeout(240_000));

  it("a workspace's menu: Rename, its colour, and Remove asked first; Cancel changes nothing; removing the open one goes to My Cloud first", async () => {
    const id = workId(), tile = `profile:${id}`;
    await menu(tile);
    await until(() => rail("Boolean(document.querySelector('[data-rail-menu]'))"), Boolean, 10_000, "Work's menu");
    await picture("07-menu");
    await click("[data-rail-rename]");
    await fill("[data-rail-rename-form] input", "Office");
    await rail("document.querySelector('[data-rail-rename-form]').requestSubmit()");
    await until(() => tiles(), (seen) => seen.find((entry) => entry.id === tile)?.label === "Office: a separate place on this computer, with its own bots", 10_000, "the tile renamed");
    await menu(tile);
    await click('[data-rail-local-color] [data-swatch="violet"]');
    await until(async () => world.registry!.get(id)?.color, (color) => color === "violet", 10_000, "the colour saved");
    await menu(tile);
    await click("[data-rail-remove-ask]");
    await until(() => rail<boolean>("Boolean(document.querySelector('[data-rail-menu] [role=\"alertdialog\"]'))"), Boolean, 10_000, "Remove asking");
    expect(await rail<string>("document.querySelector('[data-rail-menu] [role=\"alertdialog\"] p').textContent"))
      .toBe("Remove “Office”? Its bots, chats and files on this computer are deleted. Its folder goes to the Trash first.");
    await picture("08-remove-asks");
    await click("[data-rail-remove-cancel]");
    await key("rail", "Escape");
    expect(world.registry!.get(id), "Cancel: nothing removed").not.toBeNull();
    await click(`[data-rail-place="${tile}"]`);
    await shown(tile);
    await page("fetch('/api/bots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ledger' }) })");
    await menu(tile);
    await click("[data-rail-remove-ask]");
    await click("[data-rail-remove-confirm]");
    await onCloud();
    await until(() => tiles(), (seen) => !seen.some((entry) => entry.id === tile), 30_000, "Office gone from the rail");
    expect(world.running(), "its server stopped before its folder went").not.toBe(profileDir(fx.desktopDataDir, id));
    expect(existsSync(profileDir(fx.desktopDataDir, id))).toBe(false);
    const trashed = readdirSync(world.trashDir).find((name) => name.endsWith(`-${id}`))!;
    expect(readFileSync(join(world.trashDir, trashed, "bots.json"), "utf8"), "its bots are in the Trash, not gone").toContain("Ledger");
    await picture("09-removed-open-one");
  }, hostTimeout(240_000));

  it("an app restart while a workspace is open: My Cloud opens, the frozen copy's server is back without a workspace stranded, and the workspace opens again as it was", async () => {
    await click("[data-rail-add]");
    await until(() => rail("Boolean(document.querySelector('[data-place-add-choice=\"local\"]'))"), Boolean, 15_000, "＋'s choices");
    await click('[data-place-add-choice="local"]');
    await until(() => rail("Boolean(document.querySelector('[data-local-name]'))"), Boolean, 15_000);
    await fill("[data-local-name]", "Personal");
    await click("[data-local-create]");
    const personal = world.registry!.list().find((entry) => entry.name === "Personal")!.id;
    await shown(`profile:${personal}`);
    await page("fetch('/api/bots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Diary' }) })");
    await world.restartApp();
    await onCloud();
    expect(world.running(), "a launch starts the data folder's server, as ever").toBe(fx.desktopDataDir);
    expect(world.clean!.active()).toBe(false);
    const after = await until(() => tiles(), (seen) => seen.length === 3, 30_000, "the rail after the restart");
    expect(after.map((tile) => [tile.id, tile.current])).toEqual([["profile:default", false], [`profile:${personal}`, false], [cloudEntry, true]]);
    await picture("10-after-restart");
    await click(`[data-rail-place="profile:${personal}"]`);
    await shown(`profile:${personal}`, "Diary");
    await until(async () => lent(), Boolean, 30_000, "this computer lent again after the restart");
  }, hostTimeout(240_000));

  it("past eight tiles: ⋯ lists every place, a row opens its place and its right-click opens its menu", async () => {
    for (const name of ["Lab", "Studio", "Garden", "Kitchen", "Travel", "Music"]) expect(world.profiles!.create({ name }).outcome).toBe("made");
    await until(() => tiles(), (seen) => seen.length === 8, 30_000, "eight tiles");
    expect(await rail<boolean>("Boolean(document.querySelector('[data-rail-more-button]'))")).toBe(true);
    await click("[data-rail-more-button]");
    await until(() => rail<number>("document.querySelectorAll('[data-rail-more] li').length"), (count) => count === world.railList().length && count > 8, 10_000, "every place in the list");
    await picture("11-past-eight");
    await rail("[...document.querySelectorAll('[data-rail-more] li button')].find((row) => row.textContent.includes('Music')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))");
    await until(() => rail("Boolean(document.querySelector('[data-rail-menu] [data-rail-rename]'))"), Boolean, 10_000, "Music's menu from its row");
    await key("rail", "Escape");
    await click("[data-rail-more-button]");
    await rail("[...document.querySelectorAll('[data-rail-more] li button')].find((row) => row.textContent.includes('Music')).click()");
    const music = world.registry!.list().find((entry) => entry.name === "Music")!.id;
    await shown(`profile:${music}`);
    expect((await tiles()).some((tile) => tile.id === `profile:${music}`), "the place on screen is always among the tiles").toBe(true);
  }, hostTimeout(240_000));

  it("removing the last workspace of this computer's own lands on My Cloud, whose ＋ still offers a new one", async () => {
    for (const entry of world.registry!.list()) {
      const on = await current();
      if (on === `profile:${entry.id}`) {
        await menu(`profile:${entry.id}`);
        await click("[data-rail-remove-ask]");
        await click("[data-rail-remove-confirm]");
        await onCloud();
      } else expect(await world.profiles!.remove(entry.id)).toEqual({ outcome: "removed" });
    }
    await until(() => tiles(), (seen) => seen.length === 1 && seen[0]!.id === cloudEntry, 30_000, "My Cloud alone on the rail");
    expect(world.running()).toBe(fx.desktopDataDir);
    expect(readdirSync(profilesDir(fx.desktopDataDir)).filter((name) => !name.startsWith(".") && name !== "profiles.json")).toEqual([]);
    await click("[data-rail-add]");
    await until(() => rail("Boolean(document.querySelector('[data-place-add-choice=\"local\"]'))"), Boolean, 15_000, "＋'s choices");
    await click('[data-place-add-choice="local"]');
    await until(() => rail("Boolean(document.querySelector('[data-local-name]'))"), Boolean, 15_000, "＋ still offering a new workspace");
    expect(await rail<string>("document.querySelector('[data-local-name]').value"), "This Mac's name is free again").toBe("Work");
    await key("rail", "Escape");
    await picture("12-last-removed");
    watching = false; await watcher;
    expect(linkSeen.length).toBeGreaterThan(100);
    expect(linkSeen.every(Boolean), "the lent link never dropped, from the first switch to the last removal").toBe(true);
    expect(JSON.parse(readFileSync(join(fx.desktopDataDir, "moved.json"), "utf8")).cloud, "never unfrozen: its routines never ran beside a workspace's").toBe(world.cloudOrigin);
  }, hostTimeout(180_000));
});

(enabled ? describe : describe.skip)("a person with no Cloud: a new workspace from the Server menu, and the rail once there are two places", () => {
  let fx: CloudSendFixture;
  let world: HomeWorld;
  let shots = "";
  const { until, page, tiles, onLocal, picture, click, menu, key, bots } = harness(() => ({ world, shots }));

  beforeAll(async () => {
    fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-local-${randomBytes(12).toString("hex")}` });
    await welcomed(fx);
    await fx.local("POST", "/api/bots", { name: "Atlas", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    const tools = await ensureUiBrowser(process.env);
    if (!tools.chrome) throw new Error("This harness needs the pinned Chrome for Testing");
    const ports = await Promise.all([freePortBlock([0, 1]), freePortBlock([0, 1]), freePortBlock([0]), freePortBlock([0, 1])]) as [number, number, number, number];
    world = await launchHomeWorld(fx, { chrome: tools.chrome, ports, profiles: true });
    shots = shotsDir(fx.root);
    await world.setSize(WIDTH, HEIGHT);
    world.moved = false;
    world.account.state = { status: "signed-out" } as never;
    await world.window.loadURL(`${world.localOrigin}/`).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }, hostTimeout(300_000));
  afterAll(async () => { await world?.close(); await fx?.close(); }, hostTimeout(60_000));

  it("one place, no rail; the Server menu's New workspace asks a name on this computer's page, Escape leaves, Create makes it and the rail appears", async () => {
    await world.home.show();
    await until(async () => onLocal() && (await bots()).includes("Atlas"), Boolean, 60_000, "This computer's page");
    expect(world.railList()).toEqual([]);
    await world.rail!.loadURL(`${world.localOrigin}/rail`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await tiles()).toEqual([]);
    world.window.webContents.send("workspaces:new-local");
    await until(() => page("Boolean(document.querySelector('[data-place-add=\"local\"]'))"), Boolean, 15_000, "the naming step on this computer's page");
    await picture("L1-server-menu-name-step");
    await key("page", "Escape");
    await until(() => page("!document.querySelector('[data-place-add-sheet]')"), Boolean, 10_000, "Escape closing it");
    expect(world.registry!.list().filter((entry) => entry.name)).toEqual([]);
    world.window.webContents.send("workspaces:new-local");
    await until(() => page("Boolean(document.querySelector('[data-local-create]'))"), Boolean, 15_000);
    await page("document.querySelector('[data-local-create]').click()");
    await until(() => tiles(), (seen) => seen.map((tile) => [tile.id, tile.current]).join() === "local,false,profile:work,true", 90_000, "This computer and Work on the rail, Work on screen");
    expect(world.running()).toBe(profileDir(fx.desktopDataDir, "work"));
    expect(await bots()).not.toContain("Atlas");
    await until(() => page<string | null>("document.querySelector('[data-home-line]')?.textContent ?? null"), (text) => Boolean(text?.startsWith("Work starts fresh")), 30_000, "Work's line");
    await picture("L2-rail-appears");
  }, hostTimeout(240_000));

  it("This computer and Work both ways, each as it was; removing the open one goes back to This computer and the rail goes with it", async () => {
    await click('[data-rail-place="local"]');
    await until(async () => (await bots()).includes("Atlas") && world.running() === fx.desktopDataDir, Boolean, 90_000, "This computer again");
    expect((await tiles()).find((tile) => tile.current)?.id).toBe("local");
    await click('[data-rail-place="profile:work"]');
    await until(async () => world.running() === profileDir(fx.desktopDataDir, "work") && !(await bots()).includes("Atlas"), Boolean, 90_000, "Work again");
    await menu("profile:work");
    await click("[data-rail-remove-ask]");
    await click("[data-rail-remove-confirm]");
    await until(async () => onLocal() && world.running() === fx.desktopDataDir && (await bots()).includes("Atlas"), Boolean, 90_000, "This computer after the removal");
    await until(() => tiles(), (seen) => seen.length === 0, 30_000, "one place again: no rail");
    expect(world.railList()).toEqual([]);
    await picture("L3-back-to-one-place");
  }, hostTimeout(240_000));
});
