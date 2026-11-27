// Real model acceptance through the full, isolated OpenMausBot server.
// The prompts contain goals only, never tool names or execution advice.
import { copyFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const cli = process.env.OMB_VERIFY_CODEX_CLI;
const auth = process.env.OMB_VERIFY_CODEX_AUTH;
const binaryPath = process.env.OMB_VERIFY_BROWSER_BINARY;
const executablePath = process.env.OMB_VERIFY_BROWSER_CHROME;
const output = process.env.OMB_VERIFY_OUTPUT;
const models = (process.env.OMB_VERIFY_MODELS ?? "gpt-5.6-luna").split(",").map(model => model.trim()).filter(Boolean);
if (!models.length) throw new Error("Choose at least one acceptance model.");
if (!cli || !auth || !binaryPath || !executablePath || !output) throw new Error("Set explicit CLI, sign-in, browser binaries and output directory. Uses real model quota.");
mkdirSync(output, { recursive: true });
const fixture = await launchVerificationServer({}, undefined, undefined, { binaryPath, executablePath }, undefined, undefined, ["codex"]);
const api = fixtureApi(fixture.info.url);
const report: any = { fixture: fixture.info, cases: [] };
const save = () => writeFileSync(join(output, "acceptance.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ fixture: fixture.info, output: resolve(output) }));

async function observe(botId: string, prefix: string) {
  const observations: any[] = [];
  let screenshot = false;
  let viewerId: string | undefined;
  let frames = 0;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await fetch(`${fixture.info.url}/api/bots/${botId}/browser/live`, { signal: abort.signal });
    if (!response.ok || !response.body) throw new Error(`Browser observation HTTP ${response.status}`);
    const reader = response.body.getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = event.split("\n").find(line => line.startsWith("data: "));
        if (!data) continue;
        const item = JSON.parse(data.slice(6));
        const kind = event.split("\n").find(line => line.startsWith("event: "))?.slice(7);
        if (kind === "ready") viewerId = item.viewerId;
        if (kind === "frame") {
          frames++;
          const image = item.data ?? item.frame;
          if (typeof image === "string") {
            writeFileSync(join(output!, `${prefix}.jpg`), Buffer.from(image.replace(/^data:[^,]*,/, ""), "base64")); screenshot = true;
          }
          if (viewerId) await api("POST", `/api/bots/${botId}/browser/action`, { viewerId, type: "ack", seq: item.seq });
        } else observations.push({ kind, ...item });
        // The stream can begin with a cached frame from the previous page.
        // ACK and collect fresh frames before saving the final screenshot.
        if (!finishTimer && screenshot && observations.some(item => item.kind === "url" || item.kind === "tabs")) finishTimer = setTimeout(() => abort.abort(), 4_000);
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) observations.push({ error: String(error) });
  } finally { clearTimeout(timeout); clearTimeout(finishTimer); abort.abort(); }
  return { observations, screenshot, frames };
}

try {
  const codexHome = join(fixture.info.dataDir, ".codex");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  copyFileSync(auth, join(codexHome, "auth.json"));
  await api("PUT", "/api/config", { features: { browser: true, showToolCalls: true } });
  await api("PATCH", "/api/instances/codex", { cli });
  for (const model of models) {
    const { bot } = await api("POST", "/api/bots", { name: `Browser test ${model}`, description: "A helpful assistant.", modelSelection: { instanceId: "codex", model } });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: true });
    const prompts = [
      "Open Google Calendar in your own browser.",
      "Open the GitHub page for milind-soni/OpenMausBot in your browser and tell me how the project is described there.",
    ];
    for (const [index, prompt] of prompts.entries()) {
      const entry: any = { model, botId: bot.id, prompt };
      report.cases.push(entry); save();
      console.log(JSON.stringify({ model, prompt }));
      entry.sent = await runControlOmb(["send", "--bot", bot.id, "--text", prompt, "--url", fixture.info.url]);
      const deadline = Date.now() + 300_000;
      do {
        entry.wait = await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30", "--url", fixture.info.url]);
        save();
        if (entry.wait?.status === "needs-user") {
          const threadId = entry.wait.taskId;
          const { messages } = await api("GET", `/api/threads/${threadId}/messages?limit=100`);
          const pending = messages.filter((message: any) => message.card?.requestId && !message.card.answered && !message.card.dismissed);
          let approved = false;
          for (const message of pending) {
            const label = `${message.card.title ?? ""} ${message.card.subtitle ?? ""}`;
            // These test goals authorize navigation, observation and selecting
            // the already configured fixture browser; never a shell or login.
            if (!/tool "(?:select_computer|agent_browser_(?:open|snapshot|get_text|get_url|get_title|tabs|tab_list|tab_new|wait|find))"/.test(label)) continue;
            await api("POST", `/api/bots/${bot.id}/respond`, { threadId, requestId: message.card.requestId, behavior: "allow" });
            (entry.approvals ??= []).push(label); approved = true;
          }
          if (approved) continue;
        }
        if (["settled", "failed", "needs-user", "stalled"].includes(entry.wait?.status)) break;
      } while (Date.now() < deadline);
      entry.messages = await runControlOmb(["messages", "--bot", bot.id, "--limit", "15", "--url", fixture.info.url]);
      entry.browser = await observe(bot.id, `${model}-${index}`);
      const tabs = entry.browser.observations.filter((item: any) => item.kind === "tabs").at(-1)?.tabs ?? [];
      entry.verified = entry.wait?.status === "settled" && tabs.some((tab: any) => tab.active && (index === 0
        ? /^https:\/\/(?:calendar\.google\.com\/|accounts\.google\.com\/.*calendar\.google\.com|workspace\.google\.com\/(?:intl\/[a-z-]+\/)?products\/calendar\/)/.test(tab.url)
        : tab.url === "https://github.com/milind-soni/OpenMausBot"));
      save();
      console.log(JSON.stringify({ model, index, status: entry.wait?.status, browser: entry.browser }));
      if (entry.wait?.status !== "settled") break;
    }
  }
  if (report.cases.length !== models.length * 2 || report.cases.some((entry: any) => !entry.verified)) throw new Error("A real-model browser goal did not pass independent URL verification. See acceptance.json.");
} catch (error) {
  report.error = String(error); save(); throw error;
} finally {
  try {
    save();
  } finally {
    try { unlinkSync(join(fixture.info.dataDir, ".codex", "auth.json")); } catch { /* fixture cleanup remains authoritative */ }
    await fixture.close();
  }
}
