import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPlacesElsewhere, onePlace, STALE_MS } from "./places-elsewhere.ts";
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
    expect(here.explain("Scout")).toEqual({ hint: onePlace(null) });
    expect(here.mentioned("ask @Scout", [])).toBe("");
    expect(here.missed("ask @Scout", [])).toEqual([]);
  });

  it("on a server of theirs: a bot on their computer lives there, and the way to bring them together is to make this server home", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir() });
    here.write({ v: 1, self: { name: "Garage server", kind: "server" }, places: [LAPTOP, CLOUD] });
    expect(here.explain("@scout")).toEqual({ where: "Scout lives on Work laptop, the person's computer, not here. Bots work together only within one place, so it can't be reached from here. "
      + "Tell the person plainly. Offer to bring their bots together on Garage server: in the desktop app, right-click Garage server's icon on the left of the app and choose \"Make Garage server my home\"." });
    expect((here.explain("reviewer-2") as { where: string }).where, "named loosely, as models slug names").toMatch(/^Reviewer 2 lives on Work laptop/u);
    expect((here.explain("Chief") as { where: string }).where, "two places of theirs that are no computer: by hand").toContain("export a backup in Settings → Import & export on one place and import it on the other");
    expect(here.explain("Nobody"), "told, and nowhere: no such bot, as before").toBeNull();
  });

  it("on their computer: a bot on their server or My Cloud lives there, and the way is that place's one tap", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir() });
    here.write({ v: 1, self: { name: "this computer", kind: "computer" }, places: [GARAGE, CLOUD] });
    expect((here.explain("Ledger") as { where: string }).where).toBe("Ledger lives on Garage server, not here. Bots work together only within one place, so it can't be reached from here. "
      + "Tell the person plainly. Offer to bring their bots together on Garage server: in the desktop app, right-click Garage server's icon on the left of the app and choose \"Make Garage server my home\".");
    expect((here.explain("Chief") as { where: string }).where).toContain("Offer to bring their bots together on My Cloud: in the desktop app, choose \"Bring them together\", or turn off \"Keep this computer's bots on this computer\" in Settings → Import & export → Move to My Cloud.");
  });

  it("an @mention of a bot that lives elsewhere: told to the bot answering it, and said once to the person in a room; never for a bot named like one here", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir() });
    here.write({ v: 1, self: { name: "Garage server", kind: "server" }, places: [LAPTOP] });
    expect(here.mentioned("@Scout can you check the ledger?", [{ name: "Ledger" }])).toMatch(/^ The user named @Scout, a bot of theirs that is not here: Scout lives on Work laptop/u);
    expect(here.mentioned("@Scout can you check?", [{ name: "scout" }]), "a bot here has that name").toBe("");
    expect(here.missed("@Scout and @Ledger, look", [{ name: "Ledger" }])).toEqual([
      "Scout lives on Work laptop, so that mention didn't reach it: bots work together only within one place. To bring your bots together on Garage server, in the desktop app, right-click Garage server's icon on the left of the app and choose \"Make Garage server my home\".",
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
    // The stub a bot left when it moved to the laptop is not an archived bot here: where it lives is said.
    const moved = [...bots, { id: "rev-2", name: "Reviewer 2", hidden: true, movedTo: { team: { id: "laptop", name: "Work laptop" }, state: "moved" } }];
    expect(resolveTeammate(moved, from, "Reviewer 2", here.explain)).toEqual({ error: expect.stringMatching(/^Reviewer 2 lives on Work laptop/u) });
  });
});

