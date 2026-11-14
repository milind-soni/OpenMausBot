// A move into a Cloud on its free trial: an AI key this computer has goes to My Cloud and is kept there, but no bot runs
// on it while the trial's Claude credit lasts; once the credit runs out, the bots go back to the key. This computer's
// server and a Cloud home (scripts/testing/cloud-send-fixture.ts) with main's own wiring between them, and a stub for the
// Admin's credit relay. Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { CLOUD_CREDIT_INSTANCE } from "./cloud-credit-provider.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { TRIAL_CREDIT_OWN_AI, TRIAL_KEY_HELD } from "./trial-credit.ts";

const RELAY_PATH = "/api/cloud/services/ai";
const CREDIT_TOKEN = `omb_ai_${randomBytes(32).toString("base64url")}`;
const OPENROUTER_KEY = `sk-or-v1-fake${randomBytes(16).toString("hex")}`;
const USED_UP = { error: { code: "trial_credit_used_up", type: "insufficient_quota", message: "Your Claude credit is used up.", param: null } };
const completions: string[] = [];
let usedUp = false;
let relay: Server;
let fx: CloudSendFixture;

beforeAll(async () => {
  relay = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const send = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
      if (req.headers.authorization !== `Bearer ${CREDIT_TOKEN}`) return send(401, { error: { code: "invalid_api_key", message: "no" } });
      if (req.method === "GET" && req.url === `${RELAY_PATH}/v1/models`) return send(200, { object: "list", data: [{ object: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }] });
      if (req.method === "POST" && req.url === `${RELAY_PATH}/v1/chat/completions`) {
        completions.push(body);
        if (usedUp) return send(402, USED_UP);
        return send(200, { id: "c1", object: "chat.completion", model: "claude-sonnet-5", choices: [{ index: 0, message: { role: "assistant", content: "Hello from the trial credit." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 } });
      }
      send(404, { error: { code: "not_found" } });
    });
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(relay.address() as AddressInfo).port}${RELAY_PATH}/v1`;
  // A new Cloud on its trial: its own Claude is signed out, and the credit is all it has.
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-trial-${randomBytes(8).toString("hex")}`, cloudSignedIn: false,
    cloudEnv: { OMB_CLOUD_AI_URL: url, OMB_CLOUD_AI_TOKEN: CREDIT_TOKEN } });
}, hostTimeout(90_000));
afterAll(async () => {
  await fx?.close();
  if (relay) await new Promise<void>((resolve) => relay.close(() => resolve()));
});

type Side = CloudSendFixture["local"];
type Instance = { instanceId: string; trialCredit?: string; snapshot: { state: string; reason?: string; authenticated?: boolean }; models: { default: string } };
const instances = async (side: Side) => (await side("GET", "/api/instances")).body.instances as Instance[];
const engine = async (side: Side, id: string) => (await instances(side)).find((instance) => instance.instanceId === id);
const botOn = async (side: Side, id: string) => ((await side("GET", "/api/bots")).body.bots as Array<{ id: string; busy?: boolean; modelSelection: { instanceId: string; model: string } }>).find((bot) => bot.id === id)!;

it("a trial's moved key is saved on My Cloud but unused until the included credit runs out, then the bots run on it", async () => {
  const { local, onCloud } = fx;
  await expect.poll(async () => (await engine(onCloud, CLOUD_CREDIT_INSTANCE))?.trialCredit, { timeout: 30_000, interval: 250 }).toBe("active");

  expect((await local("PATCH", "/api/config", { openrouter: { key: OPENROUTER_KEY } })).status).toBe(200);
  const model = (await engine(local, "openrouter"))!.models.default;
  const kit = (await local("POST", "/api/bots", { name: "Kit", modelSelection: { instanceId: "openrouter", model } })).body.bot as { id: string; threadId: string };
  expect((await local("PATCH", `/api/bots/${kit.id}`, { soul: "You are Kit." })).status).toBe(200);

  const first = await fx.move();
  expect(first.result.failed, JSON.stringify(first.result.failed)).toEqual([]);
  expect(first.result.notes).toContainEqual({ kind: "held", connection: "OpenRouter" });
  await fx.move({ final: true });
  const report = await fx.check();
  expect(report.secrets.equal, "the key is saved on My Cloud").toContain("key:openrouter");

  // While the credit lasts: the key is there but unused, the credit is not turned off by it, and Kit runs on the credit.
  expect(await engine(onCloud, "openrouter")).toMatchObject({ snapshot: { state: "unavailable", reason: TRIAL_KEY_HELD } });
  const credit = await engine(onCloud, CLOUD_CREDIT_INSTANCE);
  expect(credit).toMatchObject({ trialCredit: "active", snapshot: { state: "available" } });
  expect(credit!.snapshot.reason).not.toBe(TRIAL_CREDIT_OWN_AI);
  await expect.poll(async () => (await botOn(onCloud, kit.id)).modelSelection.instanceId, { timeout: 30_000, interval: 250 }).toBe(CLOUD_CREDIT_INSTANCE);
  expect((await onCloud("POST", `/api/bots/${kit.id}/messages`, { text: "Hello Kit.", threadId: kit.threadId })).status).toBe(202);
  await expect.poll(() => completions.length, { timeout: 30_000, interval: 200 }).toBeGreaterThan(0);
  await expect.poll(async () => !(await botOn(onCloud, kit.id)).busy, { timeout: 30_000, interval: 200 }).toBe(true);

  // The credit runs out: the key counts now, and Kit goes back to it.
  usedUp = true;
  expect((await onCloud("POST", `/api/bots/${kit.id}/messages`, { text: "And now?", threadId: kit.threadId })).status).toBe(202);
  await expect.poll(async () => (await engine(onCloud, CLOUD_CREDIT_INSTANCE))?.trialCredit, { timeout: 30_000, interval: 250 }).toBe("used_up");
  await expect.poll(async () => (await botOn(onCloud, kit.id)).modelSelection, { timeout: 30_000, interval: 250 }).toEqual({ instanceId: "openrouter", model });
  expect((await engine(onCloud, "openrouter"))!.snapshot).toMatchObject({ state: "available", authenticated: true });
}, hostTimeout(300_000));
