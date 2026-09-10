// The first asserted renderer recipe: docs/verification/chat-ui.md, run by a
// machine. It spawns the real `control-omb ui launch` (a child it can Ctrl-C),
// drives the real <App/> through the ui verbs, and reads the outcome back from
// the accessibility tree — the same evidence a person would collect by hand.
//
// Needs the pinned agent-browser binary. It runs when one resolves (the tools
// directory, OMB_AGENT_BROWSER_PATH or PATH) or when OMB_UI_E2E=1 asks for the
// verified download; otherwise it is skipped with a printed reason.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(ROOT, "scripts", "control-omb.ts");
const forced = process.env.OMB_UI_E2E === "1";
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = forced || Boolean(binary);
if (!enabled) {
  console.log(`skipping control-omb ui e2e: no agent-browser binary resolves (looked in ${UI_TOOLS_DIR}, OMB_AGENT_BROWSER_PATH and PATH); set OMB_UI_E2E=1 to install the pinned release`);
}
const run = enabled ? it : it.skip;
// A cold run downloads the binary and Chrome; a warm one launches in seconds.
const LAUNCH_TIMEOUT_MS = forced && !binary ? 600_000 : 180_000;

// Synthetic provider outcomes exercise the UI, not the commands themselves.
const TOOL_CALLS = JSON.stringify([
  { name: "Bash", input: { command: "pnpm control:omb doctor" }, ok: true },
  { name: "Bash", input: { command: "pnpm control:omb ui click --name Missing" }, ok: false },
  { name: "Bash", input: { command: "pnpm control:omb ui flag --set features.showToolCalls=true --dry-run" }, ok: true },
]);
const REPLY = "hello from fake claude"; // the fake engine's default reply text
// OMB_UI_EVIDENCE_DIR keeps the screenshot (CI uploads it); otherwise it is temporary.
const evidenceDir = process.env.OMB_UI_EVIDENCE_DIR ? resolve(ROOT, process.env.OMB_UI_EVIDENCE_DIR) : mkdtempSync(join(tmpdir(), "omb-ui-evidence-"));
const ownsEvidenceDir = !process.env.OMB_UI_EVIDENCE_DIR;

interface Launched {
  child: ReturnType<typeof spawn>;
  info: { ui: string; url: string; previewUrl: string; botId: string; dataDir: string; logPath: string };
  stderr: () => string;
}

