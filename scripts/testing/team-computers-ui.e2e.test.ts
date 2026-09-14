import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
if (!enabled) console.info("skipping team computers UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

type Info = { ui: string; url: string; botId: string; dataDir: string; logPath: string; boxFixtureApi: string };
type Computer = { id: string; name: string; section: string | null; state: string; problem?: string; held?: boolean };

(enabled ? it : it.skip)("creates and assigns a shared computer only after explicit UI actions", async () => {
  let child: ChildProcess | undefined;
  let info: Info | undefined;
  const evidence: Record<string, unknown> = { input: "real accessible clicks/keys; computer drag uses synthetic PointerEvents and native select changes use DOM events" };
  try {
    let stdout = "", stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/testing/team-computers-preview.ts")], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", error => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`Computer UI fixture exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: binary ? 180_000 : 600_000, interval: 250 }).toBe(true);
    const fixture = info!;
    const api = fixtureApi(fixture.url);
    const provider = fixtureApi(fixture.boxFixtureApi);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", fixture.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const ref = async (name: string, role?: string) => {
      let match: [string, unknown] | undefined;
      await expect.poll(async () => {
        const refs = (await ui("snapshot")).refs as Record<string, { name: string; role: string }>;
        const matches = Object.entries(refs).filter(([, entry]) => entry.name === name && (role ? entry.role === role : ["button", "menuitem"].includes(entry.role)));
        match = matches[0]; return matches.length;
      }, { timeout: 10_000, message: `${role} ${name}` }).toBe(1);
      return `@${match![0]}`;
    };
    const click = async (name: string, role?: string) => ui("click", "--ref", await ref(name, role));
    const computers = async (): Promise<Computer[]> => (await api("GET", "/api/team-computers")).computers;
    const record = async (id: string) => (await computers()).find(computer => computer.id === id);
    const receipts = () => provider("GET", "/__fixture");
    const focused = () => evaluate("document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim()");
    const openMap = async () => { await click("Tools"); await click("Team map"); await expect.poll(snapshot).toContain('region "Team canvas"'); };
    await api("PATCH", `/api/bots/${fixture.botId}`, { name: "Ada", section: "Engineering", computer: "off" });
    await api("POST", "/api/sidebar-sections", { name: "Research" });
    await api("POST", "/api/bots", { name: "Ben", section: "Research", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    const before = (await api("GET", "/api/bots?messages=10")).bots;
    await evaluate("location.reload(); true");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Actions for Ada");
    await openMap();
    await click("Computers");
    await expect.poll(snapshot).toContain('complementary "Team computers"');
    expect((await receipts()).calls.every((call: { method: string }) => call.method === "GET")).toBe(true);
    await click("Close computers");
    // Native <summary> appears in AX but agent-browser does not assign a ref.
    await evaluate("document.querySelector('summary[aria-label=\"Add to team map\"]').focus(); true");
    await ui("press", "--keys", "Enter");
    await click("Box computer");
    await expect.poll(() => evaluate("document.activeElement?.id")).toBe("canvas-computer-name");
    expect(await snapshot()).toContain("Your Box plan and usage charges apply");
    expect(await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Create Box')?.disabled")).toBe(true);
    await ui("type", "--ref", await ref("New Box computer", "textbox"), "--text", "Engineering desktop");
    expect((await receipts()).calls.every((call: { method: string }) => call.method === "GET")).toBe(true);
    await click("Create Box");
    await expect.poll(async () => (await computers()).length, { timeout: 30_000 }).toBe(1);
    const machine = (await computers())[0];
    await expect.poll(async () => (await record(machine.id))?.state).toBe("idle");
    expect(machine.section).toBeNull();
    await expect.poll(snapshot).toContain("Engineering desktop");
    expect((await receipts()).calls.filter((call: { method: string; path: string }) => call.method === "POST" && call.path === "/boxes")).toHaveLength(1);

    const drag = (section: string, cancel = false) => evaluate(`(async () => {
      const source = document.querySelector('[data-computer-drag-id="${machine.id}"]');
      const target = document.querySelector(${JSON.stringify(`[data-team-key=${JSON.stringify(section)}]`)});
      if (!source || !target) throw new Error('missing computer or team drag target');
      const rect = source.getBoundingClientRect(), destination = target.getBoundingClientRect();
      const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const to = { x: destination.left + destination.width / 2, y: destination.top + destination.height / 2 };
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const patched = ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'].map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        Object.defineProperty(source, key, { configurable: true, value: () => key === 'hasPointerCapture' });
        return () => descriptor ? Object.defineProperty(source, key, descriptor) : delete source[key];
      });
      const dispatch = (type, point, buttons) => source.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 6, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: point.x, clientY: point.y,
      }));
      try {
        dispatch('pointerdown', from, 1); await frame();
        for (let step = 1; step <= 5; step++) {
          dispatch('pointermove', { x: from.x + (to.x - from.x) * step / 5, y: from.y + (to.y - from.y) * step / 5 }, 1); await frame();
        }
        dispatch(${cancel} ? 'pointercancel' : 'pointerup', to, 0); await frame();
        return source.dataset.computerDragId;
      } finally { patched.forEach(restore => restore()); }
    })()`);
    await drag("Engineering", true);
    expect((await record(machine.id))?.section).toBeNull();
    expect(await evaluate("document.querySelectorAll('[data-computer-dropping]').length")).toBe(0);
    expect(await drag("Engineering")).toBe(machine.id);
    await expect.poll(snapshot).toContain('alertdialog "Assign Engineering desktop to Engineering?"');
    expect(await focused()).toBe("Cancel");
    expect((await record(machine.id))?.section).toBeNull();
    await ui("press", "--keys", "Escape");
    expect((await record(machine.id))?.section).toBeNull();
    await drag("Engineering");
    await expect.poll(focused).toBe("Cancel");
    await ui("press", "--keys", "Tab");
    expect(await focused()).toBe("Assign computer");
    await ui("press", "--keys", "Enter");
    await expect.poll(async () => (await record(machine.id))?.section).toBe("Engineering");
    await expect.poll(snapshot).toContain("Computer for Engineering team: Engineering desktop");
    await drag("Research");
    await expect.poll(snapshot).toContain("Unassign Engineering desktop from Engineering before moving");
    expect((await record(machine.id))?.section).toBe("Engineering");

    // Exercise the native select's change handler; popup keyboard behavior
    // varies by OS, while confirmation still uses real accessible controls.
    const selectTeam = async (value: string) => {
      await expect.poll(() => evaluate(`document.getElementById('computer-team-${machine.id}')?.disabled`)).toBe(false);
      await expect.poll(() => evaluate(`[...document.getElementById('computer-team-${machine.id}').options].some(option => option.value === ${JSON.stringify(value)})`)).toBe(true);
      await evaluate(`(() => { const select = document.getElementById('computer-team-${machine.id}');
        select.focus(); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); return select.value; })()`);
    };
    await selectTeam("unassigned");
    await expect.poll(snapshot).toContain('alertdialog "Unassign Engineering desktop?"');
    await click("Unassign computer");
    await expect.poll(async () => (await record(machine.id))?.section).toBeNull();
    await selectTeam("team:Research");
    await expect.poll(snapshot).toContain('alertdialog "Assign Engineering desktop to Research?"');
    await click("Assign computer");
    await expect.poll(async () => (await record(machine.id))?.section).toBe("Research");
    expect((await api("GET", "/api/bots?messages=10")).bots).toEqual(before);
    expect(JSON.parse(readFileSync(join(fixture.dataDir, "team-computers.json"), "utf8")).computers)
      .toContainEqual(expect.objectContaining({ id: machine.id, section: "Research", name: machine.name }));
    await click("Close computers");
    await click("Open chat with Ben");
    await click("Bot's computer");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Team default");
    expect(await snapshot()).toContain("Engineering desktop");
    expect(await snapshot()).not.toContain("Choose Cloud");
    await click("Open Team map");
    expect((await receipts()).calls.filter((call: { method: string; path: string }) => call.method === "POST" && call.path === "/boxes")).toHaveLength(1);
    await evaluate("location.reload(); true");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Actions for Ada");
    await openMap();
    await expect.poll(snapshot).toContain("Computer for Research team: Engineering desktop");
    await click("Computer for Research team: Engineering desktop");
    await click("Open desktop");
    await expect.poll(snapshot).toContain("Open secure desktop");
    expect((await record(machine.id))?.held).toBe(true);
    const secureLink = await evaluate("[...document.querySelectorAll('a')].find(link => link.textContent.includes('Open secure desktop'))?.href");
    expect(secureLink).toMatch(/^https:\/\/desktop\.invalid\/bx_/);
    await click("Return to bots");
    await expect.poll(async () => (await record(machine.id))?.held === true).toBe(false);
    await click("Sleep");
    await expect.poll(async () => (await record(machine.id))?.state).toBe("archived");
    await provider("POST", "/__fixture", { refuseCreate: true });
    await click("New Box computer");
    await ui("type", "--ref", await ref("New Box computer", "textbox"), "--text", "Retry desktop");
    await click("Create Box");
    await expect.poll(snapshot, { timeout: 20_000 }).toContain("Fixture account is rate-limited");
    const retry = (await computers()).find(computer => computer.name === "Retry desktop")!;
    expect(retry).toBeDefined();
    expect(retry.section).toBeNull();
    await provider("POST", "/__fixture", { refuseCreate: false });
    // Reusing the still-open creation form retries the durable request ID.
    await click("Create Box");
    await expect.poll(async () => (await record(retry.id))?.state, { timeout: 30_000 }).toBe("idle");
    expect(await computers()).toHaveLength(2);
    const providerResult = await receipts();
    expect(providerResult.boxes).toHaveLength(2);
    expect(providerResult.calls.some((call: { method: string }) => call.method === "DELETE")).toBe(false);
    Object.assign(evidence, { computers: await computers(), provider: providerResult, finalSnapshot: await snapshot() });
    await ui("screenshot", "--out", `${fixture.logPath}.team-computers.png`);
  } finally {
    if (info) {
      try { evidence.finalUi = await runControlOmb(["ui", "snapshot", "--ui", info.ui]); } catch { /* keep original failure */ }
      const path = `${info.logPath}.team-computers.json`;
      writeFileSync(path, JSON.stringify({ fixture: info, ...evidence }, null, 2));
      console.info(JSON.stringify({ evidence: path }));
    }
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, binary ? 300_000 : 720_000);