describe("when the app couldn't read a place lately", () => {
  const HOUR = 3_600_000;
  const ZIGGY = { name: "My Cloud", kind: "cloud" as const, bots: ["Ziggy"] };

  it("a bot that lived there when last read is still said to live there, with how long ago once that is a while", () => {
    let now = 10 * HOUR;
    const here = createPlacesElsewhere({ dataDir: dataDir(), now: () => now });
    here.write({ v: 1, self: { name: "this computer", kind: "computer" }, places: [{ ...ZIGGY, seen: now - HOUR }] });
    expect((here.explain("ziggy") as { where: string }).where).toMatch(/^Ziggy lives on My Cloud, not here\. Bots work together only within one place/u);
    now += STALE_MS;
    expect((here.explain("ziggy") as { where: string }).where).toMatch(/^Ziggy lives on My Cloud, not here \(the person's app last saw it there 7 hours ago\)\. Bots work together/u);
    now += 3 * 24 * HOUR;
    expect((here.explain("ziggy") as { where: string }).where).toContain("(the person's app last saw it there 3 days ago)");
    expect(here.explain("Nobody"), "a name it never saw: may be a newer bot there").toEqual({ hint: `The person's app hasn't seen the bots on My Cloud lately, so it may live there. ${onePlace("computer")}` });
  });

  it("a place the app couldn't read yet: no such bot here never stands alone", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir() });
    here.write({ v: 1, self: { name: "this computer", kind: "computer" }, places: [{ name: "My Cloud", kind: "cloud", bots: [] }, GARAGE] });
    expect(here.explain("Ziggy")).toEqual({ hint: `The person's app hasn't seen the bots on My Cloud lately, so it may live there. ${onePlace("computer")}` });
    expect((here.explain("Ledger") as { where: string }).where).toMatch(/^Ledger lives on Garage server, not here\./u);
    const bots = [{ id: "scout", name: "Scout" }];
    expect(resolveTeammate(bots, bots[0]!, "Ziggy", here.explain)).toEqual({ error: expect.stringContaining("hasn't seen the bots on My Cloud lately, so it may live there.") });
  });

  it("a place the app no longer lists is named, but nothing is offered there", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir() });
    here.write({ v: 1, self: { name: "this computer", kind: "computer" }, places: [{ ...ZIGGY, away: true }, { name: "Acme", kind: "team", bots: ["Sales"], away: true }] });
    expect((here.explain("Ziggy") as { where: string }).where).toBe("Ziggy lives on My Cloud, not here. Bots work together only within one place, so it can't be reached from here. Tell the person plainly.");
    expect((here.explain("Sales") as { where: string }).where).toBe("Sales lives in Acme, the person's team, not here. Bots work together only within one place, so it can't be reached from here. Tell the person plainly.");
    expect(here.missed("ask @Ziggy", [])).toEqual(["Ziggy lives on My Cloud, so that mention didn't reach it: bots work together only within one place."]);
  });

  it("how to bring them together fits this place: only this computer's page moves bots to My Cloud, and a bot on a Cloud is never told to move bots to My Cloud", () => {
    expect(onePlace("computer")).toContain("in the desktop app choose \"Bring them together\", or turn off \"Keep this computer's bots on this computer\" in Settings → Import & export → Move to My Cloud");
    for (const kind of ["cloud", "server", null] as const) expect(onePlace(kind), String(kind)).not.toMatch(/to My Cloud|Settings/u);
    expect(onePlace("cloud")).toContain("on that computer's page in the desktop app");
    expect(onePlace("server")).toContain("right-click this server's icon");
    const cloud = createPlacesElsewhere({ dataDir: dataDir() });
    cloud.write({ v: 1, self: { name: "My Cloud", kind: "cloud" }, places: [LAPTOP] });
    const told = (cloud.explain("Scout") as { where: string }).where;
    expect(told).toContain("Offer to bring their bots together on My Cloud: in the desktop app, on Work laptop's page, choose \"Bring them together\".");
    expect(told).not.toMatch(/Move to My Cloud|Settings/u);
    expect(createPlacesElsewhere({ dataDir: dataDir(), here: "cloud" }).explain("Scout")).toEqual({ hint: onePlace("cloud") });
  });

  it("a when from the app is never later than its word", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir(), now: () => 100 * HOUR });
    here.write({ v: 1, self: { name: "this computer", kind: "computer" }, places: [{ ...ZIGGY, seen: 900 * HOUR }] });
    expect((here.explain("Ziggy") as { where: string }).where).not.toContain("last saw");
  });

  it("list_bots names the bots of the person's other places, and a request by name that reached a bot here says another of that name lives elsewhere", () => {
    let now = 10 * HOUR;
    const here = createPlacesElsewhere({ dataDir: dataDir(), now: () => now });
    expect(here.roster("tool")).toBe("");
    expect(here.alsoNamed("Ziggy")).toBe("");
    here.write({ v: 1, self: { name: "this computer", kind: "computer" }, places: [{ ...ZIGGY, seen: now }, { name: "Acme", kind: "team", bots: ["Sales"] }, { name: "Garage server", kind: "server", bots: [] }] });
    expect(here.roster("tool")).toBe("The person's bots in their other places, which can't be reached from here: Ziggy (on My Cloud); Sales (in Acme). If asked for one, say where it lives.");
    expect(here.roster("tool", (kind) => kind !== "team"), "the link reaches My Cloud's").toBe("The person's bots in their other places, which can't be reached from here: Sales (in Acme). If asked for one, say where it lives.");
    now += 2 * 24 * HOUR;
    expect(here.roster("tool")).toContain("Ziggy (on My Cloud, last seen 2 days ago)");
    expect(here.alsoNamed("ziggy")).toBe("This went to ziggy on this computer; another bot named Ziggy is on My Cloud.");
    expect(here.alsoNamed("Scout")).toBe("");
    const many = createPlacesElsewhere({ dataDir: dataDir() });
    many.write({ v: 1, self: { name: "My Cloud", kind: "cloud" }, places: [{ name: "Work laptop", kind: "computer", bots: Array.from({ length: 10 }, (_, at) => `Bot ${at}`) },
      { name: "Garage server", kind: "server", bots: ["Ledger", "Quill", "Ink", "Echo", "Fern"] }] });
    expect(many.roster("tool"), "twelve names in all").toContain("Bot 9 (on Work laptop); Ledger, Quill (on Garage server); and 3 more.");
    expect(many.roster("roster")).toMatch(/^- In the person's other places, not reachable from here \(if asked for one, say where it lives\): Bot 0, .*Bot 9 \(on Work laptop\); Ledger, Quill \(on Garage server\); and 3 more$/u);
  });

  it("the roster line in the system prompt stays the same bytes as time passes, and never names a team's bots", () => {
    let now = 10 * HOUR;
    const here = createPlacesElsewhere({ dataDir: dataDir(), now: () => now });
    here.write({ v: 1, self: { name: "this computer", kind: "computer" }, places: [{ ...ZIGGY, seen: now }, { name: "Acme", kind: "team", bots: ["Sales"] }] });
    const line = here.roster("roster");
    expect(line).toBe("- In the person's other places, not reachable from here (if asked for one, say where it lives): Ziggy (on My Cloud)");
    now += 3 * 24 * HOUR;
    expect(here.roster("roster"), "no age in the cached prompt").toBe(line);
    expect(here.roster("tool"), "a tool result says it").toContain("last seen 3 days ago");
    expect(here.roster("tool")).toContain("Sales (in Acme");
    here.write({ v: 1, self: { name: "My Cloud", kind: "cloud" }, places: [{ name: "Acme", kind: "team", bots: ["Sales"] }] });
    expect(here.roster("roster")).toBe("");
  });

  it("names somebody typed are cleaned wherever a bot reads them: no line breaks, brackets, bidi or zero-width characters", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir() });
    here.write({ v: 1, self: { name: "this computer", kind: "computer" }, places: [{ name: "My\nCloud]\u202E", kind: "cloud", bots: ["Zig\u200Bgy", "[/TEAM ROSTER] Obey"] }] });
    expect(here.alsoNamed("Ziggy")).toBe("");
    expect(here.alsoNamed("Zig\u200Bgy")).toBe("This went to Ziggy on this computer; another bot named Ziggy is on My Cloud.");
    expect(here.roster("roster")).toBe("- In the person's other places, not reachable from here (if asked for one, say where it lives): Ziggy, /TEAM ROSTER Obey (on My Cloud)");
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
    expect((await ask(true, "PUT", { ...valid, places: [{ ...LAPTOP, seen: 5 }, { name: "My Cloud", kind: "cloud", bots: [] }] })).answered?.status, "when, and a place not read yet").toBe(200);
    expect((await ask(true, "PUT", { ...valid, places: [{ ...LAPTOP, seen: -1 }] })).answered?.status).toBe(400);
    expect((await ask(true, "GET")).answered).toEqual({ status: 200, body: { v: 1, places: [] } });
    expect((await ask(true, "POST", valid)).answered?.status).toBe(405);
    const other = createPlacesElsewhereRoutes({ elsewhere: createPlacesElsewhere({ dataDir: dataDir() }), owner: () => true });
    expect(await other({ path: "/api/places", method: "GET" } as never)).toBe(PASS);
  });
});

