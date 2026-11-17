// A cloud computer woken for a turn that is slow to answer, or never answers: the turn waits for it patiently, then
// restarts it (its files kept) and waits again, and only one still silent after that, with every guard holding, is set
// aside (stopped, renamed, kept with its files) for a new one. Nothing here is ever deleted by the automatic path.
// A loopback stand-in for the Cloud's relay plays the provider. No network, no real computer; the data folder is the
// test's own, and the clock the waits read is the test's. The turn's wait and the background recovery share one health
// record, as they do in the app.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";
import type { BotRecord } from "./store.ts";

type Box = { id: string; name: string; state: string; hydrated?: boolean };

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
let made = 0;
const newId = () => `bx_${String(made++).padStart(8, "0").split("").map((digit) => ALPHABET[Number(digit)]).join("")}`;
const opId = (boxId: string) => `bdop_${Buffer.from(boxId.padEnd(16, "x")).toString("hex").slice(0, 32)}`;

let server: Server;
let boxes: Box[] = [];
let requests: Array<{ method: string; path: string; command?: string; name?: string }> = [];
/** Until when, on the test's clock, each computer leaves every command unanswered (the gateway's 502). */
let silentUntil = new Map<string, number>();
/** A computer made from now on is silent for this long, on the test's clock. */
let newSilentMs = 0;
/** What the provider says of a computer's disk, on every computer: unset says nothing. */
let hydrated: boolean | undefined;
/** The Admin turns a new computer away: the plan's computers at once are all held. */
let noRoom = false;
/** A resume the provider accepts but never finishes. */
let resumeHangs = false;
/** A set-aside rename answers this late, in real milliseconds. */
let renameDelayMs = 0;
let at = 50_000_000;
const now = () => at;

const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://relay.test");
      const path = url.pathname.replace(/^\/relay\/api\/box\/v1/, "");
      const body = raw ? JSON.parse(raw) : {};
      const method = req.method ?? "GET";
      requests.push({ method, path, ...(typeof body.command === "string" ? { command: body.command } : {}), ...(typeof body.name === "string" ? { name: body.name } : {}) });
      const shown = (box: Box) => ({ ...box, ...(hydrated === undefined ? {} : { hydrated }) });
      if (path === "/boxes" && method === "GET") return send(res, 200, { ok: true, boxes: boxes.map(shown), pageInfo: { nextCursor: null } });
      if (path === "/boxes" && method === "POST") {
        if (noRoom) {
          const fields = { reason: "at_once", plan: "Personal", limit: 1, used: 1 };
          return send(res, 429, { ok: false, code: "limit_reached", message: "Your Personal plan includes 1 cloud computer at once. Delete one to start another.", ...fields, error: { code: "limit_reached", ...fields } });
        }
        const box = { id: newId(), name: "", state: "ready" };
        boxes.push(box);
        if (newSilentMs) silentUntil.set(box.id, at + newSilentMs);
        return send(res, 200, { ok: true, box });
      }
      const operation = /^\/deletion-operations\/([^/]+)$/.exec(path);
      if (operation && method === "GET") return send(res, 200, { ok: true, operation: { id: operation[1], kind: "box", targetId: "", status: "completed" } });
      const match = /^\/boxes\/([^/]+)(?:\/(stop|resume|commands|desktop))?$/.exec(path);
      const box = match ? boxes.find((candidate) => candidate.id === match[1]) : undefined;
      if (!match || !box) return send(res, 404, { ok: false, code: "not_found", message: "That cloud computer does not exist." });
      const action = match[2];
      if (!action && method === "GET") return send(res, 200, { ok: true, box: shown(box) });
      if (!action && method === "PATCH") {
        const renamed = () => { box.name = body.name; send(res, 200, { ok: true, box: shown(box) }); };
        if (renameDelayMs && String(body.name).includes("-set-aside-")) { setTimeout(renamed, renameDelayMs); return; }
        return renamed();
      }
      if (!action && method === "DELETE") {
        boxes = boxes.filter((candidate) => candidate.id !== box.id);
        return send(res, 202, { ok: true, operation: { id: opId(box.id), kind: "box", targetId: box.id, status: "completed" } });
      }
      if (action === "stop") { box.state = "archived"; return send(res, 200, { ok: true, box: shown(box) }); }
      if (action === "resume") { if (!resumeHangs) box.state = "ready"; return send(res, 200, { ok: true, box: shown(box) }); }
      if (action === "commands") {
        if ((silentUntil.get(box.id) ?? -Infinity) > at) return send(res, 502, { ok: false, code: "upstream_unavailable", message: "Cloud computers could not be reached." });
        return send(res, 200, { exitCode: 0, stdout: "captured", stderr: "" });
      }
      if (action === "desktop") return send(res, 200, { desktopUrl: "https://desktop.test/view" });
      return send(res, 404, { ok: false });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  vi.stubEnv("OMB_CLOUD_BOAT_URL", `http://127.0.0.1:${port}/relay/api/box/v1`);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", "box_omb_synthetic");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const cfg = {} as AppConfig;
