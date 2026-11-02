import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPlacesElsewhere, ONE_PLACE } from "./places-elsewhere.ts";
import { createPlacesElsewhereRoutes } from "./routes/places-elsewhere.ts";
import { PASS } from "./routes/table.ts";
import { resolveTeammate } from "./peer-roster.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), "omb-places-elsewhere-")); dirs.push(dir); return dir; };
const LAPTOP = { name: "Work laptop", kind: "computer" as const, bots: ["Scout", "Reviewer 2"] };
const GARAGE = { name: "Garage server", kind: "server" as const, bots: ["Ledger"] };
const CLOUD = { name: "My Cloud", kind: "cloud" as const, bots: ["Chief"] };

describe("where the person's other bots live", () => {
  it("says nothing it wasn't told: without the app's word, only that bots work together within one place", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir() });
    expect(here.explain("Scout")).toEqual({ hint: ONE_PLACE });
    expect(here.mentioned("ask @Scout", [])).toBe("");
    expect(here.missed("ask @Scout", [])).toEqual([]);
  });

  it("on a server of theirs: a bot on their computer lives there, and the way to bring them together is to make this server home", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir() });
    here.write({ v: 1, self: { name: "Garage server", kind: "server" }, places: [LAPTOP, CLOUD] });
    expect(here.explain("@scout")).toEqual({ where: "Scout lives on Work laptop, the person's computer, not here. Bots work together only within one place, so it can't be reached from here. "
      + "Tell the person plainly. Offer to bring their bots together on Garage server: in the app, right-click Garage server's circle at the window's left edge and choose \"Make Garage server my home\"." });
    expect((here.explain("reviewer-2") as { where: string }).where, "named loosely, as models slug names").toMatch(/^Reviewer 2 lives on Work laptop/u);
    expect((here.explain("Chief") as { where: string }).where, "two places of theirs that are no computer: by hand").toContain("export a backup in Settings → Backups on one place and import it on the other");
    expect(here.explain("Nobody"), "told, and nowhere: no such bot, as before").toBeNull();
  });

  it("on their computer: a bot on their server or My Cloud lives there, and the way is that place's one tap", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir() });
    here.write({ v: 1, self: { name: "this computer", kind: "computer" }, places: [GARAGE, CLOUD] });
    expect((here.explain("Ledger") as { where: string }).where).toBe("Ledger lives on Garage server, not here. Bots work together only within one place, so it can't be reached from here. "
      + "Tell the person plainly. Offer to bring their bots together on Garage server: in the app, right-click Garage server's circle at the window's left edge and choose \"Make Garage server my home\".");
    expect((here.explain("Chief") as { where: string }).where).toContain("Offer to bring their bots together on My Cloud: in the app, choose \"Bring them together\", or turn off \"Keep this computer's bots on this computer\" in Settings → MausBot Cloud.");
  });

  it("an @mention of a bot that lives elsewhere: told to the bot answering it, and said once to the person in a room; never for a bot named like one here", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir() });
    here.write({ v: 1, self: { name: "Garage server", kind: "server" }, places: [LAPTOP] });
    expect(here.mentioned("@Scout can you check the ledger?", [{ name: "Ledger" }])).toMatch(/^ The user named @Scout, a bot of theirs that is not here: Scout lives on Work laptop/u);
    expect(here.mentioned("@Scout can you check?", [{ name: "scout" }]), "a bot here has that name").toBe("");
    expect(here.missed("@Scout and @Ledger, look", [{ name: "Ledger" }])).toEqual([
      "Scout lives on Work laptop, so that mention didn't reach it: bots work together only within one place. To bring your bots together on Garage server, in the app, right-click Garage server's circle at the window's left edge and choose \"Make Garage server my home\".",
    ]);
    expect(here.missed("no mention of Scout here", [])).toEqual([]);
  });

  it("keeps the app's last word across a restart, names only", () => {
    const dir = dataDir();
    createPlacesElsewhere({ dataDir: dir, now: () => 42 }).write({ v: 1, self: { name: "Garage server", kind: "server" }, places: [LAPTOP] });
    expect(createPlacesElsewhere({ dataDir: dir }).read()).toEqual({ v: 1, self: { name: "Garage server", kind: "server" }, places: [LAPTOP], at: 42 });
  });

  it("coordinate_bots by a name that lives elsewhere says where instead of no such bot; with no word from the app, adds that bots work as one place", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir() });
    const bots = [{ id: "ledger", name: "Ledger" }, { id: "old-scout", name: "Scout", hidden: true }];
    const from = bots[0]!;
    expect(resolveTeammate(bots, from, "Reviewer 2", here.explain)).toEqual({ error: expect.stringMatching(/^No bot with id or name "Reviewer 2" — call list_bots.* Bots work together only within one place/su) });
    here.write({ v: 1, self: { name: "Garage server", kind: "server" }, places: [LAPTOP] });
    expect(resolveTeammate(bots, from, "Reviewer 2", here.explain)).toEqual({ error: expect.stringMatching(/^Reviewer 2 lives on Work laptop, the person's computer, not here\./u) });
    expect(resolveTeammate(bots, from, "Scout", here.explain), "a bot here of that name, archived: no such reachable bot, never elsewhere").toEqual({ error: expect.stringMatching(/^No bot with id or name "Scout"/u) });
    expect(resolveTeammate(bots, from, "Nobody", here.explain)).toEqual({ error: expect.not.stringContaining("Bots work together") });
  });
});

describe("/api/places/elsewhere", () => {
  const ask = async (owner: boolean, method: string, body?: unknown) => {
    const elsewhere = createPlacesElsewhere({ dataDir: dataDir() });
    const route = createPlacesElsewhereRoutes({ elsewhere, owner: () => owner });
    let answered: { status: number; body: any } | undefined;
    const out = await route({ path: "/api/places/elsewhere", method, url: new URL("http://127.0.0.1/api/places/elsewhere"), auth: { kind: "loopback", scopes: ["admin"] } as never,
      req: { resume() {} } as never, res: { setHeader() {} } as never, json: ((_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }) as never,
      readBody: (async () => body) as never });
    return { out, answered, elsewhere };
  };

  it("takes the app's word from this place's owner only, whole and well formed", async () => {
    const valid = { v: 1, self: { name: "Garage server", kind: "server" }, places: [LAPTOP] };
    expect((await ask(false, "PUT", valid)).answered).toMatchObject({ status: 403 });
    const taken = await ask(true, "PUT", valid);
    expect(taken.answered).toEqual({ status: 200, body: { ok: true } });
    expect(taken.elsewhere.read()?.places).toEqual([LAPTOP]);
    expect((await ask(true, "PUT", { ...valid, places: [{ ...LAPTOP, origin: "https://laptop.example.test" }] })).answered?.status, "names only: no address").toBe(400);
    expect((await ask(true, "PUT", { ...valid, places: [{ ...LAPTOP, bots: ["x".repeat(81)] }] })).answered?.status).toBe(400);
    expect((await ask(true, "GET")).answered).toEqual({ status: 200, body: { v: 1, places: [] } });
    expect((await ask(true, "POST", valid)).answered?.status).toBe(405);
    const other = createPlacesElsewhereRoutes({ elsewhere: createPlacesElsewhere({ dataDir: dataDir() }), owner: () => true });
    expect(await other({ path: "/api/places", method: "GET" } as never)).toBe(PASS);
  });
});