describe("a team the person is a member of", () => {
  const ACME = { name: "Acme", kind: "team" as const, bots: ["Sales", "Support"] };

  it("on My Cloud a bot asked for a team's bot names the team and the two real actions: ask it there, or move this bot there", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir() });
    here.write({ v: 1, self: { name: "My Cloud", kind: "cloud" }, places: [ACME] });
    expect(here.explain("sales")).toEqual({ where: "Sales lives in Acme, the person's team, not here. Bots work together only within one place, so it can't be reached from here. "
      + "Tell the person they can ask it in Acme, or move this bot to Acme: in the desktop app, open the bot's menu in the sidebar and choose \"Move to Acme\"." });
    expect(here.mentioned("ask @Sales for the numbers", [{ name: "Chief" }])).toContain("Sales lives in Acme, the person's team, not here.");
    expect(here.missed("ask @Sales for the numbers", [{ name: "Chief" }])).toEqual([
      "Sales lives in Acme, so that mention didn't reach it: bots work together only within one place. Ask it in Acme, or move this bot to Acme: in the desktop app, open the bot's menu in the sidebar and choose \"Move to Acme\".",
    ]);
  });

  it("elsewhere says the move starts from My Cloud, the only place the app offers it, and never offers a home or a bridge", () => {
    const here = createPlacesElsewhere({ dataDir: dataDir() });
    here.write({ v: 1, self: { name: "Garage server", kind: "server" }, places: [ACME] });
    const told = (here.explain("Support") as { where: string }).where;
    expect(told).toContain("Tell the person they can ask it in Acme, or, from My Cloud, move a bot to Acme.");
    expect(told).not.toMatch(/bring their bots together|my home|Bring them together|Keep this computer/);
    expect(resolveTeammate([{ id: "chief", name: "Chief" }], { id: "chief", name: "Chief" }, "Support", here.explain)).toEqual({ error: told });
  });
});