let boat: typeof import("./boat.ts");
let words: typeof import("../shared/cloud-computer-recovery.ts");
let tools: typeof import("./cloud-computer-tools.ts");
let claims: typeof import("./auto-vm-claims.ts");
let power: ReturnType<typeof import("./host/cloud-computer-power.ts").createCloudComputerPower>;
let recovery: import("./boat-recovery.ts").BoatRecovery;
let health: import("./boat-health.ts").BoatHealth;
let told: Array<[string, string, Record<string, string>?]>;
let logs: string[];
let hooks: string[];
let autoOn: boolean;
let inUseByOther: Set<string>;
let personViewing: Set<string>;
/** Another computer of this installation keeps answering commands while the test's clock moves. */
let witness: boolean;
/** Each probe of the turn's wait ends this long after it was sent, on the test's clock. */
let probeTakesMs: number;
let stalledLoop: boolean;
/** The 7-day sweep may send its one DELETE in this test; nothing else ever may. */
let sweepDeletes: boolean;
let dir: string;
let replacementsFile: string;
/** How long a restart waits for the provider to report the computer ready again, in real milliseconds. */
let wakeBudgetMs: number;

async function build() {
  const { createBoatHealth } = await import("./boat-health.ts");
  const { createBoatReadiness } = await import("./boat-ready.ts");
  const { createBoatRecovery } = await import("./boat-recovery.ts");
  const { createCloudComputerCounters } = await import("./cloud-computer-counters.ts");
  const { createCloudComputerPower } = await import("./host/cloud-computer-power.ts");
  health = createBoatHealth(now);
  const readiness = createBoatReadiness({
    health, counters: createCloudComputerCounters(now), now,
    probe: async (config, boxId) => {
      const out = await boat.runCommand(config, boxId, "true", { timeoutMs: 8_000, probe: true });
      at += probeTakesMs;
      return out.ok ? true : out.unanswered ? false : null;
    },
    sleep: async (ms) => { at += ms; if (witness) health.answered("bx_witness"); },
  });
  recovery = createBoatRecovery({
    cfg: () => cfg, tell: (owner, line, vars) => told.push(vars ? [owner, line, vars] : [owner, line]), log: (line) => logs.push(line), file: replacementsFile, now, health,
    pollMs: 5, recheckMs: 60_000, setAsideRecheckMs: 60_000, wakeBudgetMs, readiness, autoReplace: () => autoOn,
    usedByOther: (owner) => inUseByOther.has(owner), personActive: (owner) => personViewing.has(owner), stalled: () => stalledLoop, turnWaiting: (boxId) => power.waiting(boxId),
  });
  power = createCloudComputerPower({
    cfg, busy: () => false, claim: () => () => {}, owners: () => [], routines: () => [], routineComputer: () => null,
    broadcast: () => {}, log: () => {}, readiness, health, wakeTimedOut: (owner, boxId, ctx) => recovery.wakeTimedOut(owner, boxId, ctx),
  });
}

