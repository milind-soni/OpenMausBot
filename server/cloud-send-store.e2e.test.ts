// My Cloud's room for attachments, end to end: a move into a Cloud whose attachment store is full says so for the
// attachment, still carries its chat, leaves no partial file there, and its check names the attachment as missing.
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const LIMIT = 64 * 1024;
let fx: CloudSendFixture;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-store-${randomBytes(8).toString("hex")}`, cloudEnv: { OMB_ATTACHMENTS_MAX_BYTES: String(LIMIT) } });
}, hostTimeout(90_000));
afterAll(async () => { await fx?.close(); });

const idle = async () => (await fx.local("GET", "/api/bots")).body.bots.every((entry: { activity?: string; busy?: boolean }) => entry.activity !== "working" && !entry.busy);

it("a full attachment store refuses the attachment in plain words, the chat still goes, and no partial file is left", async () => {
  const bot = (await fx.local("POST", "/api/bots", { name: "Ivy", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as { id: string; threadId: string };
  const small = await fx.picture(randomBytes(1024));
  const big = await fx.picture(randomBytes(LIMIT * 2));
  const folder = join(fx.root, "desktop", ".openmausbot", "attachments");
  const say = async (text: string, name: string) => {
    expect((await fx.local("POST", `/api/bots/${bot.id}/messages`, { text: `${text}\n\n<attached-image path="${join(folder, name)}" name="${name}" />`, threadId: bot.threadId })).status).toBe(202);
    await expect.poll(idle, { timeout: 60_000, interval: 100 }).toBe(true);
  };
  const [smallName, bigName] = [small, big].map((url) => url.split("/").pop()!);
  await say("A small one.", smallName);
  await say("A big one.", bigName);

  const moved = await fx.move();
  expect(moved.result.failed).toEqual([{ key: `attachment:${bigName}`, kind: "chats", label: "Attachment",
    error: "My Cloud's room for attachments is full, so an attachment did not go. Its chat went without it." }]);
  expect(moved.result.chats?.left).toBe(0);
  const stored = readdirSync(join(fx.root, "cloud", ".openmausbot", "attachments"));
  expect(stored).toContain(smallName);
  expect(stored).not.toContain(bigName);
  expect(stored.filter((name) => name.endsWith(".partial")), "no partial file is left behind").toEqual([]);

  const report = await fx.check();
  expect(report.ok).toBe(false);
  expect(report.attachments).toEqual([bigName]);
  expect(report.chats.find((entry) => entry.threadId === bot.threadId)).toMatchObject({ missing: 0, path: "equal" });
}, hostTimeout(180_000));
