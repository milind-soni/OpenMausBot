// Records the v1 live view's golden from the agent-browser engine: a phone's session (v1-session.ts) against the
// engine as it ships, normalized, into server/browser/viewers/testing/v1-golden.json. The new browser's v1 adapter is
// tested against that file. Needs agent-browser (OMB_AGENT_BROWSER_PATH or the tools directory) and a Chrome
// (OMB_CHROME_PATH); run with: node --experimental-strip-types scripts/testing/record-v1-golden.ts
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserLive } from "../../server/browser-live.ts";
import { BrowserRuntime } from "../../server/browser-runtime.ts";
import { agentBrowserIntegration, closeBrowserSession, resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { browserRuntimeEnv } from "../../server/browser-runtime.ts";
import { openGate } from "../../server/browser/egress/gate.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { normalizeV1, runV1Session, startV1Pages } from "../../server/browser/viewers/testing/v1-session.ts";

const binary = process.env.OMB_AGENT_BROWSER_PATH ?? resolveAgentBrowserBinary({ env: process.env });
const chrome = process.env.OMB_CHROME_PATH;
if (!binary || !chrome) throw new Error("Set OMB_AGENT_BROWSER_PATH (or install agent-browser) and OMB_CHROME_PATH.");
const sockets = mkdtempSync(join(tmpdir(), "omb-v1-golden-"));
const pages = await startV1Pages();
const gate = await openGate({ decide: async () => null });
const session = `omb-v1-golden-${randomBytes(4).toString("hex")}`;
const spec = agentBrowserIntegration({
  binaryPath: binary, session, encryptionKey: randomBytes(32).toString("hex"), persistent: false, egressPort: gate.port,
  env: { ...process.env, AGENT_BROWSER_EXECUTABLE_PATH: chrome, AGENT_BROWSER_SOCKET_DIR: sockets },
});
spec.env.AGENT_BROWSER_SOCKET_DIR = sockets;
const runtime = new BrowserRuntime({});
const live = new BrowserLive({ runtime });
try {
  const records = await runV1Session({
    open: (res) => live.open({ botId: "bot", session, spec, owner: "local-owner", isCurrent: () => true, res }),
    action: (viewerId, body) => live.action({ viewerId, botId: "bot", owner: "local-owner", body }),
  }, pages.origin);
  const golden = normalizeV1(records, pages.origin);
  writeFileSync(new URL("../../server/browser/viewers/testing/v1-golden.json", import.meta.url), `${JSON.stringify(golden, null, 2)}\n`);
  console.log(JSON.stringify(golden, null, 2));
} finally {
  live.closeAll();
  await closeBrowserSession(binary, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session }));
  await gate.close();
  await pages.close();
  await removeTempDir(sockets);
}
