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

describe("Share a department in the real renderer", () => {
  let child: ChildProcess | undefined;
  afterAll(async () => { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); });

  (enabled ? it : it.skip)("department … → Share shows one card with no fields, offers the folder when publishing isn't here, and saves it", async () => {
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

    await api(`/api/bots/${info!.botId}`, "PATCH", { section: "Sales desk", chiefOfStaff: true, soul: "Lead the desk. The admin key is sk-ant-api03-UIFIXTURESECRET0000000000000.\n" });
    await control("new-bot", "--name", "Scout", "--section", "Sales desk");
    await api(`/api/section-context?section=${encodeURIComponent("Sales desk")}`, "PUT", { text: "Quote list prices only." });
    await api(`/api/bots/${info!.botId}/memory/file`, "PUT", { path: "MEMORY.md", text: "- UI_FIXTURE_MEMORY prefers short summaries.\n" });
    // Capture the saved folder instead of letting the headless browser download it.
    await evaluate(`(() => {
      URL.createObjectURL = (blob) => { window.__shareBlob = blob; return "blob:share-fixture"; };
      HTMLAnchorElement.prototype.click = function () { window.__shareDownload = this.download; };
      return true;
    })()`);

    await click("Actions for Sales desk department");
    await click("Share");
    await expect.poll(snapshot, { timeout: 20_000 }).toContain("Chats, memory and keys are never shared");
    const dialog = await snapshot();
    for (const line of ["Share Sales desk", "Quote list prices only.", "Publishing isn't available here", "Upload on GitHub", "Save folder…"]) expect(dialog).toContain(line);
    expect(await evaluate("document.querySelector('[data-share-department]').closest('[role=dialog]').querySelectorAll('input, textarea, select, [role=checkbox]').length")).toBe(0);
    await ui("screenshot", "--out", join(ROOT, ".omb-scratch", "verify-evidence", "share-department.png"));
    await click("Save folder…");
    await expect.poll(() => evaluate("window.__shareDownload ?? null"), { timeout: 10_000 }).toBe("Sales desk.zip");
    await evaluate("window.__shareBlob.arrayBuffer().then((buffer) => { window.__shareText = new TextDecoder('latin1').decode(buffer); }); true");
    await expect.poll(async () => typeof (await evaluate("window.__shareText")), { timeout: 5_000 }).toBe("string");
    const zip = await evaluate("window.__shareText") as string;
    expect(zip.startsWith("PK")).toBe(true);
    expect(zip).toContain("team.md");
    expect(zip).not.toContain("UIFIXTURESECRET");
    expect(zip).not.toContain("UI_FIXTURE_MEMORY");
    await click("Close");
    process.stdout.write(`${JSON.stringify({ fixture: info!, departmentShared: true, savedZip: true })}\n`);
  }, launchTimeout + 120_000);
});
