import { existsSync, readFileSync, rmSync } from "node:fs";
import { request, type ClientRequest } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchCloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const bodyGate = `import { IncomingMessage } from "node:http";
import { writeFileSync } from "node:fs";
const on = IncomingMessage.prototype.on;
IncomingMessage.prototype.on = function(event, listener) {
  const result = on.call(this, event, listener);
  if (event === "end" && this.url === "/api/internal/chief-operator") writeFileSync(process.env.OMB_DATA_DIR + "/body-entered", "");
  return result;
};`;

it.each(["apply", "rollback"].flatMap(action => ["owner", "mixed", "revoked", "ended"].map(change => ({ action, change }))))(
  "rechecks the current owner, grant and capability after a gated $action body: $change", async ({ action, change }) => {
    const fixture = await launchCloudSendFixture({ onePasswordToken: "ops_fake-operator-body-race",
      env: { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(bodyGate)}` },
      desktopEngine: 'process.env.FAKE_CLAUDE_MODE = "hang"; process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";' });
    const marker = join(fixture.desktopDataDir, "body-entered");
    const dumpPath = join(fixture.root, "desktop", "dump.json");
    let pending: ClientRequest | undefined;
    const pids: number[] = [];
    const bytes = () => ["config.json", "chief-operator.json"].map(file => readFileSync(join(fixture.desktopDataDir, file)));
    try {
      pids.push((await fixture.local("GET", "/api/health")).body.pid, (await fixture.onCloud("GET", "/api/health")).body.pid);
      const bot = (await fixture.local("POST", "/api/bots", { name: "Operator" })).body.bot;
      expect((await fixture.local("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);
      expect((await fixture.local("PATCH", "/api/config", { language: "en" })).status).toBe(200);
      const grant = await fixture.local("PUT", "/api/chief-operator", { botId: bot.id, read: ["language"], write: ["language"], expectedRevision: "none" });
      expect(grant.status).toBe(200);
      expect((await fixture.local("POST", `/api/bots/${bot.id}/messages`, { text: "Change the language." })).status).toBe(202);
      await expect.poll(() => existsSync(dumpPath), { timeout: 10_000 }).toBe(true);
      const mounted = JSON.parse(readFileSync(dumpPath, "utf8")).mcpConfig.mcpServers.agents;
      const url = `${fixture.desktopBase}/api/internal/chief-operator`;
      const headers = { "content-type": "application/json", authorization: `Bearer ${mounted.env.OMB_COMMS_TOKEN}` };
      const call = async (body: unknown) => {
        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        expect(response.status).toBe(200);
        return await response.json() as any;
      };
      const preview = await call({ action: "preview", setting: "language", value: "fr" });
      const applied = action === "rollback" ? await call({ action: "apply", previewId: preview.previewId, expectedRevision: preview.revision }) : null;
      const body = JSON.stringify(action === "apply" ? { action, previewId: preview.previewId, expectedRevision: preview.revision }
        : { action, receiptId: applied.receiptId, expectedRevision: applied.revision });
      rmSync(marker, { force: true });
      const response = new Promise<number>((resolve, reject) => {
        pending = request(url, { method: "POST", headers }, res => {
          res.resume();
          res.on("end", () => { resolve(res.statusCode!); });
          res.on("error", reject);
        });
        pending.on("error", reject);
        pending.setTimeout(10_000, () => { pending!.destroy(new Error("gated Operator request did not finish")); });
        pending.write(body.slice(0, -1));
      });
      void response.catch(() => {});
      await expect.poll(() => existsSync(marker), { timeout: 5_000 }).toBe(true);
      if (change === "mixed") {
        const code = (await fixture.local("POST", "/api/auth/pairing", { scopes: ["client"] })).body.code;
        const token = (await fixture.local("POST", "/api/auth/pair", { code })).body.token;
        const steered = await fetch(`${fixture.desktopBase}/api/bots/${bot.id}/messages`, { method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ text: "Another person's steer.", followUp: "steer" }) });
        expect(steered.status).toBe(202);
      } else if (change === "revoked") {
        expect((await fixture.local("DELETE", "/api/chief-operator", { expectedRevision: grant.body.revision })).status).toBe(200);
      } else if (change === "ended") {
        expect((await fixture.local("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      }
      const before = bytes();
      pending!.end(body.slice(-1));
      const status = await response;
      const unchanged = bytes().every((value, i) => value.equals(before[i]!));
      console.info(JSON.stringify({ operatorBodyRace: { action, change, status, unchanged,
        url: fixture.desktopBase, dataDir: fixture.desktopDataDir } }));
      expect.soft(status).toBe(change === "owner" ? 200 : change === "ended" ? 401 : 403);
      if (change === "owner") expect((await fixture.local("GET", "/api/config")).body.language).toBe(action === "apply" ? "fr" : "en");
      else expect(unchanged).toBe(true);
    } finally {
      pending?.destroy();
      await fixture.close();
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      console.info(JSON.stringify({ operatorBodyRaceCleanup: { action, change, pids, serversExited: true } }));
    }
  }, hostTimeout(45_000),
);
