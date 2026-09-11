// Actual browser + actual BrowserPanel, always in a disposable fixture HOME.
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";


const binaryPath = process.env.OMB_VERIFY_BROWSER_BINARY;
const executablePath = process.env.OMB_VERIFY_BROWSER_CHROME;
if (!binaryPath || !executablePath) throw new Error("Set OMB_VERIFY_BROWSER_BINARY and OMB_VERIFY_BROWSER_CHROME to explicit installed binaries.");
const fixture = await launchVerificationServer(process.env, undefined, undefined, { binaryPath, executablePath });
let ui: MountedPreview | undefined;
try {
  await runControlOmb(["new-bot", "--name", "Pepper", "--url", fixture.info.url]);
  const { bots } = await (await fetch(`${fixture.info.url}/api/bots`)).json() as any;
  await fetch(`${fixture.info.url}/api/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ features: { browser: true } }) });
  await fetch(`${fixture.info.url}/api/bots/${bots[0].id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ browser: true }) });
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/browser-preview.tsx", route: "/__browser-preview.html", title: "Isolated Browser Preview",
    extraRoutes: [{
      path: "/__browser-test-page",
      handler(_req, res) {
        res.setHeader("content-type", "text/html");
        res.end(readFileSync(new URL("./testing/browser-test-page.html", import.meta.url), "utf8"));
      },
    }],
  });
  console.log(JSON.stringify({ ...fixture.info, botId: bots[0].id, previewUrl: ui.previewUrl, testPage: new URL("/__browser-test-page", ui.previewUrl).href }, null, 2));
  await parkUntilSignal();
} finally {
  await ui?.close();
  // close --all is scoped to this fixture's HOME, never the operator's.
  await promisify(execFile)(binaryPath, ["close", "--all"], { env: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, PATH: process.env.PATH }, timeout: 15_000 }).catch(() => {});
  await fixture.close();
}
