import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
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
if (!enabled) console.info("skipping team canvas UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

type BotRecord = {
  id: string; name: string; title?: string; section?: string; threadId: string;
  modelSelection: { instanceId: string; model: string; effort?: string };
  tasks: Array<{ threadId: string; title: string; modelSelection?: unknown }>;
};

(enabled ? it : it.skip)("edits and arranges the team canvas without losing bots or conversations", async () => {
  let child: ChildProcess | undefined;
  let info: { ui: string; url: string; botId: string; logPath: string } | undefined;
  const receipts: Record<string, unknown> = { pointerInput: "synthetic DOM events; native pointer capture is not proven" };
  try {
    let stdout = "", stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", error => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: binary ? 180_000 : 600_000, interval: 250 }).toBe(true);
    const fixture = info!;
    const api = fixtureApi(fixture.url);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", fixture.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const focused = () => evaluate("document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim()");
    const tabTo = async (name: string) => {
      for (let step = 0; step < 16; step++) {
        if (await focused() === name) return;
        await ui("press", "--keys", "Tab");
      }
      throw new Error(`Keyboard focus did not reach ${name}; focused ${await focused()}`);
    };
    const click = async (name: string, role?: string) => {
      let matches: Array<[string, { name: string; role: string }]> = [];
      await expect.poll(async () => {
        const refs = (await ui("snapshot")).refs as Record<string, { name: string; role: string }>;
        matches = Object.entries(refs).filter(([, entry]) => (role ? entry.role === role : ["button", "menuitem"].includes(entry.role)) && entry.name === name);
        return matches.length;
      }, { timeout: 10_000, message: `one ${role ?? "button/menuitem"} named ${name}` }).toBe(1);
      await ui("click", "--ref", `@${matches[0][0]}`);
    };
    const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.url]) as Promise<any>;
    const bots = async (): Promise<BotRecord[]> => (await api("GET", "/api/bots?messages=0")).bots;
    const savedBot = async (id: string) => (await bots()).find(bot => bot.id === id)!;
    const identity = (bot: BotRecord) => ({ id: bot.id, name: bot.name, title: bot.title, threadId: bot.threadId,
      modelSelection: bot.modelSelection, tasks: bot.tasks.map(task => ({ threadId: task.threadId, title: task.title, modelSelection: task.modelSelection })) });
    const teamSelector = (name: string) => `[data-team-key=${JSON.stringify(name)}]`;
    const cardOrder = (name: string) => evaluate(`[...document.querySelectorAll(${JSON.stringify(`${teamSelector(name)} [data-bot-id]`)})].map(card => card.dataset.botId)`);
    const manage = (name: string) => evaluate(`(() => {
      const summary = document.querySelector(${JSON.stringify(`${teamSelector(name)} summary`)});
      if (!summary) throw new Error('Missing team controls');
      if (!summary.parentElement.open) summary.click();
      return summary.parentElement.open;
    })()`);
    const messages = async (id: string) => (await control("messages", "--bot", id, "--limit", "10")).messages;
    const openMap = async () => {
      await click("Tools");
      await click("Team map");
      await expect.poll(() => evaluate("Boolean(document.querySelector('[data-team-canvas]'))"), { timeout: 10_000 }).toBe(true);
    };
    const teamPosition = (name: string) => evaluate(`(() => {
      const team = document.querySelector(${JSON.stringify(teamSelector(name))});
      return { x: parseFloat(team.style.left), y: parseFloat(team.style.top) };
    })()`);
    const view = () => evaluate(`(() => {
      const canvas = document.querySelector('[data-team-canvas]');
      const world = canvas.querySelector('[data-canvas-world]');
      if (!world) throw new Error('Missing transformed canvas world');
      const matrix = new DOMMatrix(getComputedStyle(world).transform);
      return { x: matrix.m41, y: matrix.m42, scale: matrix.m11 };
    })()`);
    const drag = (selector: string, delta: { x: number; y: number }, destination?: string, cancel = false) => evaluate(`(async () => {
      const source = document.querySelector(${JSON.stringify(selector)});
      const canvas = document.querySelector('[data-team-canvas]');
      if (!source || !canvas) throw new Error('Missing drag surface');
      const rect = source.getBoundingClientRect();
      const from = source === canvas ? { x: rect.left + 8, y: rect.top + 8 }
        : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const target = ${JSON.stringify(destination ?? null)};
      const targetRect = target ? document.querySelector(target)?.getBoundingClientRect() : null;
      if (target && !targetRect) throw new Error('Missing drop target');
      const to = targetRect ? { x: targetRect.left + targetRect.width / 2 + ${delta.x}, y: targetRect.top + targetRect.height / 2 + ${delta.y} }
        : { x: from.x + ${delta.x}, y: from.y + ${delta.y} };
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      // Synthetic pointer IDs cannot acquire native capture. Deliver events
      // to the source as capture would, and restore the fixture DOM methods.
      const patched = [...new Set([source, canvas])].flatMap(element =>
        ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'].map(key => {
          const descriptor = Object.getOwnPropertyDescriptor(element, key);
          Object.defineProperty(element, key, { configurable: true, value: () => key === 'hasPointerCapture' });
          return () => descriptor ? Object.defineProperty(element, key, descriptor) : delete element[key];
        }));
      const dispatch = (type, point, buttons) => source.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons, clientX: point.x, clientY: point.y,
      }));
      try {
        dispatch('pointerdown', from, 1);
        await frame();
        for (let step = 1; step <= 5; step++) {
          dispatch('pointermove', { x: from.x + (to.x - from.x) * step / 5, y: from.y + (to.y - from.y) * step / 5 }, 1);
          await frame();
        }
        if (${cancel}) canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        else dispatch('pointerup', to, 0);
        source.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: to.x, clientY: to.y }));
        await frame();
        return { from, to };
      } finally { patched.forEach(restore => restore()); }
    })()`);

    await api("PATCH", `/api/bots/${fixture.botId}`, { name: "Ada", section: "Engineering", chiefOfStaff: true });
    const ben: BotRecord = (await api("POST", "/api/bots", { name: "Ben", title: "Build and review", section: "Engineering",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).bot;
    const cleo: BotRecord = (await api("POST", "/api/bots", { name: "Cleo", title: "Research coordinator", section: "Research",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" } })).bot;
    await api("PATCH", `/api/bots/${cleo.id}`, { chiefOfStaff: true });
    const dana: BotRecord = (await api("POST", "/api/bots", { name: "Dana", title: "Find supporting evidence", section: "Research",
      modelSelection: { instanceId: "qwen", model: "qwen3-coder-plus" } })).bot;
    await api("POST", "/api/sidebar-sections", { name: "Delivery" });
    await api("PUT", "/api/section-context?section=Engineering", { text: "Keep the original engineering brief." });
    await api("PUT", "/api/section-context?section=Research", { text: "Keep the original research brief." });
    await api("PUT", "/api/section-context?section=Delivery", { text: "Review before shipping." });
    await control("send", "--bot", ben.id, "--text", "Remember this conversation when the team changes.");
    expect(await control("wait", "--bot", ben.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    const transcript = await messages(ben.id);
    const beforeBots = await bots();
    receipts.beforeBots = beforeBots.map(identity);
    receipts.transcript = transcript;
    await evaluate("location.reload(); true");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Actions for Ada");
    await openMap();
    await expect.poll(() => evaluate("[...document.querySelectorAll('[data-team-key]')].map(team => team.dataset.teamKey)"))
      .toEqual(expect.arrayContaining(["Engineering", "Research", "Delivery"]));
    expect(await snapshot()).toContain('region "Team canvas"');
    for (const name of ["Ada", "Ben", "Cleo", "Dana"]) expect(await snapshot()).toContain(`Change default model for ${name}`);
    expect(await evaluate("[...document.querySelectorAll('[data-team-key] article span')].some(span => span.textContent.trim() === 'Ready')")).toBe(false);
    expect(await evaluate("document.querySelectorAll('[data-team-canvas] [aria-label^=\"Computer for \"]').length")).toBe(0);

    // The full-app fixture has no Box credentials. The explicit + entry
    // explains paid creation, but cannot allocate anything until connected.
    const beforeComputers = await api("GET", "/api/team-computers");
    expect(beforeComputers.configured).toBe(false);
    await evaluate("document.querySelector('summary[aria-label=\"Add to team map\"]').focus(); true");
    await ui("press", "--keys", "Enter");
    await click("Box computer");
    await expect.poll(snapshot).toContain("Connect your Box account before creating a cloud computer.");
    expect(await snapshot()).toContain("Your Box plan and usage charges apply.");
    const inputRefs = (await ui("snapshot")).refs as Record<string, { role: string; name: string }>;
    const nameInput = Object.entries(inputRefs).filter(([, entry]) => entry.role === "textbox" && entry.name === "New Box computer");
    expect(nameInput).toHaveLength(1);
    await ui("type", "--ref", `@${nameInput[0][0]}`, "--text", "Fixture desktop");
    expect(await evaluate("document.querySelector('[aria-label=\"Team computers\"] button[type=submit]').disabled")).toBe(true);
    expect((await api("GET", "/api/team-computers")).computers).toEqual(beforeComputers.computers);
    await click("Cancel");
    await click("Close computers");
    expect(await evaluate("Boolean(document.querySelector('[aria-label=\"Team computers\"]'))")).toBe(false);
    receipts.unconfiguredComputerCreation = "Explicit Add entry shows cost disclosure and keeps Create Box disabled without credentials.";

    await evaluate(`(() => {
      const card = document.querySelector(${JSON.stringify(`[data-bot-id=${JSON.stringify(ben.id)}]`)});
      const rect = card.getBoundingClientRect();
      const options = { bubbles: true, pointerId: 9, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      card.dispatchEvent(new PointerEvent('pointerdown', options));
      card.dispatchEvent(new PointerEvent('pointerout', { ...options, relatedTarget: document.body }));
      return true;
    })()`);
    await click("Edit Ben");
    await expect.poll(snapshot).toContain('dialog "Ben"');
    expect(await evaluate("Boolean(document.querySelector('[data-team-canvas]'))")).toBe(true);
    await expect.poll(() => evaluate("[...document.querySelectorAll('[data-team-canvas] [aria-label^=\"Computer for \"]')].map(button => button.getAttribute('aria-label'))"))
      .toEqual(["Computer for Ben"]);
    await click("Computer for Ben");
    await expect.poll(() => evaluate("document.querySelector('[data-bot-settings-section=access] > button')?.getAttribute('aria-expanded')")).toBe("true");
    await click("Close settings");
    await expect.poll(() => evaluate("document.querySelectorAll('[data-team-canvas] [aria-label^=\"Computer for \"]').length")).toBe(0);
    await click("Change default model for Ben");
    await expect.poll(() => evaluate("document.querySelector('[data-bot-settings-section=model] > button')?.getAttribute('aria-expanded')")).toBe("true");
    expect(await snapshot()).toContain("Default model");
    expect(await evaluate("Boolean(document.querySelector('[data-team-canvas]'))")).toBe(true);
    await click("Close settings");

    // Membership changes go through the real dialog and server. A failed
    // mixed-Chief move must preserve every selected bot's original team.
    await manage("Delivery");
    await click("Move bots to Delivery");
    await click("Ben", "checkbox");
    await click("Dana", "checkbox");
    await click("Move 2 bots");
    await expect.poll(async () => (await bots()).filter(bot => bot.section === "Delivery").map(bot => bot.id).sort())
      .toEqual([ben.id, dana.id].sort());
    await expect.poll(() => evaluate(`document.querySelectorAll(${JSON.stringify(`${teamSelector("Delivery")} [data-bot-id]`)}).length`)).toBe(2);
    expect(await messages(ben.id)).toEqual(transcript);
    for (const before of beforeBots) expect(identity(await savedBot(before.id))).toEqual(identity(before));
    await manage("Engineering");
    await click("Move bots to Engineering");
    await click("Cleo", "checkbox");
    await click("Dana", "checkbox");
    await click("Move 2 bots");
    await expect.poll(snapshot).toContain("A team can have only one Chief of Staff");
    expect((await savedBot(cleo.id)).section).toBe("Research");
    expect((await savedBot(dana.id)).section).toBe("Delivery");
    await click("Close team dialog");
    await expect.poll(focused).toBe("Manage Engineering team");
    await evaluate("document.querySelectorAll('[data-team-key] details').forEach(details => { details.open = false; }); true");

    // General has an empty persisted section key. Its menu, picker and Save
    // are keyboard accessible, and closing the dialog restores its summary.
    await evaluate(`document.querySelector(${JSON.stringify(`${teamSelector("")} summary`)}).focus(); true`);
    await ui("press", "--keys", "Enter");
    await tabTo("Move bots to General");
    await ui("press", "--keys", "Enter");
    await expect.poll(snapshot).toContain('dialog "Move bots to General"');
    await tabTo("Dana");
    await ui("press", "--keys", "Space");
    await tabTo("Move 1 bot");
    await ui("press", "--keys", "Enter");
    await expect.poll(async () => (await savedBot(dana.id)).section ?? "").toBe("");
    await expect.poll(focused).toBe("Manage General team");
    receipts.keyboardGeneralMove = { botId: dana.id, section: (await savedBot(dana.id)).section ?? "", restoredFocus: await focused() };
    expect(await evaluate("(() => { const canvas = document.querySelector('[data-team-canvas]'); return { x: canvas.scrollLeft, y: canvas.scrollTop }; })()"))
      .toEqual({ x: 0, y: 0 });
    await manage("Delivery");
    await click("Move bots to Delivery");
    await click("Dana", "checkbox");
    await click("Move 1 bot");
    await expect.poll(async () => (await savedBot(dana.id)).section).toBe("Delivery");
    expect(identity(await savedBot(dana.id))).toEqual(identity(beforeBots.find(bot => bot.id === dana.id)!));

    await click("Fit teams to view");
    const cardSelector = `[data-bot-id=${JSON.stringify(ben.id)}]`;
    receipts.cancelledDrop = await drag(cardSelector, { x: 0, y: 0 }, teamSelector("Research"));
    await expect.poll(snapshot).toContain('alertdialog "Move Ben to Research?"');
    expect(await snapshot()).toContain("This changes the bot's home team and shared instructions, not just its position.");
    expect((await savedBot(ben.id)).section).toBe("Delivery");
    await click("Cancel");
    await expect.poll(snapshot).not.toContain('alertdialog "Move Ben to Research?"');
    expect((await savedBot(ben.id)).section).toBe("Delivery");
    expect(await messages(ben.id)).toEqual(transcript);
    receipts.dropIntoResearch = await drag(cardSelector, { x: 0, y: 0 }, teamSelector("Research"));
    await expect.poll(snapshot).toContain('alertdialog "Move Ben to Research?"');
    expect((await savedBot(ben.id)).section).toBe("Delivery");
    await click("Move bot");
    await expect.poll(async () => (await savedBot(ben.id)).section).toBe("Research");
    await expect.poll(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`${teamSelector("Research")} ${cardSelector}`)}))`)).toBe(true);
    await click("Fit teams to view");
    receipts.dropIntoDelivery = await drag(cardSelector, { x: 0, y: 0 }, teamSelector("Delivery"));
    await expect.poll(snapshot).toContain('alertdialog "Move Ben to Delivery?"');
    expect((await savedBot(ben.id)).section).toBe("Research");
    await click("Move bot");
    await expect.poll(async () => (await savedBot(ben.id)).section).toBe("Delivery");
    expect(identity(await savedBot(ben.id))).toEqual(identity(beforeBots.find(bot => bot.id === ben.id)!));
    expect(await messages(ben.id)).toEqual(transcript);
    await click("Fit teams to view");

    // Same-team ordering is personal presentation, not a membership write.
    // Verify both pointer placement and the keyboard alternative, then retain
    // a non-default order through the later full page reload.
    const beforeReorder = await bots();
    const originalOrder = await cardOrder("Delivery") as string[];
    expect(originalOrder.toSorted()).toEqual([ben.id, dana.id].sort());
    const reordered = [...originalOrder].reverse();
    const reorderSelector = `[data-bot-id=${JSON.stringify(originalOrder[0])}]`;
    receipts.reorder = await drag(reorderSelector, { x: 0, y: 24 }, `[data-bot-id=${JSON.stringify(originalOrder[1])}]`);
    await expect.poll(() => cardOrder("Delivery")).toEqual(reordered);
    expect(await snapshot()).not.toContain('alertdialog "Move');
    await evaluate(`document.querySelector(${JSON.stringify(reorderSelector)}).focus(); true`);
    await ui("press", "--keys", "Alt+ArrowUp");
    await expect.poll(() => cardOrder("Delivery")).toEqual(originalOrder);
    await ui("press", "--keys", "Alt+ArrowDown");
    await expect.poll(() => cardOrder("Delivery")).toEqual(reordered);
    expect(await bots()).toEqual(beforeReorder);
    expect(await messages(ben.id)).toEqual(transcript);
    receipts.order = await cardOrder("Delivery");
    const beforeArrange = await teamPosition("Delivery");
    receipts.cancelledArrange = await drag('[aria-label="Arrange Delivery team"]', { x: 45, y: 20 }, undefined, true);
    expect(await teamPosition("Delivery")).toEqual(beforeArrange);
    receipts.arrange = await drag('[aria-label="Arrange Delivery team"]', { x: 12, y: 10 });
    await expect.poll(() => teamPosition("Delivery")).not.toEqual(beforeArrange);
    const arranged = await teamPosition("Delivery");
    const beforePan = await view();
    receipts.pan = await drag('[data-team-canvas]', { x: -60, y: 40 });
    await expect.poll(view).not.toEqual(beforePan);
    expect(await teamPosition("Delivery")).toEqual(arranged);
    const beforeZoom = await view();
    await click("Zoom in");
    expect((await view()).scale).toBeGreaterThan(beforeZoom.scale);
    await click("Zoom out");
    expect((await view()).scale).toBeCloseTo(beforeZoom.scale, 4);
    const wheel = (deltaY: number, ctrlKey = true) => evaluate(`(() => {
      const canvas = document.querySelector('[data-team-canvas]');
      const rect = canvas.getBoundingClientRect();
      return canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: ${ctrlKey},
        deltaY: ${deltaY}, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    })()`);
    await wheel(-10_000);
    await expect.poll(async () => (await view()).scale).toBe(1.5);
    await wheel(10_000);
    await expect.poll(async () => (await view()).scale).toBe(0.3);
    const beforeWheelPan = await view();
    await wheel(45, false);
    await expect.poll(async () => (await view()).y).toBeCloseTo(beforeWheelPan.y - 45, 4);
    await click("Fit teams to view");
    expect(await evaluate(`(() => {
      const viewport = document.querySelector('[data-team-canvas]').getBoundingClientRect();
      return [...document.querySelectorAll('[data-team-key]')].every(team => {
        const rect = team.getBoundingClientRect();
        return rect.left >= viewport.left - 1 && rect.top >= viewport.top - 1 && rect.right <= viewport.right + 1 && rect.bottom <= viewport.bottom + 1;
      });
    })()`)).toBe(true);

    const layout = await evaluate("Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('omb-team-canvas:')))");
    expect(Object.keys(layout)).toHaveLength(2);
    expect(Object.keys(layout).filter(key => key.endsWith(":bot-order"))).toHaveLength(1);
    receipts.layout = layout;
    await evaluate("location.reload(); true");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Actions for Ada");
    await openMap();
    await expect.poll(() => teamPosition("Delivery"), { timeout: 10_000 }).toEqual(arranged);
    await expect.poll(() => cardOrder("Delivery"), { timeout: 10_000 }).toEqual(reordered);
    expect(await evaluate("Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('omb-team-canvas:')))"))
      .toEqual(layout);
    expect((await savedBot(ben.id)).section).toBe("Delivery");
    expect(await messages(ben.id)).toEqual(transcript);
    for (const [section, text] of [["Engineering", "Keep the original engineering brief."], ["Research", "Keep the original research brief."], ["Delivery", "Review before shipping."]]) {
      expect((await api("GET", `/api/section-context?section=${section}`)).text).toBe(text);
    }
    await click("Fit teams to view");
    const screenshots: string[] = [];
    for (const skin of ["midnight", "daylight"]) {
      await evaluate(`import('/src/lib/skins.ts').then(({ applySkin }) => { applySkin(${JSON.stringify(skin)}); return document.documentElement.dataset.skin; })`);
      await evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))");
      // Read the theme's target color without inheriting a card transition,
      // then wait for the real card to reach it before taking evidence.
      const cardColor = await evaluate(`(() => {
        const probe = document.createElement('div');
        probe.style.cssText = 'display:none;background-color:var(--color-card)';
        document.body.append(probe);
        try { return getComputedStyle(probe).backgroundColor; } finally { probe.remove(); }
      })()`);
      await expect.poll(() => evaluate("getComputedStyle(document.querySelector('[data-team-key] article')).backgroundColor"),
        { timeout: 5_000 }).toBe(cardColor);
      receipts[`${skin}CardColor`] = cardColor;
      const screenshot = `${fixture.logPath}.team-canvas-${skin}.png`;
      await ui("screenshot", "--out", screenshot);
      screenshots.push(screenshot);
    }
    const consoleResult = await ui("console");
    expect((consoleResult.messages ?? []).filter((message: { type: string }) => message.type === "error")).toEqual([]);
    Object.assign(receipts, { screenshots, finalBots: (await bots()).map(identity), map: await snapshot(), console: consoleResult });
  } finally {
    if (info) {
      if (!receipts.screenshots) {
        try {
          receipts.failureSnapshot = await runControlOmb(["ui", "snapshot", "--ui", info.ui]);
          receipts.failureScreenshot = await runControlOmb(["ui", "screenshot", "--ui", info.ui, "--out", `${info.logPath}.team-canvas-failure.png`]);
        } catch { /* Preserve the original failure when the browser has stopped. */ }
      }
      const evidence = `${info.logPath}.team-canvas.json`;
      writeFileSync(evidence, JSON.stringify({ fixture: info, ...receipts }, null, 2));
      console.info(JSON.stringify({ evidence }));
    }
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, binary ? 240_000 : 720_000);
