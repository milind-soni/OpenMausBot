// Bots that explain, end to end: this computer's server and servers of the person's own (scripts/testing/own-home-fixture.ts),
// the app telling each of the person's own places which bots their other places have (electron/two-places-main.mjs), and a
// bot on each side asking for a teammate that lives on the other one. Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { installTwoPlacesMain } from "../electron/two-places-main.mjs";
import { launchOwnHomeFixture, type OwnHomeFixture, type OwnServer } from "../scripts/testing/own-home-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { ONE_PLACE } from "./places-elsewhere.ts";

const KEY = randomBytes(16).toString("hex");
let fx: OwnHomeFixture;
let garage: OwnServer, family: OwnServer;

beforeAll(async () => {
  fx = await launchOwnHomeFixture({ env: { OMB_TEST_INTERNAL_CAPABILITY_KEY: KEY } });
  garage = await fx.addServer("Garage server", { FAKE_CLAUDE_DUMP: join(fx.root, "garage-turn.json") });
  family = await fx.addServer("Family server", { OMB_SIGNIN_MEMBER_EMAILS: "friend@example.test" });
}, hostTimeout(120_000));
afterAll(async () => { await fx?.close(); });

type Side = OwnHomeFixture["local"];
type Bot = { id: string; threadId: string };
async function made(side: Side, name: string): Promise<Bot> {
  const bot = (await side("POST", "/api/bots", { name })).body.bot as Bot;
  expect((await side("PATCH", `/api/bots/${bot.id}`, { soul: `You are ${name}.` })).status).toBe(200);
  return bot;
}
/** A turn of `bot`'s on the server at `base` asks for a teammate by name, as coordinate_bots does. */
async function coordinate(base: string, bot: Bot, name: string): Promise<{ status: number; error: string }> {
  const minted = await fetch(`${base}/api/testing/internal-capability`, { method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": KEY },
    body: JSON.stringify({ botId: bot.id, threadId: bot.threadId }) });
  const { token } = await minted.json() as { token: string };
  const asked = await fetch(`${base}/api/internal/coordinate-bots`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ botIds: [name], message: "Check this month's numbers." }) });
  return { status: asked.status, error: ((await asked.json()) as { error: string }).error };
}