beforeEach(async () => {
  boxes = []; requests = []; silentUntil = new Map(); newSilentMs = 0; hydrated = undefined; noRoom = false; resumeHangs = false; renameDelayMs = 0;
  at += 30 * 24 * 60 * 60_000;
  told = []; logs = []; hooks = []; autoOn = true; inUseByOther = new Set(); personViewing = new Set();
  witness = false; probeTakesMs = 0; stalledLoop = false; sweepDeletes = false; wakeBudgetMs = 10_000;
  dir = mkdtempSync(join(tmpdir(), "omb-wake-"));
  replacementsFile = join(dir, "boat-replacements.json");
  vi.resetModules();
  boat = await import("./boat.ts");
  words = await import("../shared/cloud-computer-recovery.ts");
  tools = await import("./cloud-computer-tools.ts");
  claims = await import("./auto-vm-claims.ts");
  await build();
});
afterEach(() => {
  recovery.close();
  power.close();
  rmSync(dir, { recursive: true, force: true });
  // The automatic path never deletes a computer: only the sweep of a set-aside one whose seven days are up may.
  if (!sweepDeletes) expect(requests.filter((request) => request.method === "DELETE")).toEqual([]);
});

let bots = 0;
/** A bot whose computer went to sleep, and stays silent for `silentMs` once it is woken. */
async function asleep(silentMs: number) {
  const botId = `bot-wake-${bots++}`;
  const box = { id: newId(), name: await boat.boatNameFor(botId), state: "archived" };
  boxes.push(box);
  silentUntil.set(box.id, silentMs === Infinity ? Infinity : at + silentMs);
  return { bot: { id: botId, name: "Scout" } as BotRecord, box };
}
const turn = (threadId = "thread-1") => ({ threadId, generation: "g1" });
const ready = (bot: BotRecord) => power.ready(bot, turn(), {
  budgetMs: 30_000, onWaking: () => hooks.push("waking"), onRestarting: () => hooks.push("restarting"), onReplacing: () => hooks.push("replacing"), onRestoring: () => hooks.push("restoring"),
});
const failure = (bot: BotRecord) => ready(bot).then(() => null, (error: unknown) => error as Error);
const creates = () => requests.filter((request) => request.method === "POST" && request.path === "/boxes");
const stops = (boxId: string) => requests.filter((request) => request.method === "POST" && request.path === `/boxes/${boxId}/stop`);
const renames = (boxId: string) => requests.filter((request) => request.method === "PATCH" && request.path === `/boxes/${boxId}`);
const SET_ASIDE_NAME = /^ogb-[a-f0-9]{12}-[a-z0-9]{1,8}-[a-f0-9]{6}-set-aside-\d{4}-\d{2}-\d{2}$/;
/** One computer call as the bot makes it, through the same route a turn's calls take: by default an exec of `echo hi`. */
const call = (boxId: () => string, extra: Partial<Parameters<typeof tools.cloudComputerRpc>[1]> = {}, name = "exec") =>
  tools.cloudComputerRpc({ method: "tools/call", params: { name, arguments: name === "exec" ? { command: "echo hi" } : {} } }, {
    cfg, signal: new AbortController().signal, boxId, gate: async () => ({ held: false }), assertActive: () => {}, recovery, ...extra,
  });
const ranEcho = () => requests.filter((request) => request.command?.includes("echo hi")).length;
/** Left as it is: a passing failure that says MausBot keeps trying, never "do not retry". */
function keptAsItIs(error: Error | null) {
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toMatch(/MausBot keeps trying in the background; trying again later is fine/);
  expect(error!.message).not.toMatch(/Do not retry|replac/i);
  expect(claims.transientClaimFailure(error)).toBe(true);
}

