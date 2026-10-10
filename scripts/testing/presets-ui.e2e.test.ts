import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { request } from "../mcp-server.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(binary);
const launchTimeout = forced && !binary ? 600_000 : 180_000;
if (!enabled) console.log("skipping presets UI e2e: set OMB_UI_E2E=1 to install the pinned browser");
const evidence = (name: string) => join(ROOT, ".omb-scratch", "verify-evidence", `presets-${name}.png`);

describe("Preset bots in the real renderer", () => {
  let child: ChildProcess | undefined;
  afterAll(async () => { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); });

  (enabled ? it : it.skip)("shares New bot defaults as a preset file, adds it back, and makes bots from file and organization presets", async () => {
    let stdout = "";
    let stderr = "";
    let info: { ui: string; url: string; botId: string; dataDir: string; logPath: string };
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: launchTimeout, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name).catch((error: Error) => { throw new Error(`clicking "${name}": ${error.message}`); });
    // A panel or dialog that just closed can still cover the sidebar for a
    // frame; agent-browser refuses a covered click without sending it, so
    // retrying is safe.
    const clickWhenFree = (name: string) => expect.poll(() => click(name).then(() => true, () => false), { timeout: 10_000 }).toBe(true);
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const api = (path: string, method = "GET", body?: unknown) => request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, info.url);

    // My New bot defaults: a name, words, a colour, a skill that is on, notes,
    // and things a preset must never carry (approval, connected apps).
    await api("/api/config", "PATCH", { newBotDefaults: {
      profile: { name: "Sky", title: "Support", soul: "Be kind and precise.\n", color: "blue", approvalMode: "auto", composio: true },
      memory: { "MEMORY.md": "- Customers first.\n" },
      skills: [{ name: "follow-up", description: "Write a short follow-up.", source: "fixture", enabled: true, warnings: [],
        text: "---\nname: follow-up\ndescription: Write a short follow-up.\n---\n\n# Follow-up\n" }],
      routines: [],
    } });
    // Capture the saved file instead of letting the headless browser download it.
    await evaluate(`(() => {
      URL.createObjectURL = (blob) => { window.__presetBlob = blob; return "blob:preset-fixture"; };
      HTMLAnchorElement.prototype.click = function () { window.__presetDownload = this.download; };
      return true;
    })()`);

    // Settings → Share as preset…: counts from the server, then Save file.
    await expect.poll(snapshot, { timeout: 10_000 }).toContain('button "You"');
    await click("You");
    await click("Settings");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Share as preset…");
    await click("Share as preset…");
    await expect.poll(snapshot, { timeout: 20_000 }).toContain("What's in the file");
    let dialog = await snapshot();
    for (const line of ["Share New bot defaults as a preset", "follow-up", "Never included: model choices, folders, computers, approval levels"]) expect(dialog).toContain(line);
    await ui("screenshot", "--out", evidence("share"));
    await click("Save file");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Saved sky-1.0.0.openmaus.json");
    await evaluate("window.__presetBlob.text().then((text) => { window.__presetText = text; }); true");
    await expect.poll(async () => typeof (await evaluate("window.__presetText")), { timeout: 5_000 }).toBe("string");
    const saved = JSON.parse(await evaluate("window.__presetText") as string);
    expect(await evaluate("window.__presetDownload")).toBe("sky-1.0.0.openmaus.json");
    expect(saved.package).toMatchObject({ id: "sky", agents: [], presets: [{ key: "new-bot-defaults", name: "Sky", skills: ["follow-up"], seed: { memory: { "MEMORY.md": "- Customers first.\n" } } }] });
    expect(JSON.stringify(saved)).not.toMatch(/"approvalMode"|"composio"|"modelSelection"|"enabled"/);
    await click("Done");
    await click("Close settings");

    // Templates → Import the file: preset bots for New bot, no team.
    await clickWhenFree("New or share");
    await click("Templates");
    await click("Import");
    await evaluate(`(() => { const input = document.querySelector('[role=dialog] input[type=file]'); const transfer = new DataTransfer(); transfer.items.add(new File([window.__presetText], 'sky-1.0.0.openmaus.json', { type: 'application/json' })); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Preset bots and skills · no team");
    const preview = await snapshot();
    expect(preview).toContain("Preset bots: 1 · appear in New bot");
    expect(preview).not.toContain("Team members");
    expect(preview).toContain("Preset bots — added to New bot");
    await ui("screenshot", "--out", evidence("import-preview"));
    await click("Add presets");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Preset bots added to New bot: 1");
    const [filePreset] = (await api("/api/bot-presets")).presets as Array<{ id: string }>;

    // An organization preset, as the organization library stores one.
    const presetsFile = join(info!.dataDir, "org-library", "presets.json");
    const stored = JSON.parse(readFileSync(presetsFile, "utf8"));
    const orgRow = { ...stored.presets[0], id: "org-preset-1", source: "org", installId: "0123456789abcdef0123456789abcdef", publisherName: "Acme Partners",
      publisher: { organizationId: "org-acme", slug: "acme", name: "Acme Partners" }, ref: "acme/sky", sha256: "a".repeat(64), name: "Acme closer" };
    stored.presets.push(orgRow);
    stored.content[orgRow.installId] = stored.content[stored.presets[0].installId];
    writeFileSync(presetsFile, JSON.stringify(stored));

    // Share team: the defaults preset goes in only when ticked.
    await clickWhenFree("New or share");
    await click("Templates");
    await click("Share");
    await click("Share the General team");
    await expect.poll(snapshot, { timeout: 20_000 }).toContain("What's in the file");
    expect(await snapshot()).not.toContain('term "Preset bots"');
    await click("Include my New bot defaults as a preset");
    await expect.poll(snapshot, { timeout: 20_000 }).toContain('term "Preset bots"');
    expect(await snapshot()).toContain('StaticText "1 · Sky"');
    expect(await snapshot()).toContain("Never their model, folder, computer, approval level or connected apps.");
    await ui("screenshot", "--out", evidence("share-team"));
    await click("Cancel");
    await click("Close templates");

    // New bot: organization presets, then imported ones, above the built-in roles.
    const bots = async () => (await api("/api/bots")).bots as Array<{ id: string; name: string; installedPackage?: Record<string, unknown> }>;
    const create = async (value: string, expected: string, shot: string) => {
      const before = await bots();
      await clickWhenFree("New or share");
      await click("New Bot");
      await expect.poll(async () => (await ui("eval", "--js", "[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent.trim() === 'Create bot')?.disabled")).result, { timeout: 20_000 }).toBe(false);
      await expect.poll(() => evaluate("[...document.querySelectorAll('[role=dialog] select optgroup')].map(group => group.label).join(' | ')"), { timeout: 10_000 })
        .toBe("From Acme Partners | Imported presets | Built-in roles");
      // Native select popups do not take routed keys reliably in headless
      // Chrome; the real select's change handler runs without the OS popup.
      await evaluate(`(() => { const select = [...document.querySelectorAll('[role=dialog] select')].find(item => item.querySelector('optgroup')); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await expect.poll(snapshot, { timeout: 10_000 }).toContain(expected);
      await ui("screenshot", "--out", evidence(shot));
      await click("Create bot");
      await expect.poll(async () => (await bots()).length, { timeout: 15_000 }).toBe(before.length + 1);
      return (await bots()).find((bot) => !before.some((old) => old.id === bot.id))!;
    };
    const fromFile = await create(`preset:${filePreset!.id}`, "Skills, added switched off: follow-up", "new-bot-file");
    expect(fromFile).toMatchObject({ name: expect.stringMatching(/^Sky/), installedPackage: { source: "file", presetKey: "new-bot-defaults" } });
    expect((await api(`/api/bots/${fromFile.id}/skills`)).skills).toEqual([expect.objectContaining({ name: "follow-up", enabled: false })]);
    expect((await api(`/api/bots/${fromFile.id}/memory/file?path=MEMORY.md`)).text).toBe("- Customers first.\n");
    const fromOrg = await create("preset:org-preset-1", "Skills, added switched on: follow-up", "new-bot-org");
    expect(fromOrg.installedPackage).toMatchObject({ source: "org", presetKey: "new-bot-defaults", ref: "acme/sky" });
    expect((await api(`/api/bots/${fromOrg.id}/skills`)).skills).toEqual([expect.objectContaining({ name: "follow-up", enabled: true })]);
    process.stdout.write(`${JSON.stringify({ fixture: info!, savedFile: true, presetsInNewBot: 2 })}\n`);
  }, launchTimeout + 180_000);
});
