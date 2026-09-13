// Real Settings controls against simulated backup endpoints in a disposable
// full-app browser. Archive encryption/restart are separate server tests.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(binary);
if (!enabled) console.log("skipping workspace backup UI e2e: no agent-browser; set OMB_UI_E2E=1 to install the pinned release");
const LAUNCH_TIMEOUT_MS = forced && !binary ? 600_000 : 180_000;
interface FixtureInfo { ui: string; url: string; dataDir: string; logPath: string }

describe("full backup Settings in the real renderer", () => {
  let child: ChildProcess | undefined;
  let info: FixtureInfo;
  afterAll(async () => { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); });

  (enabled ? it : it.skip)("uses passwords, a file preview and explicit replacement without leaking secrets", async () => {
    let stdout = "";
    let stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: LAUNCH_TIMEOUT_MS, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const type = async (name: string, text: string) => {
      await click(name);
      // Select the focused native input. `ui type` appends and its focus
      // step collapses a selection, so clear via a real key first.
      await evaluate("(() => { const input = document.activeElement; if (!(input instanceof HTMLInputElement)) throw new Error('Expected focused input'); input.select(); return true; })()");
      await ui("press", "--keys", "Backspace");
      await ui("type", "--name", name, "--text", text);
    };
    const snapshot = async () => (await ui("snapshot")).snapshot as string;

    // Only this page mocks the archive service. The server, Settings modal,
    // forms, validation, file input, React state and native link are real.
    await evaluate(`(() => {
      const originalFetch = window.fetch.bind(window);
      const originalClick = HTMLAnchorElement.prototype.click;
      window.backupFixture = { calls: [], pending: false, download: null };
      window.fetch = (input, init = {}) => {
        const path = String(input);
        if (!path.startsWith('/api/workspace-backup/')) return originalFetch(input, init);
        const fixture = window.backupFixture;
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
        fixture.calls.push({ path, body, rawFile: init.body instanceof File, type: init.headers?.['content-type'] });
        const reply = (value, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }));
        if (path.endsWith('/status')) return reply({ busy: false, pendingRestore: fixture.pending });
        if (path.endsWith('/export')) return reply({ id: 'download-stage', filename: 'fixture.ombbackup' });
        if (path.endsWith('/upload')) return reply({ id: 'uploaded-file' });
        if (path.endsWith('/preview')) {
          if (body.password !== 'fixture password 123') return reply({ error: 'Fixture password rejected' }, 400);
          return reply({ id: 'validated-stage', summary: { format: 'openmaus.workspace-backup', version: 1, id: 'archive-id', createdAt: '2026-09-11T00:00:00Z', appVersion: '0.1.71', files: 12, directories: 4, bytes: 4321, bots: 3, groups: 2, threads: 7, messages: 21, warnings: ['Fixture warning: routines will be paused'], exclusions: ['Saved account credentials and connections', 'External CLI sign-ins', 'Remote VM disks'] } });
        }
        if (path.endsWith('/restore')) { fixture.pending = true; return reply({ restartRequired: true, restoreId: 'validated-stage' }); }
        return reply({ error: 'Unexpected fixture route' }, 404);
      };
      HTMLAnchorElement.prototype.click = function() {
        if (this.getAttribute('href')?.startsWith('/api/workspace-backup/download/')) { window.backupFixture.download = { href: this.getAttribute('href'), filename: this.download }; return; }
        return originalClick.call(this);
      };
      localStorage.setItem('omb-drafts', JSON.stringify({fixture: 'private fixture draft'}));
      localStorage.setItem('fixture-auth-token', 'must not export');
      localStorage.setItem('omb-webhook-credentials', 'fixture private URL must not export');
      return true;
    })()`);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain('button "You"');
    await click("New or share");
    const menu = await snapshot();
    expect(menu).toContain('button "Templates"');
    expect(menu).not.toContain('button "Export backup"');
    await click("Templates");
    await ui("press", "--keys", "Escape");
    await click("You");
    await click("Settings");
    await click("Backups");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Export full backup");
    expect(await snapshot()).toContain("Saved account credentials and connections are not included");
    expect(await snapshot()).toContain("not automatically redacted");
    await ui("screenshot", "--out", join(ROOT, ".omb-scratch", "verify-evidence", "workspace-backup-settings.png"));
    await type("Backup password", "fixture password 123");
    await type("Confirm backup password", "fixture password 123");
    await click("Export full backup");
    await expect.poll(() => evaluate("window.backupFixture.download"), { timeout: 10_000 }).toEqual({ href: "/api/workspace-backup/download/download-stage", filename: "fixture.ombbackup" });
    expect(await evaluate("window.backupFixture.calls.find(call => call.path.endsWith('/export')).body.clientState['fixture-auth-token'] ?? null")).toBeNull();
    expect(await evaluate("window.backupFixture.calls.find(call => call.path.endsWith('/export')).body.clientState['omb-webhook-credentials'] ?? null")).toBeNull();
    expect(await evaluate("Object.values(localStorage).some(value => value.includes('fixture password 123'))")).toBe(false);

    // A File is delivered through the native input's change event. This
    // does not claim to automate the OS file-picker dialog.
    await evaluate(`(() => { const input = document.querySelector('[role=dialog] input[type=file]'); const transfer = new DataTransfer(); transfer.items.add(new File(['encrypted fixture bytes'], 'fixture.ombbackup', { type: 'application/octet-stream' })); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await expect.poll(() => evaluate("document.querySelector('[role=dialog] input[autocomplete=off][type=password]')?.disabled")).toBe(false);
    await type("Password for this backup", "wrong password");
    await click("Validate backup");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Fixture password rejected");
    expect(await evaluate("Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Replace workspace')")).toBe(false);
    await type("Password for this backup", "fixture password 123");
    await click("Validate backup");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Validated backup");
    const replaceDisabled = () => evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Replace workspace')?.disabled");
    expect(await replaceDisabled()).toBe(true);
    expect(await snapshot()).toContain("Only restore backups you trust");
    await type("Type REPLACE to confirm", "replace");
    expect(await replaceDisabled()).toBe(true);
    await type("Type REPLACE to confirm", "REPLACE");
    expect(await replaceDisabled()).toBe(false);
    const evidence = join(ROOT, ".omb-scratch", "verify-evidence", "workspace-backup-preview.png");
    await ui("screenshot", "--out", evidence);
    await click("Replace workspace");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Fully quit OpenMausBot");
    expect(await evaluate("window.backupFixture.calls.find(call => call.path.endsWith('/restore')).body")).toEqual({ id: "validated-stage", confirmation: "REPLACE" });
    expect(await evaluate("window.backupFixture.calls.find(call => call.path.endsWith('/upload')).rawFile")).toBe(true);
    expect(await evaluate("localStorage.getItem('omb-pending-workspace-restore')")).toBe("validated-stage");
    console.log(JSON.stringify({ fixture: info, screenshot: evidence, archiveApi: "simulated; renderer controls real" }));
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    expect(child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
  }, LAUNCH_TIMEOUT_MS + 120_000);
});
