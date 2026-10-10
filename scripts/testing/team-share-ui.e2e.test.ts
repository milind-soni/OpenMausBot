import { spawn, type ChildProcess } from "node:child_process";
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
if (!enabled) console.log("skipping share-team UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

describe("Share team in the real renderer", () => {
  let child: ChildProcess | undefined;
  afterAll(async () => { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); });

  (enabled ? it : it.skip)("shows what a team's file holds, saves it, and adds it back as a new team", async () => {
    let stdout = "";
    let stderr = "";
    let info: { ui: string; url: string; botId: string; logPath: string };
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
    const click = (name: string) => ui("click", "--name", name);
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const api = (path: string, method = "GET", body?: unknown) => request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, info.url);
    const control = (...args: string[]) => runControlOmb([...args, "--url", info.url]) as Promise<Record<string, any>>;

    await api(`/api/bots/${info!.botId}`, "PATCH", { section: "Sales desk", chiefOfStaff: true, soul: "Lead the desk. The portal password=UiFixture-Secret-1 stays private.\n" });
    const scout = (await control("new-bot", "--name", "Scout", "--section", "Sales desk")).bot;
    await api(`/api/section-context?section=${encodeURIComponent("Sales desk")}`, "PUT", { text: "Quote list prices only." });
    await api(`/api/bots/${scout.id}/skill-template`, "POST", { name: "research-brief", description: "Write a prospect brief.", source: "fixture",
      text: "---\nname: research-brief\ndescription: Write a prospect brief.\n---\n\n# Brief\n", enabled: true });
    // 31 skills on one bot, more than a file carries per bot, and the first
    // 17 fillers so long that even the 30 that fit pass the 4 MB file limit:
    // the dialog's very first look is refused.
    for (let index = 1; index <= 30; index++) {
      const name = `fill-${String(index).padStart(2, "0")}`;
      // 252 KB each: 17 pass the 4 MB limit, 16 fit under it.
      const body = index <= 17 ? `${"step ".repeat(50_400)}\n` : `# ${name}\n`;
      await api(`/api/bots/${scout.id}/skill-template`, "POST", { name, description: "Filler step.", source: "fixture",
        text: `---\nname: ${name}\ndescription: Filler step.\n---\n\n${body}`, enabled: false });
    }
    await api(`/api/bots/${info!.botId}/memory/file`, "PUT", { path: "MEMORY.md", text: "- Prefers short summaries.\n" });
    await api("/api/routines", "POST", { name: "Daily digest", prompt: "Summarize new leads.", botId: scout.id, enabled: true,
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30 });
    // Capture the saved file instead of letting the headless browser download it.
    await evaluate(`(() => {
      URL.createObjectURL = (blob) => { window.__shareBlob = blob; return "blob:share-fixture"; };
      HTMLAnchorElement.prototype.click = function () { window.__shareDownload = this.download; };
      return true;
    })()`);

    await click("New or share");
    await click("Templates");
    await click("Share");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Share the Sales desk team");
    await click("Share the Sales desk team");
    // A refused first look is not a dead end: the sentence, no counts and no
    // Save, but every skill box is drawn from the refusal.
    const saveDisabled = () => evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((button) => button.textContent === "Save file").disabled`);
    await expect.poll(snapshot, { timeout: 20_000 }).toContain("This team is too large to share (4 MB).");
    let dialog = await snapshot();
    for (const line of ["research-brief", "fill-01", "fill-30", "Starter notes are included", "Save file"]) expect(dialog).toContain(line);
    expect(dialog).not.toContain("What's in the file");
    expect(await saveDisabled()).toBe(true);
    await ui("screenshot", "--out", join(ROOT, ".omb-scratch", "verify-evidence", "share-team-refused.png"));
    // Leaving out one long skill is a choice that fits.
    await click("fill-01");
    await expect.poll(snapshot, { timeout: 20_000 }).toContain("What's in the file");
    dialog = await snapshot();
    for (const line of ["Chief of Staff", "Never included: chat history", "Save file"]) expect(dialog).toContain(line);
    expect(dialog).not.toContain("too large to share");
    // Starter notes are in by default; unticking takes them out, ticking puts them back.
    await click("Include starter notes (each bot's MEMORY.md and topic notes)");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Starter notes are not included");
    await click("Include starter notes (each bot's MEMORY.md and topic notes)");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Starter notes are included");
    // 31 ticked on one bot cannot fit: a sentence, the boxes stay, no Save.
    await click("fill-01");
    await expect.poll(snapshot, { timeout: 20_000 }).toContain("Scout has more than 30 skills. Choose fewer skills and try again.");
    dialog = await snapshot();
    expect(dialog).toContain("fill-02");
    expect(dialog).not.toContain("What's in the file");
    expect(await saveDisabled()).toBe(true);
    await click("fill-02");
    await expect.poll(snapshot, { timeout: 20_000 }).toContain("What's in the file");
    expect(await snapshot()).not.toContain("Scout has more than 30 skills");
    expect(await saveDisabled()).toBe(false);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Removed what looked like a key or password from:");
    await ui("screenshot", "--out", join(ROOT, ".omb-scratch", "verify-evidence", "share-team-dialog.png"));
    await click("Save file");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Saved sales-desk-1.0.0.openmaus.json");
    await evaluate("window.__shareBlob.text().then((text) => { window.__shareText = text; }); true");
    await expect.poll(async () => typeof (await evaluate("window.__shareText")), { timeout: 5_000 }).toBe("string");
    const saved = JSON.parse(await evaluate("window.__shareText") as string);
    expect(await evaluate("window.__shareDownload")).toBe("sales-desk-1.0.0.openmaus.json");
    expect(saved).toMatchObject({ format: "openmaus.package", version: 2, package: { id: "sales-desk", team: { name: "Sales desk", brief: "Quote list prices only." } } });
    expect(saved.package.agents).toHaveLength(2);
    const savedScout = saved.package.agents.find((agent: { name: string }) => agent.name === "Scout");
    expect(savedScout.skills).toHaveLength(30);
    for (const name of ["research-brief", "fill-01", "fill-30"]) expect(savedScout.skills).toContain(name);
    expect(savedScout.skills).not.toContain("fill-02");
    expect(JSON.stringify(saved)).not.toContain("UiFixture-Secret-1");
    await ui("screenshot", "--out", join(ROOT, ".omb-scratch", "verify-evidence", "share-team-saved.png"));
    await click("Done");

    // Add the saved file back through Import: the preview names every part.
    await click("Import");
    await evaluate(`(() => { const input = document.querySelector('[role=dialog] input[type=file]'); const transfer = new DataTransfer(); transfer.items.add(new File([window.__shareText], 'sales-desk-1.0.0.openmaus.json', { type: 'application/json' })); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("2 bots · shared team");
    const preview = await snapshot();
    for (const line of ["Shared instructions", "Routines: 1 · paused", "Starter notes: 1", "Included skills — added switched off"]) {
      expect(preview).toContain(line);
    }
    expect(preview).not.toContain("Connections to finish");
    await ui("screenshot", "--out", join(ROOT, ".omb-scratch", "verify-evidence", "share-team-import-preview.png"));
    await click("Add team");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain('button "Sales desk 2"');
    const bots = (await api("/api/bots")).bots.filter((bot: { section?: string }) => bot.section === "Sales desk 2");
    expect(bots).toHaveLength(2);
    for (const bot of bots) {
      const skills = (await api(`/api/bots/${bot.id}/skills`)).skills as Array<{ enabled: boolean }>;
      expect(skills.every((skill) => !skill.enabled)).toBe(true);
    }
    process.stdout.write(`${JSON.stringify({ fixture: info!, savedFile: true, importedSection: "Sales desk 2" })}\n`);
  }, launchTimeout + 120_000);
});
