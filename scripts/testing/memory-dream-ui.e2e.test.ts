import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { DREAM_MARKER } from "../../server/memory-dream.ts";
import { mountPreview } from "./preview-fixture.ts";
import { connect } from "./dream-ui-browser.ts";

const chromePath = process.env.OMB_DREAM_CHROME;
(chromePath ? it : it.skip)("runs Dream now and confirms a restore through the real memory control", async () => {
  let chrome: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
  const scratch = mkdtempSync(join(tmpdir(), "omb-dream-ui-"));
  const routes = join(scratch, "routes.json");
  writeFileSync(routes, "{}");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TEXT_ROUTES: routes });
  const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const r = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(r.ok, `${method} ${path}`).toBe(true);
    return r.json();
  };
  try {
    const statement = "I want drafts under 100 words.";
    const { bot } = await api("/api/bots", "POST", { name: "Dream UI fixture" });
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: false });
    for (let i = 0; i < 2; i++) {
      const { task } = await api(`/api/bots/${bot.id}/tasks`, "POST", { title: `Draft ${i}` });
      await runControlOmb(["send", "--url", fixture.info.url, "--bot", bot.id, "--task", task.threadId, "--text", statement]);
      expect(await runControlOmb(["wait", "--url", fixture.info.url, "--bot", bot.id, "--task", task.threadId, "--timeout", "30"])).toMatchObject({ status: "settled" });
    }
    await api(`/api/bots/${bot.id}/memory/file`, "PUT", { text: "# Before dream\n" });
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: true });
    writeFileSync(routes, JSON.stringify({ [DREAM_MARKER]: JSON.stringify({ learned: [{ text: "The person wants drafts under 100 words", from: [1, 2], evidence: [statement, statement], confidence: 0.9 }] }) }));
    preview = await mountPreview(fixture, { entry: "/src/testing/memory-dream.tsx", route: "/__dream.html", title: "Dream fixture", logLevel: "silent" });
    const profile = join(fixture.info.dataDir, "chrome");
    mkdirSync(profile);
    chrome = spawn(chromePath!, ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--password-store=basic", "--use-mock-keychain", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir }, stdio: "ignore" });
    await expect.poll(() => existsSync(join(profile, "DevToolsActivePort")), { timeout: 20_000 }).toBe(true);
    const [port, endpoint] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split("\n");
    cdp = await connect(`ws://127.0.0.1:${port}${endpoint}`);
    const { targetId } = await cdp.request("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.request("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression: string) => {
      const result = await cdp!.request("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    await cdp.request("Page.navigate", { url: `${preview.previewUrl}?bot=${bot.id}` }, sessionId);
    await expect.poll(() => evaluate("document.body.textContent.includes('Dream now')"), { timeout: 30_000 }).toBe(true);
    const click = (name: string) => evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(name)}).click()`);
    await click("Dream now");
    await expect.poll(() => evaluate("document.body.textContent.includes('2 chats')"), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => evaluate("document.body.textContent.includes('Restore backup')"), { timeout: 10_000 }).toBe(true);
    await api(`/api/bots/${bot.id}/memory/file`, "PUT", { text: "# After dream\n" });
    await click("Restore backup");
    await expect.poll(() => evaluate("document.body.textContent.includes('Replace with backup')"), { timeout: 10_000 }).toBe(true);
    await click("Replace with backup");
    await expect.poll(async () => (await api(`/api/bots/${bot.id}/memory/file`)).text, { timeout: 10_000 }).toBe("# Before dream\n");
    const shot = await cdp.request("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(`${fixture.info.logPath}.dream.png`, Buffer.from(shot.data, "base64"));
    console.log(JSON.stringify({ logPath: fixture.info.logPath, screenshot: `${fixture.info.logPath}.dream.png`, workflow: "Dream now, backup, conflict, confirm, restore" }));
  } finally {
    cdp?.close();
    chrome?.kill("SIGTERM");
    await waitForExit(chrome, { graceMs: 10_000 });
    await preview?.close();
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90_000);