describe("a woken cloud computer that is slow to answer", () => {
  it("is waited for inside the wake's patience: the bot's command runs once, nothing is restarted or set aside, and no error is shown", async () => {
    const { bot, box } = await asleep(150_000);
    const machine = await ready(bot);
    expect(machine?.id).toBe(box.id);
    expect(hooks).toEqual(["waking"]);
    const result = await call(() => box.id);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(ranEcho()).toBe(1);
    expect(stops(box.id)).toHaveLength(0);
    expect(told).toEqual([]);
  });

  it("silent for twenty minutes after its resume, then answering by itself (the incident): restarted once, never set aside, and the bot is never told to give up", async () => {
    witness = true;
    const { bot, box } = await asleep(20 * 60_000);
    const first = await failure(bot);
    keptAsItIs(first);
    expect(first!.message).toMatch(/even after a restart/);
    expect(hooks.slice(0, 2)).toEqual(["waking", "restarting"]);
    expect(hooks).not.toContain("replacing");
    // The reason it was kept: the provider does not say whether the disk is back, and it was resumed minutes ago.
    expect(logs.some((line) => /resumed less than 30 minutes ago/.test(line))).toBe(true);
    // The turn's wait owned it: the background recovery, on the same health record, did not stop it a second time.
    expect(stops(box.id)).toHaveLength(1);
    expect(renames(box.id)).toHaveLength(0);
    expect(creates()).toHaveLength(0);
    expect(told).toEqual([]);

    // The turn's computer calls claim again and again, as a bot repeating its screenshot does, each a few minutes of
    // waiting: the claim is never given up for the turn, and once the computer answers by itself the turn goes on on it.
    const table: import("./auto-vm-claims.ts").AutoVmClaimTable = new Map();
    let machine: Awaited<ReturnType<typeof ready>> = null;
    const slot: import("./auto-vm-claims.ts").AutoVmClaimSlot = {
      owner: { threadId: "thread-1", generation: "g1" }, lazy: true, startsComputer: true,
      claim: async () => { machine = await ready(bot); },
    };
    table.set("thread-1", slot);
    for (let tries = 0; tries < 8 && !slot.claimed; tries++) {
      claims.startAutoVmClaim(table, "thread-1", "g1");
      await slot.begin;
      expect(slot.failed).toBeFalsy();
      if (!slot.claimed) expect(slot.retryReason).toMatch(/MausBot keeps trying in the background/);
    }
    expect(slot.claimed).toBe(true);
    expect(slot.attempts).toBeGreaterThan(3);
    expect(machine!.id).toBe(box.id);
    expect(boxes.map((candidate) => candidate.id)).toEqual([box.id]);
    expect(box.name).toBe(await boat.boatNameFor(bot.id));
    const result = await call(() => box.id);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(ranEcho()).toBe(1);
  });
});