/** Start `ui launch` as a real foreground process and wait for its handle. */
function launch(args: string[]): Promise<Launched> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, "ui", "launch", ...args], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGINT");
      fail(new Error(`ui launch printed no handle within ${LAUNCH_TIMEOUT_MS}ms\nstderr:\n${stderr}`));
    }, LAUNCH_TIMEOUT_MS);
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
      if (settled) return;
      // The handle is the pretty-printed object at the start of a line; any
      // earlier line would be a tool printing on stdout, which the launch
      // is meant to prevent, so a parse from there still recovers.
      const start = stdout.startsWith("{") ? 0 : stdout.indexOf("\n{") + 1;
      if (start <= 0 && !stdout.startsWith("{")) return;
      try {
        const info = JSON.parse(stdout.slice(start));
        settled = true;
        clearTimeout(timer);
        done({ child, info, stderr: () => stderr });
      } catch {
        // the pretty-printed handle is still arriving
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(new Error(`ui launch exited ${code} before printing a handle\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

const ui = (verb: string, handle: string, ...args: string[]) =>
  runControlOmb(["ui", verb, "--ui", handle, ...args]) as Promise<Record<string, any>>;

/** Interactive refs by accessible name, from a snapshot's `refs` table. */
const refsNamed = (snapshot: Record<string, any>, name: string, role?: string) =>
  Object.entries(snapshot.refs as Record<string, { name: string; role: string }>)
    .filter(([, element]) => element.name === name && (!role || element.role === role))
    .map(([id]) => `@${id}`);

describe("control-omb ui drives the real renderer", () => {
  let launched: Launched | undefined;

  afterAll(async () => {
    if (launched && launched.child.exitCode === null && launched.child.signalCode === null) {
      await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
    }
    if (ownsEvidenceDir) await removeTempDir(evidenceDir);
  });

  run("sends a turn from the composer and shows the reply and the scripted tool chip", async () => {
    launched = await launch(["--tool-calls", TOOL_CALLS]);
    const { info } = launched;
    expect(info.ui).toBe(join(info.dataDir, "ui.json"));
    expect(existsSync(info.ui)).toBe(true);
    const handle = JSON.parse(readFileSync(info.ui, "utf8"));
    expect(handle).toMatchObject({ url: info.url, previewUrl: info.previewUrl, botId: info.botId, home: info.dataDir, session: `omb-ui-${new URL(info.url).port}` });
    expect(existsSync(handle.binary)).toBe(true);

    // The flag flips on the server; the renderer picks it up over SSE.
    const dry = await ui("flag", info.ui, "--set", "features.showToolCalls=true", "--dry-run");
    expect(dry).toMatchObject({ ok: true, dryRun: true, patch: { features: { showToolCalls: true } } });
    const flagged = await ui("flag", info.ui, "--set", "features.showToolCalls=true");
    expect(flagged).toMatchObject({ ok: true, features: { showToolCalls: true } });

    const before = await ui("snapshot", info.ui, "--interactive");
    expect(before.ok).toBe(true);
    const [composer, ...moreComposers] = refsNamed(before, "Message Pepper", "textbox");
    expect(composer).toMatch(/^@e\d+$/);
    expect(moreComposers).toEqual([]);
    expect(before.snapshot).not.toContain(REPLY);

    const typed = await ui("type", info.ui, "--ref", composer, "--text", "hello");
    expect(typed).toMatchObject({ ok: true, target: composer, typed: "hello" });
    const pressed = await ui("press", info.ui, "--keys", "Enter");
    expect(pressed).toMatchObject({ ok: true, pressed: "Enter" });

    const settled = await ui("wait-settle", info.ui, "--timeout", "60");
    expect(settled).toMatchObject({ ok: true, status: "settled", browser: { state: "networkidle" }, renderer: { rendered: true } });
    expect((settled.bots as Array<{ busy: boolean }>).every((bot) => !bot.busy)).toBe(true);

    const after = await ui("snapshot", info.ui);
    expect(after.ok).toBe(true);
    const tree = after.snapshot as string;
    // The sidebar row previews the reply too; read the transcript landmark.
    const transcriptStart = tree.indexOf('log "Conversation with Pepper"');
    expect(transcriptStart).toBeGreaterThan(-1);
    const transcript = tree.slice(transcriptStart);
    expect(transcript).toContain('StaticText "hello"'); // the sent turn
    // (a) the fake engine's reply text, as a transcript row
    expect(transcript).toContain(`StaticText "${REPLY}"`);
    // (b) the scripted Bash call rendered as a tool chip, named by its tool
    expect(transcript).toMatch(/StaticText "Bash"/);
    expect(tree).not.toContain("Not logged in");
    expect(tree).not.toContain("Execution timeline");
    expect(tree).toContain("1 passed · 1 failed · 1 dry run");

    // These are real control operations: the fixture health check succeeds
    // and a deliberately missing UI target rejects instead of reporting green.
    expect(await runControlOmb(["doctor", "--url", info.url])).toMatchObject({ ok: true });
    await expect(ui("click", info.ui, "--name", "Deliberately missing QA control")).rejects.toThrow("no element is named");

    mkdirSync(evidenceDir, { recursive: true });
    const shotPath = join(evidenceDir, "chat-ui.png");
    const shot = await ui("screenshot", info.ui, "--out", shotPath);
    expect(shot).toMatchObject({ ok: true, path: shotPath });
    const png = readFileSync(shotPath);
    expect(png.length).toBeGreaterThan(1_000);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    await ui("click", info.ui, "--name", "Collapse the verification run");
    const collapsed = await ui("snapshot", info.ui);
    expect(collapsed.snapshot).toContain("Expand the verification run");
    expect(collapsed.snapshot).not.toContain('list "Verification steps"');

    await ui("click", info.ui, "--name", "Inspector");
    const inspected = await ui("snapshot", info.ui);
    const runLog = (inspected.snapshot as string).slice((inspected.snapshot as string).indexOf('complementary "Inspector"'));
    expect(runLog).toContain('tab "Run Log" [selected');
    expect(runLog).toContain("pnpm control:omb doctor");
    expect(runLog).toContain("pnpm control:omb ui click --name Missing");
    expect(runLog).toContain('StaticText "Failed"');
    expect(runLog).toContain("Copy redacted run log");
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "run-log.png"));

    // Existing technical views remain reachable by accessible tab references.
    const [eventsTab] = refsNamed(inspected, "Events", "tab");
    expect(eventsTab).toBeDefined();
    await ui("click", info.ui, "--ref", eventsTab);
    const events = await ui("snapshot", info.ui);
    expect(events.snapshot).toContain("turn.started");
    const [rawTab] = refsNamed(events, "Raw", "tab");
    await ui("click", info.ui, "--ref", rawTab);
    expect((await ui("snapshot", info.ui)).snapshot).toContain('tab "Raw" [selected');
    await ui("click", info.ui, "--name", "Close the Inspector");
    expect((await ui("snapshot", info.ui)).snapshot).not.toContain('complementary "Inspector"');

    const logs = await ui("console", info.ui);
    expect(logs.ok).toBe(true);
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);
    const title = await ui("eval", info.ui, "--js", "document.title");
    expect(title).toMatchObject({ ok: true, result: "Isolated OpenMaus Chat" });

    // Ctrl-C: browser, preview and fixture close; only the fixture's data goes.
    await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
    expect(launched.child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
    expect(existsSync(info.logPath)).toBe(true);
    await expect(ui("snapshot", info.ui)).rejects.toThrow("could not read the ui handle");
  }, LAUNCH_TIMEOUT_MS + 120_000);
});