it("a bot asking for a teammate on the person's other place hears where it lives and how to bring them together; never on a server shared with others", async () => {
  const scout = await made(fx.local, "Scout");
  const ledger = await made(garage.as, "Ledger");
  const helper = await made(family.as, "Helper");

  // Before the app said anything: no such bot, and that bots work together only within one place.
  const before = await coordinate(garage.base, ledger, "Scout");
  expect(before.status).toBe(403);
  expect(before.error).toMatch(/^No bot with id or name "Scout" — call list_bots/u);
  expect(before.error).toContain(ONE_PLACE);

  fx.main.refresh();
  await expect.poll(() => fx.main.owns(garage.place), { timeout: 10_000, interval: 100 }).toBe(true);
  const file = join(fx.root, "two-places.json");
  const main = installTwoPlacesMain({
    ipcMain: { handle: () => {} }, guard: (_channel: string, handler: (...args: unknown[]) => unknown) => handler,
    localRequest: (route: string, init: RequestInit = {}) => fetch(`${fx.desktopBase}${route}`, { ...init, headers: { ...init.headers as Record<string, string>, "x-openmausbot-desktop-owner": fx.ownerCapability } }),
    fetch: fx.windowFetch, environments: () => [garage.place, family.place], cloud: () => ({ origin: null, asleep: false }),
    oneHome: { journal: () => null, keep: { state: () => ({ shown: false, on: false, moved: false }), set: async () => {} } },
    ownHome: fx.main, tell: () => {},
    dismissed: { read: () => JSON.parse(readFileSync(file, "utf8")), write: (value: unknown) => { writeFileSync(`${file}.tmp`, JSON.stringify(value)); renameSync(`${file}.tmp`, file); } },
  });
  try {
    await main.refresh({ force: true });
    expect((await garage.as("GET", "/api/places/elsewhere")).body).toMatchObject({ v: 1, self: { name: "Garage server", kind: "server" },
      places: [{ name: "Work laptop", kind: "computer", bots: ["Scout"] }] });
    expect((await fx.local("GET", "/api/places/elsewhere")).body).toMatchObject({ v: 1, self: { name: "this computer", kind: "computer" },
      places: [{ name: "Garage server", kind: "server", bots: ["Ledger"] }] });
    expect((await family.as("GET", "/api/places/elsewhere")).status, "a server others sign in to is never told").toBe(403);
    expect((await family.as("PUT", "/api/places/elsewhere", { v: 1, self: { name: "Family server", kind: "server" }, places: [] })).status).toBe(403);
    const fromItself = await fetch(`${family.base}/api/places/elsewhere`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, self: { name: "Family server", kind: "server" }, places: [{ name: "Work laptop", kind: "computer", bots: ["Scout"] }] }) });
    expect(fromItself.status, "not even from a program on that server").toBe(403);
  } finally { main.close(); }

  const onGarage = await coordinate(garage.base, ledger, "scout");
  expect(onGarage).toEqual({ status: 403, error: "Scout lives on Work laptop, the person's computer, not here. Bots work together only within one place, so it can't be reached from here. "
    + "Tell the person plainly. Offer to bring their bots together on Garage server: in the app, right-click Garage server's circle at the window's left edge and choose \"Make Garage server my home\"." });
  const onComputer = await coordinate(fx.desktopBase, scout, "Ledger");
  expect(onComputer.status).toBe(403);
  expect(onComputer.error).toMatch(/^Ledger lives on Garage server, not here\. .* choose "Make Garage server my home"\.$/u);
  const typo = await coordinate(fx.desktopBase, scout, "Ledgr");
  expect(typo.error, "told, and nowhere: no such bot, as before").toMatch(/^No bot with id or name "Ledgr" — call list_bots/u);
  expect(typo.error).not.toContain("Bots work together");
  const shared = await coordinate(family.base, helper, "Scout");
  expect(shared.error, "never told where the person's other bots live").not.toContain("Work laptop");

  // The person @mentions Scout to Ledger: the turn is told where Scout lives, and a room says it once in plain words.
  expect((await garage.as("POST", `/api/bots/${ledger.id}/messages`, { text: "@Scout can you check this month's numbers?", threadId: ledger.threadId })).status).toBe(202);
  await expect.poll(() => { try { return JSON.parse(readFileSync(join(fx.root, "garage-turn.json"), "utf8")).systemPrompt ?? ""; } catch { return ""; } }, { timeout: 60_000, interval: 200 })
    .toContain("The user named @Scout, a bot of theirs that is not here: Scout lives on Work laptop, the person's computer, not here.");
  const idle = async () => ((await garage.as("GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>).every((bot) => bot.activity !== "working" && !bot.busy);
  await expect.poll(idle, { timeout: 60_000, interval: 200 }).toBe(true);
  const room = (await garage.as("POST", "/api/groups", { memberIds: [ledger.id], name: "Books",
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: ledger.id } } })).body.group as { id: string; threadId: string };
  const posted = await garage.as("POST", `/api/groups/${room.id}/messages`, { text: "@Scout and @Ledger, check the numbers", threadId: room.threadId });
  expect(posted.status, JSON.stringify(posted.body)).toBe(202);
  const said = async () => ((await garage.as("GET", `/api/threads/${room.threadId}/messages?limit=200`)).body?.messages ?? [])
    .filter((row: { kind?: string; tool?: { name?: string } }) => row.kind === "activity" && row.tool?.name?.startsWith("Scout lives on"));
  await expect.poll(async () => (await said()).map((row: { tool: { name: string } }) => row.tool.name), { timeout: 30_000, interval: 200 }).toEqual([
    "Scout lives on Work laptop, so that mention didn't reach it: bots work together only within one place. To bring your bots together on Garage server, in the app, right-click Garage server's circle at the window's left edge and choose \"Make Garage server my home\".",
  ]);
}, hostTimeout(180_000));