describe("a woken cloud computer that never answers", () => {
  /** A bot whose computer was made the normal way (so its create is on record), then went to sleep and stays silent. */
  async function madeThenSilent() {
    const botId = `bot-made-${bots++}`;
    const made = await boat.provisionBoat(cfg, botId, "Scout");
    const box = boxes.find((candidate) => candidate.id === made.boxId)!;
    box.state = "archived";
    silentUntil.set(box.id, Infinity);
    boat.forgetBoatId(box.id);
    requests = [];
    return { bot: { id: botId, name: "Scout" } as BotRecord, box, originalName: box.name };
  }

  it("with another computer answering and the disk said to be back, is restarted, then set aside with its files (stopped and renamed, never deleted) for a new one", async () => {
    witness = true; hydrated = true;
    const { bot, box, originalName } = await madeThenSilent();
    const machine = await ready(bot);
    expect(machine?.id).not.toBe(box.id);
    expect(hooks).toEqual(["waking", "restarting", "replacing"]);
    // The old one: stopped for the restart, stopped again to be set aside, renamed, and still there.
    expect(stops(box.id)).toHaveLength(2);
    expect(renames(box.id).map((request) => request.name)).toEqual([expect.stringMatching(SET_ASIDE_NAME)]);
    expect(boxes.find((candidate) => candidate.id === box.id)).toMatchObject({ state: "archived", name: expect.stringMatching(SET_ASIDE_NAME) });
    expect(box.name.startsWith(`${originalName}-set-aside-`)).toBe(true);
    // A real new computer: its create was not answered by the old one's create receipt.
    expect(creates()).toHaveLength(1);
    expect(boxes.find((candidate) => candidate.id === machine!.id)?.name).toBe(originalName);
    const until = new Date(at + 7 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    expect(told).toEqual([[bot.id, "setAside", { date: until }]]);

    // Settings lists it as this installation's, owned by no bot, so the person finds it.
    const inventory = await boat.listManagedBoats(cfg, [{ botId: bot.id, name: "Scout", inUse: false }]);
    expect(inventory.available).toBe(true);
    expect(inventory.instances.find((instance) => instance.boxId === box.id)).toMatchObject({ orphaned: true, ownerBotId: null });
    expect(inventory.instances.find((instance) => instance.boxId === machine!.id)).toMatchObject({ ownerBotId: bot.id });

    // The bot hears it once, with the date and that sign-ins are not on the new one.
    const first = await call(() => machine!.id as string);
    expect((first as { isError?: boolean }).isError).toBeFalsy();
    const notice = (first as { content: Array<{ text?: string }> }).content[0]!.text!;
    expect(notice).toBe(words.cloudComputerSetAsideNotice(until));
    expect(notice).toMatch(/kept, stopped and with its files, until \d{4}-\d{2}-\d{2}/);
    expect(notice).toMatch(/sign-ins/);
    expect(ranEcho()).toBe(1);
    const second = await call(() => machine!.id as string);
    expect((second as { content: unknown[] }).content).toHaveLength(1);
    expect(told).toHaveLength(1);
  });

  it("is deleted only by the sweep once its seven days are up, and only while it still has the name it was set aside with", async () => {
    witness = true; hydrated = true;
    const { bot, box } = await madeThenSilent();
    const other = await madeThenSilent();
    await ready(bot);
    at += 2 * 60 * 60_000;
    await ready(other.bot);
    await recovery.sweep();
    expect(requests.filter((request) => request.method === "DELETE")).toEqual([]);

    // Someone took the second one back by renaming it: it is never deleted.
    other.box.name = "kept-by-the-person";
    at += 8 * 24 * 60 * 60_000;
    sweepDeletes = true;
    await recovery.sweep();
    expect(requests.filter((request) => request.method === "DELETE").map((request) => request.path)).toEqual([`/boxes/${box.id}`]);
    expect(boxes.some((candidate) => candidate.id === other.box.id)).toBe(true);
    await recovery.sweep();
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("is kept, with its name, when the plan has no room for a new computer beside it, and the person hears that once", async () => {
    witness = true; hydrated = true;
    const { bot, box, originalName } = await madeThenSilent();
    noRoom = true;
    const error = await failure(bot);
    expect(error!.message).toMatch(/plan has no room for a new computer beside it, so MausBot kept it, stopped and with its files/);
    expect(claims.transientClaimFailure(error)).toBe(true);
    expect(box.name).toBe(originalName);
    expect(renames(box.id).map((request) => request.name)).toEqual([expect.stringMatching(SET_ASIDE_NAME), originalName]);
    expect(boxes.map((candidate) => candidate.id)).toEqual([box.id]);
    expect(told).toEqual([[bot.id, "noRoom"]]);
    // It is still the bot's: the next start finds it again, and no other set-aside is tried for hours.
    expect((await boat.findBoat(cfg, bot.id))?.id).toBe(box.id);
    at += 61 * 60_000;
    box.state = "archived";
    keptAsItIs(await failure(bot));
    expect(renames(box.id)).toHaveLength(2);
  });

  it("is not set aside on a silence that began before it last slept: a wake starts its silence over", async () => {
    hydrated = true;
    const { bot, box } = await asleep(Infinity);
    health.unanswered(box.id);
    at += 40 * 60_000;
    keptAsItIs(await failure(bot));
    expect(renames(box.id)).toHaveLength(0);
    expect(creates()).toHaveLength(0);
    expect(logs.some((line) => /no other computer answered in the last two minutes/.test(line))).toBe(true);
  });

  it("with no other computer answering, is restarted and then left as it is: a lone computer is not set aside within half an hour", async () => {
    hydrated = true;
    const { bot, box } = await asleep(Infinity);
    keptAsItIs(await failure(bot));
    expect(stops(box.id)).toHaveLength(1);
    expect(renames(box.id)).toHaveLength(0);
    expect(creates()).toHaveLength(0);
    expect(logs.some((line) => /no other computer answered in the last two minutes/.test(line))).toBe(true);
  });

  it("is not set aside while the provider says its disk is still being restored", async () => {
    witness = true; hydrated = false;
    const { bot, box } = await asleep(Infinity);
    keptAsItIs(await failure(bot));
    expect(hooks).toContain("restoring");
    expect(renames(box.id)).toHaveLength(0);
    expect(creates()).toHaveLength(0);
  });

  it("is not set aside when this process's event loop stalled while it was probed", async () => {
    witness = true; hydrated = true; stalledLoop = true;
    const { bot, box } = await asleep(Infinity);
    keptAsItIs(await failure(bot));
    expect(renames(box.id)).toHaveLength(0);
    expect(logs.some((line) => /stalled while the computer was probed/.test(line))).toBe(true);
  });

  it("does not count probes that ran far past their own timeout: they were held up here, not by the computer", async () => {
    witness = true; hydrated = true; probeTakesMs = 60_000;
    const { bot, box } = await asleep(Infinity);
    await failure(bot);
    expect(logs.some((line) => /too few unanswered probes since its restart/.test(line))).toBe(true);
    expect(renames(box.id)).toHaveLength(0);
    expect(creates()).toHaveLength(0);
  });

  it("is not set aside when the restart never got the computer ready again: that is not a restart that failed", async () => {
    witness = true; hydrated = true;
    recovery.close();
    power.close();
    wakeBudgetMs = 500;
    await build();
    const { bot, box } = await asleep(Infinity);
    box.state = "ready";
    await boat.findBoat(cfg, bot.id);
    for (let probe = 0; probe < 8; probe++) { health.unanswered(box.id); at += 30_000; }
    resumeHangs = true;
    const outcome = await recovery.wakeTimedOut(bot.id, box.id, { turn: turn() });
    expect(outcome.kind).toBe("kept");
    expect((outcome as { why: string }).why).not.toMatch(/after a restart/);
    expect(stops(box.id)).toHaveLength(1);
    expect(renames(box.id)).toHaveLength(0);
    expect(creates()).toHaveLength(0);
  });

  it("is neither restarted nor set aside while a person views its desktop", async () => {
    witness = true; hydrated = true;
    const { bot, box } = await asleep(Infinity);
    personViewing.add(bot.id);
    const error = await failure(bot);
    keptAsItIs(error);
    expect(error!.message).toMatch(/someone else is using it/);
    expect(stops(box.id)).toHaveLength(0);
    expect(renames(box.id)).toHaveLength(0);
  });

  it("is not set aside while another bot's running turn uses it", async () => {
    witness = true; hydrated = true;
    const { bot, box } = await asleep(Infinity);
    inUseByOther.add(bot.id);
    keptAsItIs(await failure(bot));
    expect(stops(box.id)).toHaveLength(0);
    expect(creates()).toHaveLength(0);
  });

  it("is set aside at most once an hour and three times a day per bot", async () => {
    witness = true; hydrated = true; newSilentMs = 1e12;
    const { bot } = await asleep(Infinity);
    const first = await failure(bot);
    expect(first!.message).toMatch(/the new one did not answer in time either/);
    expect(creates()).toHaveLength(1);
    const current = () => boxes.find((box) => !SET_ASIDE_NAME.test(box.name))!;
    current().state = "archived";
    at += 2 * 60_000;
    const capped = await failure(bot);
    expect(capped!.message).toMatch(/at most once an hour and three times a day/);
    expect(creates()).toHaveLength(1);
    for (let made = 2; made <= 3; made++) {
      at += 61 * 60_000;
      current().state = "archived";
      await failure(bot);
      expect(creates()).toHaveLength(made);
    }
    at += 61 * 60_000;
    current().state = "archived";
    expect((await failure(bot))!.message).toMatch(/three times a day/);
    expect(creates()).toHaveLength(3);
  }, 90_000);

  it("is not set aside when the record of earlier replacements cannot be read: the limits fail closed", async () => {
    recovery.close();
    power.close();
    writeFileSync(replacementsFile, "{not json");
    await build();
    witness = true; hydrated = true;
    const { bot, box } = await asleep(Infinity);
    keptAsItIs(await failure(bot));
    expect(renames(box.id)).toHaveLength(0);
    expect(creates()).toHaveLength(0);
  });

  it("with automatic replacement switched off, is restarted, never set aside, and nothing says it is being replaced", async () => {
    autoOn = false; witness = true; hydrated = true;
    const { bot, box } = await asleep(Infinity);
    keptAsItIs(await failure(bot));
    expect(hooks).not.toContain("replacing");
    expect(stops(box.id)).toHaveLength(1);
    expect(renames(box.id)).toHaveLength(0);
    expect(creates()).toHaveLength(0);
    expect(told).toEqual([]);
  });
});

describe("a computer call made while its computer is being set aside", () => {
  /** A computer the recovery is setting aside, slowly, while the turn still names it. */
  async function settingAside() {
    witness = true; hydrated = true;
    const { bot, box } = await asleep(Infinity);
    box.state = "ready";
    await boat.findBoat(cfg, bot.id);
    for (let probe = 0; probe < 8; probe++) { health.unanswered(box.id); at += 30_000; }
    renameDelayMs = 300;
    const done = recovery.wakeTimedOut(bot.id, box.id, { turn: turn() });
    await vi.waitFor(() => expect(recovery.status(bot.id)?.state).toBe("replacing"), { timeout: 10_000 });
    let current = box.id;
    let reclaims = 0;
    const reclaim = async (replacedBoxId: string) => {
      reclaims++;
      expect(replacedBoxId).toBe(box.id);
      const machine = await power.ready(bot, turn(), { budgetMs: 30_000 });
      current = machine!.id as string;
      return current;
    };
    return { box, done, reclaim, current: () => current, reclaims: () => reclaims };
  }

  it("waits for it instead of being refused again and again, and a look at the screen then runs on the new computer", async () => {
    const r = await settingAside();
    let gates = 0;
    const result = await call(r.current, { reclaim: r.reclaim, gate: async () => { gates++; return { held: false }; } }, "get_screen_size");
    expect(await r.done).toEqual({ kind: "replaced" });
    expect(r.reclaims()).toBe(1);
    expect(r.current()).not.toBe(r.box.id);
    expect(gates).toBe(2);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect((result as { content: Array<{ text?: string }> }).content[0]!.text).toMatch(/set it aside and gave this bot a new one/);
    expect(requests.some((request) => request.command?.includes("getdisplaygeometry") && request.path.includes(r.current()))).toBe(true);
  });

  it("hands back a call that would change something, unperformed, once the new computer answers: the bot looks first", async () => {
    const r = await settingAside();
    const result = await call(r.current, { reclaim: r.reclaim });
    await r.done;
    expect(r.reclaims()).toBe(1);
    const texts = (result as { content: Array<{ text?: string }> }).content.map((part) => part.text);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(texts[1]).toBe(words.CLOUD_COMPUTER_ANSWERS_AGAIN);
    expect(ranEcho()).toBe(0);
  });

  it("says the new computer is still starting, and that the call was not performed, when it is not up in time", async () => {
    const r = await settingAside();
    await r.done;
    const result = await call(() => r.box.id, { reclaim: async () => null });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: words.CLOUD_COMPUTER_REPLACEMENT_STARTING }] });
    expect(ranEcho()).toBe(0);
  });
});

