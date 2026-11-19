import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";
import { fixtureApi } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(binary);
if (!enabled) console.info("skipping Team map computers UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

type Info = { ui: string; url: string; dataDir: string; logPath: string; boatFixtureApi: string; botId: string; botIds: string[] };
type Receipts = { calls: Array<{ method: string; path: string }>; shots: Record<string, number>; boats: Array<{ id: string; state: string }> };

(enabled ? it : it.skip)("shows every bot's computer live on the Team map within the frame budget, and never wakes one", async () => {
  let child: ChildProcess | undefined;
  let info: Info | undefined;
  const evidence: Record<string, unknown> = {};
  try {
    let stdout = "", stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/testing/team-computers-preview.ts"), "--map"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", error => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`Team map fixture exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Array.isArray(info?.botIds); } catch { return false; }
    }, { timeout: binary ? 180_000 : 600_000, interval: 250 }).toBe(true);
    const fixture = info!;
    const provider = fixtureApi(fixture.boatFixtureApi);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", fixture.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const receipts = async () => await provider("GET", "/__fixture") as Receipts;
    const lifecycle = (calls: Receipts["calls"]) => calls.filter((call) => call.method !== "GET" && !call.path.endsWith("/commands"));
    const shots = async () => Object.values((await receipts()).shots).reduce((sum, count) => sum + count, 0);
    const screens = () => evaluate("[...document.querySelectorAll('[data-computer-node]')].map(node => ({ id: node.dataset.computerNode, src: node.querySelector('img')?.getAttribute('src') ?? null, text: node.textContent }))") as Promise<Array<{ id: string; src: string | null; text: string }>>;
    const press = (label: string) => evaluate(`(() => { const target = [...document.querySelectorAll('button, a, [role=menuitem]')].find(button => button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.textContent.trim() === ${JSON.stringify(label)}); target?.click(); return Boolean(target); })()`);
    const openMap = async () => {
      await expect.poll(snapshot, { timeout: 15_000 }).toContain("Iris");
      if (!await press("Team map")) await press("Tools");
      await expect.poll(() => snapshot().then((text) => text.includes('region "Team canvas"') || press("Team map").then(() => false)), { timeout: 15_000 }).toBe(true);
    };

    const before = await receipts();
    expect(before.calls.some((call) => call.path.endsWith("/artifacts"))).toBe(false);
    await evaluate("location.reload(); true");
    await openMap();

    // 13 bots with their own computer and the Ops team's shared one; the asleep one is never captured.
    await expect.poll(async () => (await screens()).length, { timeout: 20_000 }).toBe(14);
    await expect.poll(async () => (await screens()).filter((screen) => screen.src?.startsWith("blob:")).length, { timeout: 30_000 }).toBe(13);
    const asleep = (await screens()).find((screen) => screen.src === null)!;
    expect(asleep.id).toBe(fixture.botIds[7]);
    expect(asleep.text).toContain("Asleep");
    const archived = (await receipts()).boats.filter((boat) => boat.state === "archived").map((boat) => boat.id);
    expect(archived).toHaveLength(1);
    expect((await receipts()).shots[archived[0]]).toBeUndefined();

    // Live: the screens change while the map is open, and all of them together stay under four captures a second.
    const first = new Map((await screens()).map((screen) => [screen.id, screen.src]));
    const startedAt = Date.now(), startShots = await shots();
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const elapsed = (Date.now() - startedAt) / 1_000, taken = (await shots()) - startShots;
    expect(taken).toBeGreaterThan(10);
    expect(taken).toBeLessThanOrEqual(4 * elapsed + 6);
    const changed = (await screens()).filter((screen) => screen.src && screen.src !== first.get(screen.id));
    expect(changed.length).toBeGreaterThan(5);
    expect(lifecycle((await receipts()).calls)).toEqual(lifecycle(before.calls));
    await ui("screenshot", "--out", `${fixture.logPath}.team-map-computers.png`);

    // The switch hides them, and the choice survives a reload.
    expect(await press("Show screens")).toBe(true);
    await expect.poll(async () => (await screens()).length).toBe(0);
    await evaluate("location.reload(); true");
    await openMap();
    // The server stops capturing a few seconds after the last map request.
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    expect(await screens()).toHaveLength(0);
    const quiet = await shots();
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    expect(await shots()).toBe(quiet);
    expect(await press("Show screens")).toBe(true);
    await expect.poll(async () => (await screens()).length, { timeout: 20_000 }).toBe(14);

    // The map's composer: nothing goes out without a tag; each tagged bot gets one normal message in its own chat.
    const api = fixtureApi(fixture.url);
    const said = async (text: string) => Object.fromEntries(((await api("GET", "/api/bots?messages=20")).bots as Array<{ name: string; messages: Array<{ role: string; text?: string }> }>)
      .map((bot) => [bot.name, bot.messages.filter((message) => message.role === "user" && message.text === text).length]));
    const sendButton = () => evaluate("document.querySelector('button[aria-label=\"Send to tagged bots\"]')?.disabled");
    await ui("type", "--name", "Message bots on the map", "--text", "status check");
    expect(await sendButton()).toBe(true);
    expect(await snapshot()).toContain("Tag a bot with @ to send");
    await ui("press", "--keys", "Enter");
    expect(Object.values(await said("status check")).every((count) => count === 0)).toBe(true);
    await evaluate("(() => { const box = document.querySelector('textarea[aria-label=\"Message bots on the map\"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ''); box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
    await ui("type", "--name", "Message bots on the map", "--text", "@Jonah and @Pepper please report in");
    await expect.poll(sendButton).toBe(false);
    expect(await snapshot()).toContain("Goes to 2 tagged bots");
    // On Send only the tagged cards acknowledge it, with a border that fades.
    const acknowledged = () => evaluate("[...document.querySelectorAll('[data-sent-highlight]')].map(node => node.closest('article')?.querySelector('[data-bot-id]')?.dataset.botId).sort()");
    await ui("press", "--keys", "Enter");
    await expect.poll(acknowledged, { timeout: 1_300, interval: 50 }).toEqual([fixture.botIds[3], fixture.botId].sort());
    await expect.poll(acknowledged, { timeout: 5_000 }).toEqual([]);
    await expect.poll(async () => (await said("@Jonah and @Pepper please report in"))).toMatchObject({ Jonah: 1, Pepper: 1 });
    const counts = await said("@Jonah and @Pepper please report in");
    expect(Object.entries(counts).filter(([, count]) => count > 0).map(([name]) => name).sort()).toEqual(["Jonah", "Pepper"]);
    await expect.poll(snapshot).toContain("Sent to");

    // Clicking a computer opens that bot's computer view beside the map.
    expect(await press("Open Theo's desktop (Working)")).toBe(true);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Theo's screen");
    expect(await snapshot()).toContain('region "Team canvas"');
    Object.assign(evidence, { receipts: await receipts(), screens: await screens() });
  } finally {
    try {
      if (info) {
        const path = `${info.logPath}.team-map-computers.json`;
        writeFileSync(path, JSON.stringify({ fixture: info, ...evidence }, null, 2), { mode: 0o600 });
        console.info(JSON.stringify({ evidence: path }));
      }
    } finally {
      await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
      if (info) expect(existsSync(info.dataDir)).toBe(false);
    }
  }
}, binary ? 300_000 : 720_000);
