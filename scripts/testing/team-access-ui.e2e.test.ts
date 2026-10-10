import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));

(enabled ? it : it.skip)("lets an owner select and revoke exactly the Chief's additional teams in the real settings UI", async () => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-omb.ts", "ui", "launch"], {
    cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let error = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { error += String(chunk); });
  child.on("error", caught => { error += caught.message; });
  let info: { ui: string; url: string; botId: string; logPath: string };
  try {
    await expect.poll(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(error);
      try { info = JSON.parse(output); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 180_000, interval: 250 }).toBe(true);
    const api = async (path: string, body?: unknown, method = "PATCH") => {
      const response = await fetch(info.url + path, body === undefined ? {} : {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(result));
      return result;
    };
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<any>;
    const click = (name: string) => ui("click", "--name", name);
    // The browser harness does not assign refs to native <summary> nodes.
    const toggleTeams = () => ui("eval", "--js", "document.querySelector('[data-bot-settings-section=permissions] summary').click()");
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const clickRole = async (role: string, name: string | RegExp) => {
      const refs = (await ui("snapshot")).refs as Record<string, { role: string; name: string }>;
      const match = Object.entries(refs).find(([, entry]) => entry.role === role && (typeof name === "string" ? entry.name === name : name.test(entry.name)));
      expect(match).toBeDefined();
      return ui("click", "--ref", "@" + match![0]);
    };
    const saved = async () => (await api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === info.botId);
    await api(`/api/bots/${info.botId}`, { name: "Clive", section: "Office", chiefOfStaff: true });
    await api("/api/bots", { name: "Engineer", section: "Engineering" }, "POST");
    await api("/api/bots", { name: "Researcher", section: "Research" }, "POST");
    await api("/api/bots", { name: "Private accountant", section: "Finance" }, "POST");
    await api("/api/sidebar-sections", { name: "Empty delivery" }, "POST");
    await ui("eval", "--js", "location.reload(); true");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Actions for Clive");
    await clickRole("button", /^Clive Rename Clive /);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Open Clive's profile");
    await clickRole("button", "Open Clive's profile");
    await click("Permissions");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Additional teams");
    await toggleTeams();
    await clickRole("checkbox", "Engineering");
    await clickRole("checkbox", "Research");
    await clickRole("checkbox", "Empty delivery");
    expect((await saved()).managedSections ?? []).toEqual([]);
    await click("Save team access");
    await expect.poll(async () => (await saved()).managedSections?.toSorted(), { timeout: 10_000 }).toEqual(["Empty delivery", "Engineering", "Research"]);
    // The server update remounts the controlled list so another bot's old
    // selection can never be saved from a stale dialog.
    await toggleTeams();
    const granted = await snapshot();
    expect(granted).toContain('checkbox "Engineering" [checked=true');
    expect(granted).toContain('checkbox "Research" [checked=true');
    expect(granted).toContain('checkbox "Finance" [checked=false');
    expect(granted).toContain('checkbox "Empty delivery" [checked=true');
    expect(granted).toContain('checkbox "General" [checked=false');
    const screenshot = info.logPath + ".team-access.png";
    await ui("screenshot", "--out", screenshot);
    await clickRole("checkbox", "Engineering");
    await click("Save team access");
    await expect.poll(async () => (await saved()).managedSections?.toSorted(), { timeout: 10_000 }).toEqual(["Empty delivery", "Research"]);
    await api("/api/sidebar-sections?section=Empty%20delivery", { name: "Empty delivery" });
    expect((await saved()).managedSections?.toSorted()).toEqual(["Empty delivery", "Research"]);
    await api("/api/sidebar-sections?section=Empty%20delivery", { name: "Empty launch" });
    await expect.poll(async () => (await saved()).managedSections, { timeout: 10_000 }).toEqual(["Research"]);
    await toggleTeams();
    await expect.poll(snapshot, { timeout: 10_000 }).toContain('checkbox "Empty launch" [checked=false');
    expect(await snapshot()).not.toContain('checkbox "Empty delivery"');
    // A new empty team appears in an already-open selector through SSE.
    await api("/api/sidebar-sections", { name: "Empty delivery" }, "POST");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain('checkbox "Empty delivery" [checked=false');
    expect((await saved()).managedSections).toEqual(["Research"]);
    const receipts = { granted, recreated: await snapshot(), final: await saved(), screenshot, logPath: info.logPath };
    writeFileSync(info.logPath + ".team-access.json", JSON.stringify(receipts, null, 2));
    console.log("Team access evidence:", info.logPath + ".team-access.json");
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, 240_000);