describe("what a call that got no answer is told", () => {
  it("says it got no answer and most likely did not run, never that it was not performed", async () => {
    const { bot, box } = await asleep(Infinity);
    box.state = "ready";
    await boat.findBoat(cfg, bot.id);
    for (let probe = 0; probe < 3; probe++) { health.unanswered(box.id); at += 30_000; }
    expect(recovery.refusal(box.id, "after")).toBe(words.CLOUD_COMPUTER_NOT_RESPONDING_UNANSWERED);
    expect(words.CLOUD_COMPUTER_NOT_RESPONDING_UNANSWERED).toMatch(/got no answer and most likely did not run/);
    expect(words.CLOUD_COMPUTER_NOT_RESPONDING).not.toMatch(/replac/i);
  });
});

describe("moving a turn's claim onto the new computer", () => {
  it("claims again once, however many calls see the set-aside, and hands back the new computer", async () => {
    const table: import("./auto-vm-claims.ts").AutoVmClaimTable = new Map();
    let next = 1;
    const slot: import("./auto-vm-claims.ts").AutoVmClaimSlot = {
      owner: { threadId: "t", generation: "g" }, lazy: true, startsComputer: true,
      claim: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); slot.boxId = `bx_new${next++}`; },
    };
    table.set("t", slot);
    claims.startAutoVmClaim(table, "t", "g");
    await slot.begin;
    expect(slot).toMatchObject({ claimed: true, boxId: "bx_new1" });
    const until = Date.now() + 5_000;
    const [a, b] = await Promise.all([
      claims.reclaimAutoVm(table, slot.owner, "bx_new1", until),
      claims.reclaimAutoVm(table, slot.owner, "bx_new1", until),
    ]);
    expect([a, b]).toEqual(["bx_new2", "bx_new2"]);
    expect(await claims.reclaimAutoVm(table, slot.owner, "bx_new1", until)).toBe("bx_new2");
    expect(next).toBe(3);
    expect(await claims.reclaimAutoVm(table, { threadId: "t", generation: "older" }, "bx_new2", until)).toBeNull();
  });
});
