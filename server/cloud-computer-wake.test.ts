// A cloud computer woken for a turn that is slow to answer, or never answers: the turn waits for it patiently, and one
// that stays silent past the wake's patience is replaced, once, within its limits, and the turn goes on on the new one.
// A loopback stand-in for the Cloud's relay plays the provider. No network, no real computer; the data folder is the
// test's own, and the clock the waits read is the test's.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";
import type { BotRecord } from "./store.ts";

type Box = { id: string; name: string; state: string };

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
let made = 0;
const newId = () => `bx_${String(made++).padStart(8, "0").split("").map((digit) => ALPHABET[Number(digit)]).join("")}`;
const opId = (boxId: string) => `bdop_${Buffer.from(boxId.padEnd(16, "x")).toString("hex").slice(0, 32)}`;

let server: Server;
let boxes: Box[] = [];
let requests: Array<{ method: string; path: string; command?: string }> = [];
/** Until when, on the test's clock, each computer leaves every command unanswered (the gateway's 502). */
let silentUntil = new Map<string, number>();
/** A computer made from now on is silent for this long, on the test's clock. */
let newSilentMs = 0;
let deleteStatus = 202;
let deleteDelayMs = 0;
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
      requests.push({ method, path, ...(typeof body.command === "string" ? { command: body.command } : {}) });
      if (path === "/boxes" && method === "GET") return send(res, 200, { ok: true, boxes, pageInfo: { nextCursor: null } });
      if (path === "/boxes" && method === "POST") {
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
      if (!action && method === "GET") return send(res, 200, { ok: true, box });
      if (!action && method === "PATCH") { box.name = body.name; return send(res, 200, { ok: true, box }); }
      if (!action && method === "DELETE") {
        setTimeout(() => {
          if (deleteStatus >= 400) return send(res, deleteStatus, { ok: false, code: "upstream_error", message: "The delete failed." });
          boxes = boxes.filter((candidate) => candidate.id !== box.id);
          send(res, 202, { ok: true, operation: { id: opId(box.id), kind: "box", targetId: box.id, status: "completed" } });
        }, deleteDelayMs);
        return;
      }
      if (action === "stop") { box.state = "archived"; return send(res, 200, { ok: true, box }); }
      if (action === "resume") { box.state = "ready"; return send(res, 200, { ok: true, box }); }
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
let told: Array<[string, string]>;
let hooks: string[];
let autoOn: boolean;
let inUseByOther: Set<string>;
let dir: string;

beforeEach(async () => {
  boxes = []; requests = []; silentUntil = new Map(); newSilentMs = 0; deleteStatus = 202; deleteDelayMs = 0;
  at += 7 * 24 * 60 * 60_000;
  told = []; hooks = []; autoOn = true; inUseByOther = new Set();
  dir = mkdtempSync(join(tmpdir(), "omb-wake-"));
  vi.resetModules();
  boat = await import("./boat.ts");
  words = await import("../shared/cloud-computer-recovery.ts");
  tools = await import("./cloud-computer-tools.ts");
  claims = await import("./auto-vm-claims.ts");
  const { createBoatHealth } = await import("./boat-health.ts");
  const { createBoatReadiness } = await import("./boat-ready.ts");
  const { createBoatRecovery } = await import("./boat-recovery.ts");
  const { createCloudComputerCounters } = await import("./cloud-computer-counters.ts");
  const { createCloudComputerPower } = await import("./host/cloud-computer-power.ts");
  health = createBoatHealth(now);
  // Each wait moves the test's clock instead of passing real time. The waits keep their own health record, so the
  // background recovery (restart, then replace, on three silent probes) stays out of these scenarios: they are about
  // the turn's own wait.
  const readiness = createBoatReadiness({ health: createBoatHealth(now), counters: createCloudComputerCounters(now), now, sleep: async (ms) => { at += ms; } });
  recovery = createBoatRecovery({
    cfg: () => cfg, tell: (owner, line) => told.push([owner, line]), log: () => {}, file: join(dir, "boat-replacements.json"), now, health,
    pollMs: 5, recheckMs: 20, readiness, autoReplace: () => autoOn, usedByOther: (owner) => inUseByOther.has(owner),
  });
  power = createCloudComputerPower({
    cfg, busy: () => false, claim: () => () => {}, owners: () => [], routines: () => [], routineComputer: () => null,
    broadcast: () => {}, log: () => {}, readiness, wakeTimedOut: (owner, boxId) => recovery.wakeTimedOut(owner, boxId),
  });
});
afterEach(() => {
  recovery.close();
  power.close();
  rmSync(dir, { recursive: true, force: true });
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
  budgetMs: 30_000, onWaking: () => hooks.push("waking"), onReplacing: () => hooks.push("replacing"), onRestoring: () => hooks.push("restoring"),
});
const deletes = () => requests.filter((request) => request.method === "DELETE");
const creates = () => requests.filter((request) => request.method === "POST" && request.path === "/boxes");
/** One computer call as the bot makes it, through the same route a turn's calls take. */
const call = (boxId: () => string, extra: Partial<Parameters<typeof tools.cloudComputerRpc>[1]> = {}) =>
  tools.cloudComputerRpc({ method: "tools/call", params: { name: "exec", arguments: { command: "echo hi" } } }, {
    cfg, signal: new AbortController().signal, boxId, gate: async () => ({ held: false }), assertActive: () => {}, recovery, ...extra,
  });
const ranEcho = () => requests.filter((request) => request.command?.includes("echo hi")).length;

describe("a woken cloud computer that is slow to answer", () => {
  it("is waited for inside the wake's patience: the bot's command runs once, nothing is replaced, and no error is shown", async () => {
    const { bot, box } = await asleep(150_000);
    const machine = await ready(bot);
    expect(machine?.id).toBe(box.id);
    expect(hooks).toEqual(["waking"]);
    const result = await call(() => box.id);
    expect(result).toMatchObject({ content: [{ type: "text" }] });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(ranEcho()).toBe(1);
    expect(deletes()).toHaveLength(0);
    expect(told).toEqual([]);
  });
});

describe("a woken cloud computer that never answers", () => {
  it("is replaced once, the turn goes on on the new one, and the bot and the person each hear it once", async () => {
    const { bot, box } = await asleep(Infinity);
    const machine = await ready(bot);
    expect(machine?.id).not.toBe(box.id);
    expect(hooks).toEqual(["waking", "replacing"]);
    expect(deletes().map((request) => request.path)).toEqual([`/boxes/${box.id}`]);
    expect(creates()).toHaveLength(1);
    expect(told).toEqual([[bot.id, "replaced"]]);

    const first = await call(() => machine!.id as string);
    expect((first as { isError?: boolean }).isError).toBeFalsy();
    expect((first as { content: unknown[] }).content[0]).toEqual({ type: "text", text: words.CLOUD_COMPUTER_REPLACED });
    expect(words.CLOUD_COMPUTER_REPLACED).toMatch(/install again/);
    expect(ranEcho()).toBe(1);
    const second = await call(() => machine!.id as string);
    expect((second as { content: unknown[] }).content).toHaveLength(1);
    expect(told).toHaveLength(1);
  });

  it("is kept when a last probe gets through: a computer that is only slow is never replaced", async () => {
    const { bot, box } = await asleep(0);
    box.state = "ready";
    await boat.findBoat(cfg, bot.id);
    await expect(recovery.wakeTimedOut(bot.id, box.id)).resolves.toEqual({ kind: "answers" });
    expect(deletes()).toHaveLength(0);
    expect(told).toEqual([]);
  });

  it("is replaced at most once an hour and three times a day per bot", async () => {
    newSilentMs = 1e12;
    const { bot } = await asleep(Infinity);
    await expect(ready(bot)).rejects.toThrow(/new one did not answer in time either/);
    expect(deletes()).toHaveLength(1);
    expect(told).toEqual([[bot.id, "replaced"]]);

    // Within the hour: left as it is, and the turn says why.
    const current = () => boxes.find((box) => box.name)!;
    current().state = "archived";
    await expect(ready(bot)).rejects.toThrow(/at most once an hour and three times a day/);
    expect(deletes()).toHaveLength(1);
    expect(told.filter(([, line]) => line === "capped")).toHaveLength(1);

    for (let replaced = 2; replaced <= 3; replaced++) {
      at += 61 * 60_000;
      current().state = "archived";
      await expect(ready(bot)).rejects.toThrow(/new one did not answer/);
      expect(deletes()).toHaveLength(replaced);
    }
    at += 61 * 60_000;
    current().state = "archived";
    await expect(ready(bot)).rejects.toThrow(/three times a day/);
    expect(deletes()).toHaveLength(3);
  });

  it("fails the turn with a clear reason when the replacement itself fails, and makes no new computer", async () => {
    deleteStatus = 500;
    const { bot } = await asleep(Infinity);
    const failed = await ready(bot).then(() => null, (error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toMatch(/did not answer after waking, and replacing it failed.*trying again later is fine/);
    expect(claims.transientClaimFailure(failed)).toBe(false);
    expect(creates()).toHaveLength(0);
  });

  it("is not replaced while another bot's running turn uses it", async () => {
    const { bot } = await asleep(Infinity);
    inUseByOther.add(bot.id);
    await expect(ready(bot)).rejects.toThrow(/could not be replaced by itself right now/);
    expect(deletes()).toHaveLength(0);
    expect(creates()).toHaveLength(0);
    expect(told).toEqual([[bot.id, "needsPerson"]]);
  });

  it("is not replaced while the installation's other computers are silent too: that is the provider's outage", async () => {
    const { bot } = await asleep(Infinity);
    health.unanswered("bx_someoneelse");
    await expect(ready(bot)).rejects.toThrow(/service itself can't be reached/);
    expect(deletes()).toHaveLength(0);
  });

  it("with automatic replacement switched off, keeps today's behaviour: nothing is replaced and the claim may be tried again", async () => {
    autoOn = false;
    const { bot } = await asleep(Infinity);
    const failed = await ready(bot).then(() => null, (error: unknown) => error);
    expect((failed as Error).message).toBe("the cloud computer is awake but is not answering yet");
    expect(claims.transientClaimFailure(failed)).toBe(true);
    expect(deletes()).toHaveLength(0);
    expect(creates()).toHaveLength(0);
    expect(told).toEqual([]);
  });
});

describe("a computer call made while its computer is being replaced", () => {
  it("waits for the replacement and runs on the new computer, instead of being refused again and again", async () => {
    const { bot, box } = await asleep(Infinity);
    box.state = "ready";
    await boat.findBoat(cfg, bot.id);
    deleteDelayMs = 300;
    const replacing = recovery.wakeTimedOut(bot.id, box.id);
    await vi.waitFor(() => expect(recovery.refusal(box.id, "before")).not.toBeNull());
    let current = box.id;
    let reclaims = 0;
    const result = await call(() => current, {
      reclaim: async (replacedBoxId) => {
        reclaims++;
        expect(replacedBoxId).toBe(box.id);
        const machine = await power.ready(bot, turn(), { budgetMs: 30_000 });
        current = machine!.id as string;
        return current;
      },
    });
    await replacing;
    expect(reclaims).toBe(1);
    expect(current).not.toBe(box.id);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect((result as { content: unknown[] }).content[0]).toEqual({ type: "text", text: words.CLOUD_COMPUTER_REPLACED });
    expect(ranEcho()).toBe(1);
  });

  it("says the new computer is still starting, and that the call was not performed, when it is not up in time", async () => {
    const { bot, box } = await asleep(Infinity);
    box.state = "ready";
    await boat.findBoat(cfg, bot.id);
    await recovery.wakeTimedOut(bot.id, box.id);
    const result = await call(() => box.id, { reclaim: async () => null });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: words.CLOUD_COMPUTER_REPLACEMENT_STARTING }] });
    expect(ranEcho()).toBe(0);
  });
});

describe("moving a turn's claim onto the replacement", () => {
  it("claims again once, however many calls see the replacement, and hands back the new computer", async () => {
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
