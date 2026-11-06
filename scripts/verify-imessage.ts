// The per-bot iMessage card in the real renderer against a disposable fake-engine server, with a loopback stand-in for
// Sendblue's API: a refused key, a connected one, the command and sms link, the phone linking by text, a message
// answered over iMessage, and Disconnect. No real Sendblue account, key, number or phone is used.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { startFakeSendblue } from "../server/testing/fake-sendblue.ts";

const ACCOUNT = { keyId: "key-scout-0001", secret: "secret-scout-aaaa-bbbb", number: "+14155550100" };
const ADA = "+14155550123";
const fake = await startFakeSendblue({ [ACCOUNT.keyId]: { secret: ACCOUNT.secret, number: ACCOUNT.number } });
const fixture = await launchVerificationServer({ ...process.env, OMB_SENDBLUE_API_BASE: fake.url });
let ui: MountedPreview | undefined;
let browser: { close(): Promise<void> } | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const bot = (await runControlOmb(["new-bot", "--name", "Scout", "--url", fixture.info.url]) as any).bot;
  assert.ok(bot?.id, "the fixture made a bot");
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  ui = await mountPreview(fixture, { entry: "/scripts/testing/imessage-preview.tsx", route: "/__imessage.html", title: "Isolated iMessage card" });
  const { chromium } = await import(process.env.OMB_VERIFY_PLAYWRIGHT || "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OMB_VERIFY_BROWSER_CHROME || undefined });
  const context = await (browser as any).newContext({ viewport: { width: 900, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(ui.previewUrl);
  assert.equal(await page.evaluate(async (code: string) => (await fetch("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, cookie: true, label: "iMessage fixture" }) })).status, pairing.code), 200);
  await page.goto(`${ui.previewUrl}?bot=${bot.id}&name=Scout`);
  const output = process.env.OMB_UI_EVIDENCE_DIR || "/tmp/omb-imessage-evidence";
  mkdirSync(output, { recursive: true });
  const card = page.locator('[data-testid="imessage"]');
  const view = () => api("GET", `/api/bots/${bot.id}/imessage`);
  const keyId = card.getByLabel("Sendblue API key ID", { exact: true });
  const secret = card.getByLabel("Sendblue API secret", { exact: true });
  const number = card.getByLabel("Sendblue number", { exact: true });
  const connect = card.getByRole("button", { name: "Connect", exact: true });

  await keyId.waitFor();
  assert.equal(await connect.isDisabled(), true, "no key, no Connect");
  await page.screenshot({ path: join(output, "1-start.png"), fullPage: true });

  await keyId.fill(ACCOUNT.keyId);
  await secret.fill("wrong-secret-wrong");
  await number.fill(ACCOUNT.number);
  await connect.click();
  await card.getByRole("alert").getByText("Sendblue doesn't know that API key ID and secret. Copy both again from the Sendblue dashboard.", { exact: true }).waitFor();
  assert.equal((await view()).connected, false, "a refused key leaves the bot disconnected");
  await page.screenshot({ path: join(output, "2-refused.png"), fullPage: true });

  await secret.fill(ACCOUNT.secret);
  await number.fill("+1 (415) 555-0100");
  await connect.click();
  await card.getByText(`Connected to ${ACCOUNT.number}`, { exact: true }).waitFor();
  assert.equal(await secret.count(), 0, "the secret field is gone once connected");
  const saved = readFileSync(join(fixture.info.dataDir, "imessage.json"), "utf8");
  for (const hidden of [ACCOUNT.secret, ACCOUNT.keyId]) {
    assert.ok(!saved.includes(hidden), "the saved file holds no key");
    assert.ok(!JSON.stringify(await view()).includes(hidden), "the view returns no key");
  }
  await page.screenshot({ path: join(output, "3-connected.png"), fullPage: true });

  await card.getByRole("button", { name: "Link your iPhone", exact: true }).click();
  const command = card.locator('[data-testid="imessage-command"]');
  await command.waitFor();
  const code = /^link (\d{6})$/.exec((await command.textContent()) ?? "")?.[1];
  assert.ok(code, "the card shows the command with its code");
  assert.equal(await card.locator('[data-testid="imessage-link-url"]').getAttribute("href"), `sms:${ACCOUNT.number}&body=link%20${code}`);
  await card.getByText("Waiting for your text…", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "4-link.png"), fullPage: true });

  fake.push(ACCOUNT.keyId, ADA, `link ${code}`);
  await card.getByText(`Linked: ${ADA}`, { exact: true }).waitFor({ timeout: 20_000 });
  assert.deepEqual(fake.sent.map((entry) => entry.content), ["You're connected to Scout. Message me here any time."]);
  await page.screenshot({ path: join(output, "5-linked.png"), fullPage: true });

  fake.push(ACCOUNT.keyId, ADA, "What can you do?");
  const deadline = Date.now() + 60_000;
  while (fake.sent.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fake.sent.length, 2, "the bot's reply reached the phone");
  assert.equal(fake.sent[1]!.to, ADA);
  assert.equal(fake.sent[1]!.from, ACCOUNT.number);
  assert.ok(fake.sent[1]!.content.trim().length > 0, "the reply has text");
  const tasks = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks;
  assert.ok(tasks.some((task: any) => task.title === "iMessage"), "the phone has its own iMessage thread");

  await card.getByRole("button", { name: "Disconnect", exact: true }).click();
  await secret.waitFor();
  assert.equal((await view()).connected, false, "Disconnect forgets the key");
  await page.screenshot({ path: join(output, "6-disconnected.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, ...fixture.info, evidence: output, reply: fake.sent[1]!.content, liveSendblueTested: false }));
} finally {
  await browser?.close(); await ui?.close(); await fixture.close(); await fake.close();
}
