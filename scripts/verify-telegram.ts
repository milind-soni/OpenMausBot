// The per-bot Telegram card in the real renderer against a disposable fake-engine server, with a loopback stand-in for
// Telegram's Bot API: a refused token, a connected one, the t.me link, the chat linking by /start, a message answered
// on Telegram, and Disconnect. No real Telegram bot, token or chat is used.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { startFakeTelegram } from "../server/testing/fake-telegram.ts";

const TOKEN = "123456789:AAE-scoutscoutscoutscoutscoutscout0001";
const ME = 4242;
const fake = await startFakeTelegram({ [TOKEN]: "scout_bot" });
const fixture = await launchVerificationServer({ ...process.env, OMB_TELEGRAM_API_BASE: fake.url });
let ui: MountedPreview | undefined;
let browser: { close(): Promise<void> } | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const bot = (await runControlOmb(["new-bot", "--name", "Scout", "--url", fixture.info.url]) as any).bot;
  assert.ok(bot?.id, "the fixture made a bot");
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  ui = await mountPreview(fixture, { entry: "/scripts/testing/telegram-preview.tsx", route: "/__telegram.html", title: "Isolated Telegram card" });
  const { chromium } = await import(process.env.OMB_VERIFY_PLAYWRIGHT || "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OMB_VERIFY_BROWSER_CHROME || undefined });
  const context = await (browser as any).newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(ui.previewUrl);
  assert.equal(await page.evaluate(async (code: string) => (await fetch("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, cookie: true, label: "Telegram fixture" }) })).status, pairing.code), 200);
  await page.goto(`${ui.previewUrl}?bot=${bot.id}&name=Scout`);
  const output = process.env.OMB_UI_EVIDENCE_DIR || "/tmp/omb-telegram-evidence";
  mkdirSync(output, { recursive: true });
  const card = page.locator('[data-testid="telegram"]');
  const view = () => api("GET", `/api/bots/${bot.id}/telegram`);

  await card.getByLabel("Bot token", { exact: true }).waitFor();
  assert.equal(await card.getByRole("button", { name: "Connect", exact: true }).isDisabled(), true, "no token, no Connect");
  await page.screenshot({ path: join(output, "1-start.png"), fullPage: true });

  await card.getByLabel("Bot token", { exact: true }).fill("123456789:AAE-wrongwrongwrongwrongwrongwrong0000");
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await card.getByRole("alert").getByText("Telegram doesn't know that token. Copy it again from BotFather.", { exact: true }).waitFor();
  assert.equal((await view()).connected, false, "a refused token leaves the bot disconnected");
  await page.screenshot({ path: join(output, "2-refused.png"), fullPage: true });

  await card.getByLabel("Bot token", { exact: true }).fill(TOKEN);
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await card.getByText("Connected as @scout_bot", { exact: true }).waitFor();
  assert.equal(await card.getByLabel("Bot token", { exact: true }).count(), 0, "the token field is gone once connected");
  assert.doesNotMatch(readFileSync(join(fixture.info.dataDir, "telegram.json"), "utf8"), new RegExp(TOKEN.split(":")[1]!), "the saved file holds no token");
  assert.doesNotMatch(JSON.stringify(await view()), new RegExp(TOKEN.split(":")[1]!), "the view returns no token");
  await page.screenshot({ path: join(output, "3-connected.png"), fullPage: true });

  await card.getByRole("button", { name: "Link your Telegram", exact: true }).click();
  const link = card.locator('[data-testid="telegram-link-url"]');
  await link.waitFor();
  const href = await link.getAttribute("href");
  const code = /\?start=(\d{6})$/.exec(href ?? "")?.[1];
  assert.ok(code, `the link carries the code: ${href}`);
  assert.equal(href, `https://t.me/scout_bot?start=${code}`);
  await card.getByText("Waiting for you to tap Start…", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "4-link.png"), fullPage: true });

  fake.push(TOKEN, ME, `/start ${code}`, { name: "Ada" });
  await card.getByText("Linked: Ada", { exact: true }).waitFor({ timeout: 20_000 });
  assert.deepEqual(fake.sent.map((entry) => entry.text), ["You're connected to Scout. Message me here any time."]);
  await page.screenshot({ path: join(output, "5-linked.png"), fullPage: true });

  fake.push(TOKEN, ME, "What can you do?");
  const deadline = Date.now() + 60_000;
  while (fake.sent.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fake.sent.length, 2, "the bot's reply reached the chat");
  assert.equal(fake.sent[1]!.chatId, String(ME));
  assert.ok(fake.sent[1]!.text.trim().length > 0, "the reply has text");
  const tasks = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks;
  assert.ok(tasks.some((task: any) => task.title === "Telegram"), "the chat has its own Telegram thread");

  await card.getByRole("button", { name: "Disconnect", exact: true }).click();
  await card.getByLabel("Bot token", { exact: true }).waitFor();
  assert.equal((await view()).connected, false, "Disconnect forgets the token");
  await page.screenshot({ path: join(output, "6-disconnected.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, ...fixture.info, evidence: output, reply: fake.sent[1]!.text, liveTelegramTested: false }));
} finally {
  await browser?.close(); await ui?.close(); await fixture.close(); await fake.close();
}
