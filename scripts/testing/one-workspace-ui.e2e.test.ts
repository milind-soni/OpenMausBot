// Once the person's bots moved to My Cloud, the desktop window is one window onto it: main's own handlers in a real
// headless Chrome (testing/one-workspace-fixture.ts), My Cloud a real Cloud-mode server and this computer its real,
// frozen server (testing/cloud-send-fixture.ts). Screenshots go to OMB_ONE_WORKSPACE_SHOTS, else the fixture's folder.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { hostTimeout } from "../../server/testing/host-timeout.ts";
import { freePortBlock } from "../../server/testing/ports.ts";
import { launchCloudSendFixture, type CloudSendFixture } from "./cloud-send-fixture.ts";
import { ensureUiBrowser, UI_TOOLS_DIR } from "./control-omb-ui.ts";
import { launchHomeWorld, shotsDir, welcomed, type HomeWorld } from "./one-workspace-fixture.ts";

const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.info("skipping the one-window UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

const PAIR_FORM = "Boolean(document.querySelector('form input') && /pairing code|Connect to|Sign in to/.test(document.body.innerText))";

(enabled ? describe : describe.skip)("the desktop window once My Cloud is home", () => {
  let fx: CloudSendFixture;
  let world: HomeWorld;
  let shots = "";
  let nova = "";
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
  const onCloudPage = () => until(() => page<boolean>("Boolean(document.querySelector('textarea[aria-label^=\"Message\"]'))"), Boolean, 60_000, "My Cloud's page")
    .then(() => expect(new URL(world.window.url).origin).toBe(world.cloudOrigin));
  const screen = () => page<string | null>("document.querySelector('[data-home-screen]')?.dataset.homeScreen ?? null");
  const blank = async () => { await world.window.loadURL("about:blank"); await new Promise((resolve) => setTimeout(resolve, 200)); };

  beforeAll(async () => {
    fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-window-${randomBytes(12).toString("hex")}` });
    await welcomed(fx);
    nova = (await fx.onCloud("POST", "/api/bots", { name: "Nova", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot.id;
    const tools = await ensureUiBrowser(process.env);
    if (!tools.chrome) throw new Error("This harness needs the pinned Chrome for Testing");
    const ports = await Promise.all([freePortBlock([0, 1]), freePortBlock([0, 1]), freePortBlock([0]), freePortBlock([0, 1])]) as [number, number, number, number];
    world = await launchHomeWorld(fx, { chrome: tools.chrome, ports });
    shots = shotsDir(fx.root);
    // Each page's dev server bundles what it imports on the first visit, then reloads it once: done before anything counts.
    for (const url of [`${world.localOrigin}/`, `${world.cloudOrigin}/`, `${world.teamOrigin}/`]) {
      await world.window.loadURL(url).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 8_000));
    }
  }, hostTimeout(240_000));
  afterAll(async () => { await world?.close(); await fx?.close(); }, hostTimeout(60_000));

  const step = () => page<string | null>("document.querySelector('[data-cloud-setup] [aria-current=step]')?.textContent ?? null");
  const settingUp = (setup: Record<string, unknown>) => ({ ...world.account.state, machine: { status: "provisioning", origin: world.cloudOrigin, setup } });

  it("before the move, My Cloud asked for while the Admin sets it up shows Setting up My Cloud… and is never looked up; it opens by itself once ready", async () => {
    await blank();
    const signedIn = world.account.state, before = world.cloudRequests.length;
    world.moved = false;
    try {
      world.account.state = settingUp({ step: "storage" });
      await world.home.openCloud();
      await until(() => screen(), (value) => value === "setup", 30_000, "the setup screen");
      const words = await page<string>("document.querySelector('main').innerText");
      expect(words).toContain("Setting up My Cloud…");
      expect(words).toContain("This takes about a minute. It opens by itself when it's ready.");
      expect(words).not.toMatch(/Server menu|choose it again|not reachable/);
      expect(await page<string[]>("[...document.querySelectorAll('main button')].map((button) => button.textContent)"), "nothing to press").toEqual([]);
      expect(await step()).toBe("Preparing storage");
      await world.window.screenshot(join(shots, "0-setting-up-my-cloud.png"));
      world.account.state = settingUp({ step: "checking" });
      await world.home.changed();
      await until(() => step(), (value) => value === "Checking it's ready", 15_000, "the next step");
      expect(new URL(world.window.url).origin).toBe(world.localOrigin);
      expect(world.cloudRequests.length, "nothing asked My Cloud while it was set up").toBe(before);
      world.account.state = signedIn;
      await world.home.changed();
      await onCloudPage();
      expect(world.home.asking()).toBe(false);
    } finally { world.account.state = signedIn; world.moved = true; }
  }, hostTimeout(120_000));

  it("before the move, a brand-new My Cloud whose name isn't found yet keeps Setting up My Cloud… and opens by itself once found, past the window's host cache", async () => {
    await blank();
    const signedIn = world.account.state;
    world.moved = false;
    try {
      world.account.state = settingUp({ step: "checking" });
      await world.home.changed();
      world.account.state = signedIn;
      await world.home.changed();
      world.network.nameMissing = true;
      const cleared = world.hostCache.cleared;
      await world.home.openCloud();
      await until(() => screen(), (value) => value === "setup", 30_000, "the setup screen");
      expect(await step()).toBe("Checking it's ready");
      expect(await page<string>("document.querySelector('main').innerText")).not.toMatch(/Can't reach|Server menu|choose it again/);
      await world.window.screenshot(join(shots, "0-my-cloud-name-not-found-yet.png"));
      world.network.nameMissing = false;
      await onCloudPage();
      expect(world.hostCache.cleared, "the host cache is cleared before the try that found it").toBeGreaterThan(cleared);
    } finally { world.network.nameMissing = false; world.account.state = signedIn; world.moved = true; }
  }, hostTimeout(120_000));

  it("someone with no Cloud move sees this computer's page as before, and the window never asks My Cloud", async () => {
    await blank();
    const before = world.cloudRequests.length;
    expect((await fx.local("GET", "/api/move/freeze")).body.frozen).toBe(false);
    await world.window.loadURL(`${world.localOrigin}/`);
    await until(() => page<boolean>("Boolean(document.querySelector('#root')?.childElementCount)"), Boolean, 60_000);
    expect(new URL(world.window.url).pathname).toBe("/");
    expect(await screen()).toBeNull();
    expect(world.cloudRequests.length).toBe(before);
    // From here on this computer's copy is frozen, as the move leaves it.
    expect((await fx.local("POST", "/api/move/freeze", { cloud: world.cloudOrigin })).body.frozen).toBe(true);
  }, hostTimeout(120_000));

  it("this computer's frozen copy serves only its screen, never the workspace", async () => {
    const answer = await fetch(`${fx.desktopBase}/settings`, { redirect: "manual" });
    expect([answer.status, answer.headers.get("location")]).toEqual([302, "/home"]);
    const signedIn = world.account.state;
    world.account.state = { status: "signed-out" };
    try {
      await world.window.loadURL(`${world.localOrigin}/`);
      await until(() => screen(), (value) => value === "signin");
      expect(new URL(world.window.url).pathname).toBe("/home");
    } finally { world.account.state = signedIn; }
  }, hostTimeout(60_000));

  it("launching with My Cloud asleep shows Waking My Cloud…, then the page", async () => {
    await blank();
    world.account.power = { state: "asleep", since: Date.now(), sleeps: true };
    const before = world.cloudRequests.length;
    const launched = world.launch();
    await until(async () => world.splash && !world.splash.destroyed ? world.splash.evaluate<string>("document.querySelector('.status')?.textContent ?? ''") : "", (text) => text === "Waking My Cloud…", 20_000, "the startup screen");
    await world.splash!.screenshot(join(shots, "1-startup-waking.png"));
    expect(world.cloudRequests.slice(before).filter((entry) => entry.at < Date.now()).map((entry) => entry.path)).not.toContain("/api/health");
    await launched;
    await onCloudPage();
    expect(world.account.wakes).toBe(1);
    expect(world.cloudRequests.slice(before)[0]?.path, "nothing knocks on a sleeping Cloud before the Admin wakes it").not.toBe("/api/health");
    await until(async () => world.splash?.destroyed ?? true, Boolean, 15_000, "the startup screen to close");
    await world.window.screenshot(join(shots, "2-my-cloud-after-waking.png"));
    world.account.power = null;
  }, hostTimeout(180_000));

  it("a lapsed cookie signs in again by itself, with no pairing page, back where it was", async () => {
    await world.home.show();
    await onCloudPage();
    const sessions = (await fx.onCloud("GET", "/api/auth/sessions")).body.sessions as Array<{ id: string; label: string }>;
    const cookie = (await world.cloudCookies()).length;
    expect(cookie).toBeGreaterThan(0);
    for (const session of sessions.filter((entry) => !entry.label.startsWith("OpenMausBot app (Cloud)"))) await fx.onCloud("DELETE", `/api/auth/sessions/${session.id}`);
    expect(await page("fetch('/api/auth/session').then((response) => response.status)")).toBe(401);
    let formSeen = false;
    const watching = (async () => {
      const stop = Date.now() + 20_000;
      while (Date.now() < stop && !formSeen) { formSeen = await page<boolean>(PAIR_FORM).catch(() => false); await new Promise((resolve) => setTimeout(resolve, 40)); }
    })();
    world.window.webContents.reload();
    await until(() => page<string>("fetch('/api/auth/session').then((response) => response.json()).then((session) => session.kind)"), (kind) => kind === "session", 30_000, "a new session");
    await onCloudPage();
    formSeen = formSeen || await page<boolean>(PAIR_FORM);
    const stop = formSeen; formSeen = true; await watching;
    expect(stop, "the pairing form never showed").toBe(false);
    await world.window.screenshot(join(shots, "3-my-cloud-signed-in-again.png"));
  }, hostTimeout(120_000));

  it("an ended Admin grant with a lapsed session shows one Sign in, and My Cloud opens by itself once signed in", async () => {
    const sessions = (await fx.onCloud("GET", "/api/auth/sessions")).body.sessions as Array<{ id: string; label: string }>;
    for (const session of sessions.filter((entry) => !entry.label.startsWith("OpenMausBot app (Cloud)"))) await fx.onCloud("DELETE", `/api/auth/sessions/${session.id}`);
    world.account.state = { status: "reauth-required", message: "access-ended", account: { id: "acct-fixture", email: "person@example.test" }, lastPlan: { tier: "pro", active: true } };
    await blank();
    await world.home.show();
    await until(() => screen(), (value) => value === "signin");
    const buttons = await page<string[]>("[...document.querySelectorAll('button')].map((button) => button.textContent.trim())");
    expect(buttons).toEqual(["Sign in"]);
    await world.window.screenshot(join(shots, "4-sign-in.png"));
    await page("document.querySelector('button').click(), true");
    await until(async () => world.account.signIns.length, (count) => count === 1);
    expect(world.account.signIns).toEqual(["again"]);
    world.account.state = { status: "connected", account: { id: "acct-fixture", email: "person@example.test" }, entitlement: { plan: "pro", status: "active", expiresAt: null, version: 1 },
      machine: { status: "ready", origin: world.cloudOrigin } };
    await world.home.changed();
    await onCloudPage();
  }, hostTimeout(120_000));

  it("with the network down the offline screen shows within 3 s, and goes away by itself", async () => {
    await blank();
    world.network.down = true;
    const started = Date.now();
    void world.home.show();
    await until(() => screen(), (value) => value === "offline", 3_000, "the offline screen within 3 s");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await page<string>("document.body.innerText")).toContain("Can't reach My Cloud right now.");
    await world.window.screenshot(join(shots, "5-offline.png"));
    world.network.down = false;
    await onCloudPage();
    expect(await screen()).toBeNull();
    // A reload with the network gone fails to load My Cloud: the same screen, as quickly.
    world.network.down = true;
    const reloaded = Date.now();
    world.window.webContents.reload();
    await until(() => screen(), (value) => value === "offline", 3_000, "the offline screen after a failed load");
    expect(Date.now() - reloaded).toBeLessThan(3_000);
    world.network.down = false;
    await onCloudPage();
  }, hostTimeout(120_000));

  it("notifications are allowed for My Cloud's page and this computer's, never another server's", async () => {
    await onCloudPage();
    expect(await page("Notification.permission")).toBe("granted");
    await world.window.loadURL(`${world.otherOrigin}/`);
    await until(() => page<string>("document.title"), (title) => title === "Another server");
    expect(await page("Notification.permission")).toBe("denied");
    expect(Object.fromEntries(world.notifications)).toMatchObject({ [world.cloudOrigin]: true, [world.otherOrigin]: false });
    await world.home.show();
    await onCloudPage();
  }, hostTimeout(120_000));

  it("chat links and the Settings key open on My Cloud's page", async () => {
    await onCloudPage();
    expect(world.openLink(`openmausbot://bot/${nova}`)).toBe(true);
    await until(() => page<string | null>("document.querySelector('textarea[aria-label^=\"Message\"]')?.getAttribute('aria-label') ?? null"), (label) => label === "Message Nova", 20_000, "Nova's chat");
    expect(new URL(world.window.url).origin).toBe(world.cloudOrigin);
    await world.window.screenshot(join(shots, "6-chat-link.png"));
    world.window.webContents.send("app:open-settings");
    await until(() => page<boolean>("Boolean(document.querySelector('[role=dialog]'))"), Boolean, 20_000, "Settings");
    await world.window.screenshot(join(shots, "7-settings-key.png"));
    await page("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true");
  }, hostTimeout(120_000));

  it("a new version of My Cloud reloads its page at a quiet moment, and only then", async () => {
    await onCloudPage();
    await page("window.__sameLoad = true");
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(await page("window.__sameLoad === true"), "no reload while the version stays").toBe(true);
    await fx.relaunch({ kill: false, cloud: { OMB_APP_VERSION: "0.1.999" } });
    await until(() => page<boolean>("window.__sameLoad === true"), (same) => same === false, 30_000, "the page to reload");
    await onCloudPage();
    expect(await page("fetch('/.well-known/openmausbot/environment').then((response) => response.json()).then((env) => env.version)")).toBe("0.1.999");
  }, hostTimeout(180_000));

  // T3: the team switcher. The session lists a team; its Cloud is the team server at world.teamOrigin.
  const ACME = () => ({ id: "team-acme", name: "Acme", role: "admin", machine: { status: "ready", origin: world.teamOrigin } });
  const onTeamPage = () => until(() => page<boolean>("Boolean(document.querySelector('textarea[aria-label^=\"Message\"]'))"), Boolean, 60_000, "the team's page")
    .then(() => expect(new URL(world.window.url).origin).toBe(world.teamOrigin));
  const homeLine = () => page<string | null>("document.querySelector('[data-home-line]')?.textContent ?? null");
  const bridgeState = () => page<Record<string, unknown>>("window.ogb.workspaces.state()");

  it("with a team in the session the switcher lists My Cloud and Acme; choosing Acme pairs through the Admin's team route, opens the team's page, and is remembered after a relaunch", async () => {
    await onCloudPage();
    expect((await bridgeState()).home, "My Cloud alone: no switcher").toBe(true);
    world.account.state.teams = [ACME()];
    await world.sync();
    await onCloudPage();
    expect(world.menu().map((item) => [item.label, item.sublabel])).toEqual([["My Cloud", new URL(world.cloudOrigin).host], ["Acme", "Admin"]]);
    expect((await bridgeState()).home, "two places: the switcher shows").toBeUndefined();
    expect(await homeLine()).toBeNull();
    await world.home.show({ place: { team: "team-acme" } });
    await onTeamPage();
    expect(world.admin.teamPairings).toEqual(["team-acme"]);
    expect(world.places.remembered()).toMatchObject({ team: "team-acme", name: "Acme", origin: world.teamOrigin });
    expect(await bridgeState()).toMatchObject({ local: false, name: "Acme", origin: world.teamOrigin, role: "Admin" });
    // Who sees private chats is said by the team's own page, in the chat (T2); the window adds no line of its own.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await homeLine()).toBeNull();
    expect(await page("Notification.permission"), "notifications on the team's page").toBe("granted");
    await world.window.screenshot(join(shots, "8-team-first-open.png"));
    // Relaunch: the team again, on the window's own session, no new pairing, no line.
    await blank();
    await world.launch();
    await onTeamPage();
    expect(world.admin.teamPairings).toEqual(["team-acme"]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await homeLine()).toBeNull();
    await until(async () => world.splash?.destroyed ?? true, Boolean, 15_000, "the startup screen to close");
  }, hostTimeout(180_000));

  it("a lapsed cookie on the team's page signs in again through the team route, and the team's Cloud being unreachable shows the screen named Acme while My Cloud keeps working", async () => {
    await onTeamPage();
    const sessions = (await fx.onCloud("GET", "/api/auth/sessions")).body.sessions as Array<{ id: string; label: string }>;
    // The window's sessions (the page labels them itself); the fixture's own owner sessions stay.
    for (const session of sessions.filter((entry) => !entry.label.startsWith("OpenMausBot app (Cloud)"))) await fx.onCloud("DELETE", `/api/auth/sessions/${session.id}`);
    expect(await page("fetch('/api/auth/session').then((response) => response.status)")).toBe(401);
    const pairings = world.admin.teamPairings.length;
    world.window.webContents.reload();
    await until(() => page<string>("fetch('/api/auth/session').then((response) => response.json()).then((session) => session.kind)"), (kind) => kind === "session", 30_000, "a new team session");
    await onTeamPage();
    expect(world.admin.teamPairings.slice(pairings)).toEqual(["team-acme"]);
    await blank();
    world.network.teamDown = true;
    void world.home.show({ place: { team: "team-acme" } });
    await until(() => screen(), (value) => value === "offline", 3_000, "the offline screen within 3 s");
    expect(await page<string>("document.body.innerText")).toContain("Can't reach Acme right now.");
    await world.window.screenshot(join(shots, "9-team-offline.png"));
    await world.home.show({ place: "cloud" });
    await onCloudPage();
    world.network.teamDown = false;
    await world.home.show({ place: { team: "team-acme" } });
    await onTeamPage();
  }, hostTimeout(180_000));

  it("signed out, the team shows one Sign in named Acme", async () => {
    const signedIn = world.account.state, pairings = world.admin.teamPairings.length;
    world.account.state = { status: "signed-out" };
    try {
      await blank();
      await world.home.show({ place: { team: "team-acme" } });
      await until(() => screen(), (value) => value === "signin");
      expect(await page<string>("document.body.innerText")).toContain("Sign in to open Acme");
      expect(world.admin.teamPairings.length, "no pairing asked while signed out").toBe(pairings);
    } finally { world.account.state = signedIn; }
  }, hostTimeout(60_000));

  it("on the team's page the window signs in again before the hour is out without moving the page; the Admin refusing that (removed) drops Acme at once", async () => {
    await world.home.show({ place: { team: "team-acme" } });
    await onTeamPage();
    await page("window.__samePage = true");
    const before = (await world.cloudCookies()).length, pairings = world.admin.teamPairings.length;
    const sessions = async () => (await fx.onCloud("GET", "/api/auth/sessions")).body.sessions as Array<{ id: string; label: string }>;
    const known = (await sessions()).map((entry) => entry.id);
    await world.home.renew();
    expect(world.admin.teamPairings.slice(pairings)).toEqual(["team-acme"]);
    const after = await sessions();
    expect(after.filter((entry) => !known.includes(entry.id)).length, "a new session, made in the background").toBe(1);
    // The window's older sessions end (the fixture's own owner session stays): the page keeps working on the new one.
    for (const entry of after) if (known.includes(entry.id) && !entry.label.startsWith("OpenMausBot app (Cloud)")) await fx.onCloud("DELETE", `/api/auth/sessions/${entry.id}`);
    expect(await page("fetch('/api/auth/session').then((response) => response.json()).then((session) => session.kind)")).toBe("session");
    expect(await page("window.__samePage === true"), "the page never moved").toBe(true);
    expect(new URL(world.window.url).origin).toBe(world.teamOrigin);
    expect((await world.cloudCookies()).length).toBe(before);
    // Removed on the Admin while the session still lists Acme: the next renewal is refused, and Acme goes now.
    world.admin.removed.add("team-acme");
    await world.home.renew();
    await onCloudPage();
    await until(() => homeLine(), (text) => text === "You're no longer in Acme.", 20_000, "the one line");
    expect(world.menu().map((item) => item.label), "gone from the switcher at once").toEqual(["My Cloud"]);
    expect(world.places.remembered()).toBeNull();
    world.admin.removed.clear();
    await world.sync();
    expect(world.menu().map((item) => item.label), "the session still lists Acme: back").toEqual(["My Cloud", "Acme"]);
  }, hostTimeout(180_000));

  it("removed from the team: after the next session check Acme is gone from the switcher, My Cloud opens, and one line says so", async () => {
    await world.home.show({ place: { team: "team-acme" } });
    await onTeamPage();
    world.account.state.teams = [];
    await world.sync();
    await onCloudPage();
    await until(() => homeLine(), (text) => text === "You're no longer in Acme.", 20_000, "the one line");
    await world.window.screenshot(join(shots, "10-team-left.png"));
    expect(world.environments().environments.some((entry: any) => entry.team)).toBe(false);
    expect(world.menu().map((item) => item.label)).toEqual(["My Cloud"]);
    expect(world.places.remembered()).toBeNull();
    expect((await bridgeState()).home, "My Cloud alone again: no switcher").toBe(true);
    world.window.webContents.reload();
    await onCloudPage();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await homeLine(), "said once").toBeNull();
    delete world.account.state.teams;
  }, hostTimeout(180_000));
});
