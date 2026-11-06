// Bots in two places noticed, end to end: this computer's server and two servers of the person's own, one theirs alone
// and one with other people on it (scripts/testing/own-home-fixture.ts), with main's own wiring for the suggestion
// (electron/two-places-main.mjs) over the move to a server of their own (electron/own-home-main.mjs). Disposable homes;
// no network.
import { join } from "node:path";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { installTwoPlacesMain } from "../electron/two-places-main.mjs";
import { launchOwnHomeFixture, type OwnHomeFixture, type OwnServer } from "../scripts/testing/own-home-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fx: OwnHomeFixture;
let garage: OwnServer, family: OwnServer;

beforeAll(async () => {
  fx = await launchOwnHomeFixture();
  garage = await fx.addServer("Garage server");
  family = await fx.addServer("Family server", { OMB_SIGNIN_MEMBER_EMAILS: "friend@example.test" });
}, hostTimeout(120_000));
afterAll(async () => { await fx?.close(); });

type Side = OwnHomeFixture["local"];
const file = (name: string) => ({
  read: () => JSON.parse(readFileSync(join(fx.root, name), "utf8")),
  write: (value: unknown) => { writeFileSync(join(fx.root, `${name}.tmp`), JSON.stringify(value)); renameSync(join(fx.root, `${name}.tmp`), join(fx.root, name)); },
});
/** A bot someone made their own: a move carries it, unlike a place's untouched first bot. */
async function made(side: Side, name: string) {
  const bot = (await side("POST", "/api/bots", { name })).body.bot as { id: string };
  expect((await side("PATCH", `/api/bots/${bot.id}`, { soul: `You are ${name}.` })).status).toBe(200);
}
/** Main's suggestion as the app wires it, with no MausBot Cloud: its channels, on this computer's page. */
function install(dismissed = "two-places.json") {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const main = installTwoPlacesMain({
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); } },
    guard: (_channel: string, handler: (...args: unknown[]) => unknown) => handler,
    localRequest: (route: string, init: RequestInit = {}) => fetch(`${fx.desktopBase}${route}`, { ...init, headers: { "x-openmausbot-desktop-owner": fx.ownerCapability } }),
    fetch: fx.windowFetch, environments: () => [garage.place, family.place], cloud: () => ({ origin: null, asleep: false }),
    oneHome: { journal: () => null, keep: { state: () => ({ shown: false, on: false, moved: false }), set: async () => {} } },
    ownHome: fx.main, dismissed: file(dismissed), tell: () => {},
  });
  const call = (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!({}, ...args)) as Promise<{ suggest: { key: string; name: string; kind: string } | null }>;
  return { main, call };
}

it("appears once this computer and a server of the person's own both have bots, never for a server shared with others; Not now is remembered", async () => {
  fx.main.refresh();
  await expect.poll(() => fx.main.offers(garage.place), { timeout: 10_000, interval: 100 }).toBe(true);
  const first = install();
  try {
    await first.main.refresh({ force: true });
    expect(await first.call("two-places:state"), "each place's untouched first bot doesn't count").toEqual({ suggest: null });
    await made(fx.local, "Scout");
    await made(family.as, "Helper");
    await first.main.refresh({ force: true });
    expect(await first.call("two-places:state"), "bots here, and bots only where others sign in").toEqual({ suggest: null });
    await made(garage.as, "Ledger");
    await first.main.refresh({ force: true });
    const shown = await first.call("two-places:state");
    expect(shown).toEqual({ suggest: { key: `server:${garage.base}`, name: "Garage server", kind: "server" } });
    expect(first.main.bots().places[`server:${family.base}`], "the shared server was never asked").toBeUndefined();
    expect(await first.call("two-places:dismiss", shown.suggest!.key)).toEqual({ suggest: null });
  } finally { first.main.close(); }
  // The app opens again: the place dismissed stays dismissed.
  const again = install();
  try {
    await again.main.refresh({ force: true });
    expect(await again.call("two-places:state")).toEqual({ suggest: null });
  } finally { again.main.close(); }
}, hostTimeout(120_000));

it("Bring them together starts the move to that server, and the suggestion goes", async () => {
  const fresh = install("two-places-fresh.json");
  try {
    await fresh.main.refresh({ force: true });
    const shown = await fresh.call("two-places:state");
    expect(shown.suggest?.name).toBe("Garage server");
    expect(await fresh.call("two-places:accept", shown.suggest!.key)).toEqual({ suggest: null });
    expect(fx.main.chosen()).toMatchObject({ origin: garage.base, name: "Garage server" });
    await expect.poll(() => fx.main.view()?.place, { timeout: 10_000, interval: 50 }).toBe("Garage server");
    expect(await fresh.call("two-places:state"), "a move under way: nothing to suggest").toEqual({ suggest: null });
  } finally { fresh.main.close(); }
}, hostTimeout(120_000));
