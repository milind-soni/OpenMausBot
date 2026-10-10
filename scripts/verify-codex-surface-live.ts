// Opt-in real-model acceptance. No personal chats, skills, browser profiles,
// or provider configuration are loaded. Only the explicitly supplied Codex
// sign-in is copied into the disposable home; cleanup removes that copy.
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer } from "./control-omb.ts";
import { ensureUiBrowser } from "./testing/control-omb-ui.ts";
import { fixtureApi, mountPreview, parkUntilSignal } from "./testing/preview-fixture.ts";

const cli = process.env.OMB_VERIFY_CODEX_CLI;
const auth = process.env.OMB_VERIFY_CODEX_AUTH;
const model = process.env.OMB_VERIFY_CODEX_MODEL;
if (!cli || !auth || !model) throw new Error("Supply OMB_VERIFY_CODEX_CLI, OMB_VERIFY_CODEX_AUTH and OMB_VERIFY_CODEX_MODEL explicitly. This test uses real model quota.");
const browser = await ensureUiBrowser(process.env, console.error);
const fixture = await launchVerificationServer({}, undefined, undefined,
  { binaryPath: browser.binary, executablePath: browser.chrome ?? "" }, undefined, undefined, ["codex"]);
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
try {
  const codexHome = join(fixture.info.dataDir, ".codex");
  mkdirSync(codexHome, { mode: 0o700 });
  copyFileSync(auth, join(codexHome, "auth.json"));
  chmodSync(join(codexHome, "auth.json"), 0o600);
  const api = fixtureApi(fixture.info.url);
  await api("PUT", "/api/config", {
    features: { browser: true, showToolCalls: true },
  });
  await api("PATCH", "/api/instances/codex", { cli });
  const { bot } = await api("POST", "/api/bots", {
    name: "Ziggy", description: "A disposable computer-use verification assistant. Only work on the supplied local test page.",
    modelSelection: { instanceId: "codex", model },
  });
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: true });
  preview = await mountPreview(fixture, {
    entry: "/src/main.tsx", route: "/__codex-surface-live.html", title: "Isolated Codex chat-to-action test",
    extraRoutes: [{ path: "/__browser-test-page", handler(_req, res) {
      res.setHeader("content-type", "text/html");
      res.end(readFileSync(new URL("./testing/browser-test-page.html", import.meta.url), "utf8"));
    } }],
  });
  console.log(JSON.stringify({ ...fixture.info, botId: bot.id, threadId: bot.threadId,
    model, previewUrl: preview.previewUrl, testPage: new URL("/__browser-test-page", preview.previewUrl).href }, null, 2));
  await parkUntilSignal();
} finally {
  await preview?.close();
  await fixture.close();
}
