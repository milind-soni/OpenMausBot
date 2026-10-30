import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));

describe("server dictation through the real browser and authenticated fixture", () => {
  let child: ChildProcess | undefined;
  let worker: Server | undefined;
  afterAll(async () => {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    if (worker) {
      worker.closeAllConnections();
      await new Promise<void>(resolve => worker!.close(() => resolve()));
    }
  });

  (enabled ? it : it.skip)("records WebM, cancels capture, and sends the reviewed text only after a click", async () => {
    const uploads: Buffer[] = [];
    const mediaTypes: string[] = [];
    let complete: (() => void) | undefined;
    worker = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") return res.end(JSON.stringify({ ready: true }));
      if (req.url !== "/transcribe" || req.method !== "POST") { res.writeHead(404); res.end("{}"); return; }
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        uploads.push(Buffer.concat(chunks));
        mediaTypes.push(String(req.headers["content-type"]));
        complete = () => res.end(JSON.stringify({ text: "A sentence to review before sending." }));
      });
    });
    await new Promise<void>(resolve => worker!.listen(0, "127.0.0.1", resolve));
    const workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
    let output = "", errors = "";
    let info!: { ui: string; url: string; botId: string; logPath: string };
    child = spawn(process.execPath, ["--experimental-strip-types", join(root, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: root, env: { ...process.env, OMB_DICTATION_URL: workerUrl }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => { output += String(chunk); });
    child.stderr!.on("data", chunk => { errors += String(chunk); });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`Fixture exited: ${errors}`);
      try { info = JSON.parse(output); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 180_000 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const input = () => evaluate('document.querySelector("textarea")?.value');
    const userTexts = async () => {
      const result = await runControlOmb(["messages", "--url", info.url, "--bot", info.botId]) as { messages: Array<{ role: string; text?: string }> };
      return result.messages.filter(row => row.role === "user").map(row => row.text);
    };
    await expect.poll(() => evaluate('Boolean(document.querySelector(\'button[aria-label="Start dictation"]\'))'), { timeout: 30_000 }).toBe(true);
    await evaluate(`(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext();
        const source = context.createOscillator();
        const output = context.createMediaStreamDestination();
        source.connect(output);
        output.stream.getTracks().forEach(track => {
          const stop = track.stop.bind(track);
          track.stop = () => { stop(); void context.close(); };
        });
        await context.resume(); source.start();
        return output.stream;
      };
      return true;
    })()`);
    const evidence = join(root, ".omb-scratch/verify-evidence/server-dictation");
    mkdirSync(evidence, { recursive: true });
    await ui("screenshot", "--out", join(evidence, "ready.png"));
    await ui("click", "--name", "Start dictation");
    await ui("click", "--name", "Cancel dictation");
    expect(uploads).toHaveLength(0);
    expect(await input()).toBe("");
    await ui("click", "--name", "Start dictation");
    expect(await evaluate('document.activeElement?.getAttribute("aria-label")')).toBe("Stop dictation");
    await ui("press", "--keys", "Escape");
    await expect.poll(() => evaluate('Boolean(document.querySelector(\'button[aria-label="Start dictation"]\'))')).toBe(true);
    expect(uploads).toHaveLength(0);
    await ui("click", "--name", "Start dictation");
    await ui("screenshot", "--out", join(evidence, "recording.png"));
    await ui("click", "--name", "Stop dictation");
    try {
      await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1);
    } catch (error) {
      console.log(JSON.stringify({ fixtureLog: info.logPath, text: await evaluate("document.body.innerText"), console: await ui("console") }));
      throw error;
    }
    expect(mediaTypes[0]).toMatch(/^audio\/webm/);
    expect([...uploads[0]!.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(await userTexts()).toEqual([]);
    await ui("screenshot", "--out", join(evidence, "transcribing.png"));
    expect(await evaluate('document.activeElement?.blur(); document.activeElement === document.body')).toBe(true);
    await ui("press", "--keys", "Escape");
    complete!();
    await expect.poll(() => evaluate('Boolean(document.querySelector(\'button[aria-label="Start dictation"]\'))')).toBe(true);
    expect(await input()).toBe("");
    expect(await userTexts()).toEqual([]);
    await ui("click", "--name", "Start dictation");
    await ui("click", "--name", "Stop dictation");
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(2);
    complete!();
    await expect.poll(input).toBe("A sentence to review before sending.");
    expect(await userTexts()).toEqual([]);
    await ui("screenshot", "--out", join(evidence, "review.png"));
    await ui("click", "--name", "Send message");
    await expect.poll(userTexts, { timeout: 30_000 }).toEqual(["A sentence to review before sending."]);
    expect(await input()).toBe("");
    expect(uploads).toHaveLength(2);
    await ui("wait-settle", "--timeout", "30");
    console.log(JSON.stringify({ fixtureLog: info.logPath, evidence, reviewedBeforeSend: true }));
  }, 300_000);
});
