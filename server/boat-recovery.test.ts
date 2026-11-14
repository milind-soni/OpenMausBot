// A loopback stand-in for the Cloud's relay (the box dialect, as included cloud computers reach Boat) plays a computer
// whose machine is gone. No network, no real computer; the data folder is the test's own.
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";

type Box = { id: string; name: string; state: string; error?: string };
type Seen = { method: string; path: string; headers: IncomingMessage["headers"] };

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
let made = 0;
const newId = () => `bx_${String(made++).padStart(8, "0").split("").map((digit) => ALPHABET[Number(digit)]).join("")}`;
const opId = (boxId: string) => `bdop_${Buffer.from(boxId.padEnd(16, "x")).toString("hex").slice(0, 32)}`;

let server: Server;
let boxes: Box[] = [];
let requests: Seen[] = [];
let commandStatus = new Map<string, number>();
let boxReadStatus = new Map<string, number>();
let listStatus = 200;
let deleteCompletes = true;
let resumeAnswers = new Set<string>();
let deleteDelayMs = 0;
let autoOn = true;
const teamOwners = new Set<string>();
const watched = new Set<string>();
const deleteSpans: Array<{ boxId: string; start: number; end: number }> = [];
const pendingDeletes = new Set<string>();

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
      requests.push({ method: req.method ?? "GET", path, headers: req.headers });
      const body = raw ? JSON.parse(raw) : {};
      const method = req.method;
      if (path === "/boxes" && method === "GET") {
        if (listStatus !== 200) return send(res, listStatus, { ok: false, code: "upstream_unavailable", message: "Cloud computers could not be reached." });
        return send(res, 200, { ok: true, boxes, pageInfo: { nextCursor: null } });
      }
      if (path === "/boxes" && method === "POST") {
        const box = { id: newId(), name: "", state: "ready" };
        boxes.push(box);
        return send(res, 200, { ok: true, box });
      }
      const operation = /^\/deletion-operations\/([^/]+)$/.exec(path);
      if (operation && method === "GET") {
        const target = [...pendingDeletes].find((id) => opId(id) === operation[1]);
        const status = target && !deleteCompletes ? "pending" : "completed";
        if (target && status === "completed") { pendingDeletes.delete(target); boxes = boxes.filter((box) => box.id !== target); }
        return send(res, 200, { ok: true, operation: { id: operation[1], kind: "box", targetId: target ?? "", status } });
      }
      const match = /^\/boxes\/([^/]+)(?:\/(stop|resume|commands|desktop))?$/.exec(path);
      const box = match ? boxes.find((candidate) => candidate.id === match[1]) : undefined;
      if (!match || !box) return send(res, 404, { ok: false, code: "not_found", message: "That cloud computer does not exist." });
      const action = match[2];
      if (!action && method === "GET") {
        const status = boxReadStatus.get(box.id) ?? 200;
        return status === 200 ? send(res, 200, { ok: true, box }) : send(res, status, { ok: false, code: "upstream_unavailable" });
      }
      if (!action && method === "PATCH") { box.name = body.name; return send(res, 200, { ok: true, box }); }
      if (!action && method === "DELETE") {
        if (req.headers["x-ascii-confirm-delete"] !== box.id) return send(res, 409, { ok: false, code: "confirmation_required" });
        const start = Date.now();
        setTimeout(() => {
          if (deleteCompletes) boxes = boxes.filter((candidate) => candidate.id !== box.id);
          else pendingDeletes.add(box.id);
          deleteSpans.push({ boxId: box.id, start, end: Date.now() });
          send(res, 202, { ok: true, operation: { id: opId(box.id), kind: "box", targetId: box.id, status: deleteCompletes ? "completed" : "pending" } });
        }, deleteDelayMs);
        return;
      }
      if (action === "stop") { box.state = "archived"; return send(res, 200, { ok: true, box }); }
      if (action === "resume") {
        box.state = "ready";
        if (resumeAnswers.has(box.id)) commandStatus.delete(box.id);
        return send(res, 200, { ok: true, box });
      }
      if (action === "commands") {
        const status = commandStatus.get(box.id) ?? 200;
        // The relay's answer when Boat's gateway cannot reach the machine.
        return status === 200 ? send(res, 200, { exitCode: 0, stdout: "captured", stderr: "" })
          : send(res, status, { ok: false, code: "upstream_unavailable", message: "Cloud computers could not be reached. Try again in a minute." });
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
let recoveryModule: typeof import("./boat-recovery.ts");
let healthModule: typeof import("./boat-health.ts");
let words: typeof import("../shared/cloud-computer-recovery.ts");
let journal: typeof import("./boat-delete-journal.ts");
let at = 10_000_000;
const now = () => at;
let told: Array<[string, string]>;
let recovery: import("./boat-recovery.ts").BoatRecovery;
let health: import("./boat-health.ts").BoatHealth;
let file: string;

async function load() {
  vi.resetModules();
  boat = await import("./boat.ts");
  recoveryModule = await import("./boat-recovery.ts");
  healthModule = await import("./boat-health.ts");
  words = await import("../shared/cloud-computer-recovery.ts");
  journal = await import("./boat-delete-journal.ts");
}
function start() {
  told = [];
  health = healthModule.createBoatHealth(now);
  recovery = recoveryModule.createBoatRecovery({ cfg: () => cfg, tell: (owner, line) => told.push([owner, line]), log: () => {}, file, now, health, pollMs: 5,
    autoReplace: () => autoOn, eligible: (owner) => !teamOwners.has(owner), personActive: (owner) => watched.has(owner) });
}

beforeEach(async () => {
  boxes = []; requests = []; commandStatus = new Map(); boxReadStatus = new Map(); listStatus = 200; deleteCompletes = true; resumeAnswers = new Set();
  pendingDeletes.clear();
  deleteDelayMs = 0; autoOn = true; deleteSpans.length = 0; teamOwners.clear(); watched.clear();
  at += 24 * 60 * 60_000;
  file = join(mkdtempSync(join(tmpdir(), "omb-repl-")), "boat-replacements.json");
  await load();
  start();
});
afterEach(() => recovery.close());

let bots = 0;
async function botWith(state: string, extra: Partial<Box> = {}) {
  const botId = `bot-dead-${bots++}`;
  const box = { id: newId(), name: await boat.boatNameFor(botId), state, ...extra };
  boxes.push(box);
  return { botId, box };
}
/** As a turn's start does: provision, then look the computer up. */
const provisioned = async (botId: string) => {
  const created = await boat.provisionBoat(cfg, botId, "Bot");
  await boat.findBoat(cfg, botId);
  return created;
};
const deletes = () => requests.filter((request) => request.method === "DELETE");
const until = async (check: () => boolean, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 20))) if (check()) return;
  throw new Error("timed out");
};
/** Three probes with no answer over more than ten minutes, as the health check records them. */
const stopsAnswering = (boxId: string) => {
  health.unanswered(boxId);
  at += 30_000;
  health.unanswered(boxId);
  at += 11 * 60_000;
  health.unanswered(boxId);
};

const stops = () => requests.filter((request) => request.method === "POST" && request.path.endsWith("/stop"));
const DEAD_CONFIRM = 31 * 60_000;
/** The provider's `error` must be read twice, half an hour apart, before the computer is deleted by itself. */
async function deadTwice(botId: string) {
  const before = deletes().length;
  await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toThrow(words.CLOUD_COMPUTER_DEAD_WAITING);
  expect(deletes()).toHaveLength(before);
  at += DEAD_CONFIRM;
}

describe("a cloud computer the provider reports in error", () => {
  it("is never shown or used as ready, is replaced once it stays in error, and the bot and the person are told once", async () => {
    const { botId, box } = await botWith("error", { error: "machine unreachable: 278 consecutive /health failures" });
    expect(await boat.findBoat(cfg, botId)).toBeNull();
    expect(boat.deadBoatOf(botId)).toEqual({ boxId: box.id, name: box.name });
    expect(boat.boatTurnLifecycleAction("error")).toBe("provision");
    expect((await boat.boatStatus(cfg, botId)).box).toBeNull();
    await expect(boat.joinBoat(cfg, botId)).rejects.toThrow(/no computer yet/);

    await deadTwice(botId);
    expect(told).toEqual([[botId, "needsPerson"]]);
    await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toMatchObject({ code: journal.BOAT_DELETION_FINISHED });
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]!.headers["x-ascii-confirm-delete"]).toBe(box.id);
    expect(told).toEqual([[botId, "needsPerson"], [botId, "replaced"]]);
    expect(recovery.status(botId)?.state).toBe("replaced");

    const created = await provisioned(botId);
    expect(created.boxId).not.toBe(box.id);
    expect(recovery.notice(created.boxId)).toBe(words.CLOUD_COMPUTER_REPLACED);
    expect(recovery.notice(created.boxId)).toBeNull();
    expect(told).toHaveLength(2);
    expect(deletes()).toHaveLength(1);
  });

  it("is not deleted while the provider's list fails", async () => {
    const { botId } = await botWith("error");
    await boat.findBoat(cfg, botId);
    await deadTwice(botId);
    listStatus = 502;
    await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toThrow();
    expect(deletes()).toHaveLength(0);
  });

  it("is kept when it answered a command moments ago", async () => {
    const { botId, box } = await botWith("error");
    await boat.findBoat(cfg, botId);
    health.answered(box.id);
    await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toThrow(words.CLOUD_COMPUTER_NOT_RESPONDING);
    expect(deletes()).toHaveLength(0);
    expect(told).toEqual([]);
  });

  it("is replaced at most once an hour per bot, then left and said so", async () => {
    const { botId } = await botWith("error");
    await boat.findBoat(cfg, botId);
    await deadTwice(botId);
    await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toMatchObject({ code: journal.BOAT_DELETION_FINISHED });
    const second = await provisioned(botId);
    boxes.find((box) => box.id === second.boxId)!.state = "error";
    at += 60_000;
    expect(await boat.findBoat(cfg, botId)).toBeNull();
    await deadTwice(botId);
    await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toThrow(/at most once an hour/);
    expect(deletes()).toHaveLength(1);
    expect(told.filter(([, line]) => line === "capped")).toHaveLength(1);
    await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toThrow(/at most once an hour/);
    expect(told.filter(([, line]) => line === "capped")).toHaveLength(1);

    at += 30 * 60_000;
    await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toMatchObject({ code: journal.BOAT_DELETION_FINISHED });
    expect(deletes()).toHaveLength(2);
  });

  it("is deleted by itself at most once an hour for the whole installation, whoever's computer it is", async () => {
    const first = await botWith("error");
    const second = await botWith("error");
    await boat.findBoat(cfg, first.botId);
    await boat.findBoat(cfg, second.botId);
    await expect(boat.provisionBoat(cfg, first.botId, "Bot")).rejects.toThrow(words.CLOUD_COMPUTER_DEAD_WAITING);
    await expect(boat.provisionBoat(cfg, second.botId, "Bot")).rejects.toThrow(words.CLOUD_COMPUTER_DEAD_WAITING);
    at += DEAD_CONFIRM;
    await expect(boat.provisionBoat(cfg, first.botId, "Bot")).rejects.toMatchObject({ code: journal.BOAT_DELETION_FINISHED });
    await expect(boat.provisionBoat(cfg, second.botId, "Bot")).rejects.toThrow(words.CLOUD_COMPUTER_NEEDS_PERSON);
    expect(deletes().map((request) => request.headers["x-ascii-confirm-delete"])).toEqual([first.box.id]);
    at += 61 * 60_000;
    await expect(boat.provisionBoat(cfg, second.botId, "Bot")).rejects.toMatchObject({ code: journal.BOAT_DELETION_FINISHED });
    expect(deletes()).toHaveLength(2);
  });

  it("finishes after a crash between the delete and the new computer, telling each side once", async () => {
    deleteCompletes = false;
    const { botId, box } = await botWith("error");
    await boat.findBoat(cfg, botId);
    await deadTwice(botId);
    await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toMatchObject({ code: journal.BOAT_DELETING });
    expect(told).toEqual([[botId, "needsPerson"], [botId, "replaced"]]);

    recovery.close();
    await load();
    start();
    deleteCompletes = true;
    await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toMatchObject({ code: journal.BOAT_DELETION_FINISHED });
    const created = await provisioned(botId);
    expect(created.boxId).not.toBe(box.id);
    expect(deletes()).toHaveLength(1);
    expect(recovery.notice(created.boxId)).toBe(words.CLOUD_COMPUTER_REPLACED);
    expect(told).toEqual([]);
  });

  it("keeps every guard for a replacement recorded before its delete was sent, without counting it twice", async () => {
    const { botId, box } = await botWith("error");
    writeFileSync(file, JSON.stringify([{ owner: botId, boxId: box.id, at: now() - 60_000 }]));
    recovery.close();
    start();
    await boat.findBoat(cfg, botId);
    await deadTwice(botId);
    await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toMatchObject({ code: journal.BOAT_DELETION_FINISHED });
    expect(deletes()).toHaveLength(1);
    const created = await provisioned(botId);
    expect(recovery.notice(created.boxId)).toBe(words.CLOUD_COMPUTER_REPLACED);
  });
});

describe("a cloud computer that says it is ready but does not answer", () => {
  it("is restarted first, then replaced while another computer answers, and calls to it are refused meanwhile", async () => {
    const { botId, box } = await botWith("ready");
    const witness = await botWith("ready");
    commandStatus.set(box.id, 502);
    await boat.findBoat(cfg, botId);
    stopsAnswering(box.id);
    health.answered(witness.box.id);
    expect(recovery.refusal(box.id, "before")).toBe(words.CLOUD_COMPUTER_NOT_RESPONDING);
    await until(() => recovery.status(botId)?.state === "replaced");
    const order = requests.filter((request) => request.path.startsWith(`/boxes/${box.id}`)).map((request) => `${request.method} ${request.path.replace(`/boxes/${box.id}`, "") || "/"}`);
    expect(order.indexOf("POST /commands")).toBeLessThan(order.indexOf("POST /stop"));
    expect(order.indexOf("POST /resume")).toBeGreaterThan(order.indexOf("POST /stop"));
    expect(order.indexOf("DELETE /")).toBeGreaterThan(order.indexOf("POST /resume"));
    expect(deletes().map((request) => request.headers["x-ascii-confirm-delete"])).toEqual([box.id]);
    expect(told).toEqual([[botId, "replaced"]]);
    expect(recovery.refusal(box.id, "before")).toBe(words.CLOUD_COMPUTER_NOT_RESPONDING);
    expect(boxes.some((candidate) => candidate.id === witness.box.id)).toBe(true);
  });

  it("is kept when the restart brings it back, and the bot hears that once", async () => {
    const { botId, box } = await botWith("ready");
    const witness = await botWith("ready");
    commandStatus.set(box.id, 502);
    resumeAnswers.add(box.id);
    await boat.findBoat(cfg, botId);
    stopsAnswering(box.id);
    health.answered(witness.box.id);
    await until(() => recovery.status(botId)?.state === "restarted");
    expect(deletes()).toHaveLength(0);
    expect(told).toEqual([[botId, "restarted"]]);
    expect(recovery.notice(box.id)).toBe(words.CLOUD_COMPUTER_RESTARTED);
    expect(recovery.notice(box.id)).toBeNull();
    expect(recovery.refusal(box.id, "before")).toBeNull();
    expect(recovery.stuck(botId)).toBe(false);
  });

  it("is not stopped when a fresh probe answers: three failed probes may have been this home's own outage", async () => {
    const { botId, box } = await botWith("ready");
    const witness = await botWith("ready");
    await boat.findBoat(cfg, botId);
    stopsAnswering(box.id);
    health.answered(witness.box.id);
    await until(() => recovery.status(botId) === null && requests.some((request) => request.path === `/boxes/${box.id}/commands`));
    expect(stops()).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
  });

  it("is neither restarted nor deleted when no other computer answers: it waits for the person", async () => {
    const { botId, box } = await botWith("ready");
    commandStatus.set(box.id, 502);
    await boat.findBoat(cfg, botId);
    stopsAnswering(box.id);
    await until(() => recovery.status(botId)?.state === "needs-person");
    expect(stops()).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
    expect(told).toEqual([[botId, "needsPerson"]]);
    expect(recovery.refusal(box.id, "after")).toBe(words.CLOUD_COMPUTER_NEEDS_PERSON);
    expect(recovery.refusal(box.id, "before")).toBeNull();
    expect(recovery.stuck(botId)).toBe(true);
  });

  it("is neither restarted nor deleted while the provider's list fails", async () => {
    const { botId, box } = await botWith("ready");
    const witness = await botWith("ready");
    commandStatus.set(box.id, 502);
    await boat.findBoat(cfg, botId);
    listStatus = 502;
    stopsAnswering(box.id);
    health.answered(witness.box.id);
    await until(() => recovery.status(botId)?.state === "unreachable");
    expect(stops()).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
    expect(recovery.refusal(box.id, "after")).toBe(words.CLOUD_COMPUTER_UNREACHABLE);
  });

  it("is left alone, not even restarted, while the provider cannot say what it is", async () => {
    const { botId, box } = await botWith("ready");
    await boat.findBoat(cfg, botId);
    boxReadStatus.set(box.id, 502);
    stopsAnswering(box.id);
    await until(() => recovery.status(botId)?.state === "unreachable");
    expect(stops()).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
  });

  it("is not restarted or deleted while a person has its desktop open or used it in the last ten minutes", async () => {
    const { botId, box } = await botWith("ready");
    const witness = await botWith("ready");
    commandStatus.set(box.id, 502);
    await boat.findBoat(cfg, botId);
    watched.add(botId);
    stopsAnswering(box.id);
    health.answered(witness.box.id);
    await until(() => recovery.status(botId)?.state === "needs-person");
    expect(stops()).toHaveLength(0);
    expect(deletes()).toHaveLength(0);

    const other = await botWith("ready");
    commandStatus.set(other.box.id, 502);
    await boat.findBoat(cfg, other.botId);
    stopsAnswering(other.box.id);
    health.personUsed(other.box.id);
    health.answered(witness.box.id);
    await until(() => recovery.status(other.botId)?.state === "needs-person");
    expect(stops()).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
  });

  it("restarts at most one computer of the installation by itself in ten minutes", async () => {
    const first = await botWith("ready");
    const second = await botWith("ready");
    const witness = await botWith("ready");
    for (const { botId, box } of [first, second]) { commandStatus.set(box.id, 502); await boat.findBoat(cfg, botId); }
    for (const box of [first.box, second.box]) health.unanswered(box.id);
    at += 30_000;
    for (const box of [first.box, second.box]) health.unanswered(box.id);
    at += 11 * 60_000;
    health.answered(witness.box.id);
    for (const box of [first.box, second.box]) health.unanswered(box.id);
    const settled = (botId: string) => ["needs-person", "replaced", "capped"].includes(recovery.status(botId)?.state ?? "");
    await until(() => settled(first.botId) && settled(second.botId));
    expect(stops()).toHaveLength(1);
  });

  it("is replaced only once the provider's error is seen twice half an hour apart, and without a restart", async () => {
    const { botId, box } = await botWith("ready");
    const witness = await botWith("ready");
    await boat.findBoat(cfg, botId);
    box.state = "error";
    stopsAnswering(box.id);
    await until(() => recovery.status(botId)?.state === "needs-person");
    expect(deletes()).toHaveLength(0);
    at += DEAD_CONFIRM;
    health.answered(witness.box.id);
    health.unanswered(box.id);
    await until(() => recovery.status(botId)?.state === "replaced");
    expect(stops()).toHaveLength(0);
    expect(deletes()).toHaveLength(1);
  });
});

describe("a team's shared cloud computer", () => {
  for (const on of [false, true]) {
    it(`is never stopped or deleted by itself, with automatic replacement ${on ? "on" : "off"}`, async () => {
      autoOn = on;
      const { botId, box } = await botWith("ready");
      const witness = await botWith("ready");
      teamOwners.add(botId);
      commandStatus.set(box.id, 502);
      await boat.findBoat(cfg, botId);
      stopsAnswering(box.id);
      health.answered(witness.box.id);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(recovery.status(botId)?.state).toBe("needs-person");
      expect(recovery.refusal(box.id, "after")).toBe(words.CLOUD_COMPUTER_TEAM_NOT_RESPONDING);

      box.state = "error";
      expect(await boat.findBoat(cfg, botId)).toBeNull();
      at += DEAD_CONFIRM;
      for (let i = 0; i < 2; i++) await expect(boat.provisionBoat(cfg, botId, "Team")).rejects.toThrow(words.CLOUD_COMPUTER_TEAM_NOT_RESPONDING);
      expect(stops()).toHaveLength(0);
      expect(deletes()).toHaveLength(0);
      expect(told).toEqual([[botId, "teamNotResponding"]]);
    });
  }
});

describe("what counts as an answer", () => {
  it("is only the computer's own: a refusal neither answers nor fails, so it never stands witness", async () => {
    const { box } = await botWith("ready");
    const other = await botWith("ready");
    commandStatus.set(other.box.id, 409);
    const refused = await boat.runCommand(cfg, other.box.id, "true");
    expect(refused.unanswered).toBeUndefined();
    expect(healthModule.boatHealth.answeredWithin(other.box.id, 60_000)).toBe(false);
    expect(healthModule.boatHealth.otherAnsweredWithin(box.id, 60_000)).toBe(false);
    expect(await boat.probeBoat(cfg, other.box.id)).toBeNull();
    commandStatus.delete(other.box.id);
    await boat.runCommand(cfg, other.box.id, "true");
    expect(healthModule.boatHealth.otherAnsweredWithin(box.id, 60_000)).toBe(true);
  });
});

describe("the desktop link", () => {
  it("still opens while a computer is marked not responding, so the person can save files first", async () => {
    const { botId, box } = await botWith("ready");
    await boat.findBoat(cfg, botId);
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now");
    try {
      for (const offset of [0, 30_000, 70_000]) { clock.mockReturnValue(realNow + offset); healthModule.boatHealth.unanswered(box.id); }
    } finally { clock.mockRestore(); }
    expect(healthModule.boatHealth.notRespondingSince(box.id)).not.toBeNull();
    expect((await boat.joinReadyBoat(cfg, botId)).joinUrl).toBe("https://desktop.test/view");
  });
});

describe("one failed command", () => {
  it("changes nothing: the next call goes through and nothing is restarted or deleted", async () => {
    const { botId, box } = await botWith("ready");
    await boat.findBoat(cfg, botId);
    commandStatus.set(box.id, 502);
    const out = await boat.runCommand(cfg, box.id, "xdotool getdisplaygeometry");
    expect(out).toMatchObject({ ok: false, unanswered: true });
    commandStatus.delete(box.id);
    await until(() => requests.filter((request) => request.path.endsWith("/commands")).length >= 2);
    expect(recovery.status(botId)).toBeNull();
    expect(recovery.refusal(box.id, "before")).toBeNull();
    expect(requests.some((request) => request.path.endsWith("/stop") || request.method === "DELETE")).toBe(false);
    expect(healthModule.boatHealth.notRespondingSince(box.id)).toBeNull();
  });
});

describe("the computer panel's Restart computer and Replace computer", () => {
  it("restart stops and starts the computer and reports that it answers", async () => {
    const { botId, box } = await botWith("ready");
    expect(await recovery.restart(botId)).toEqual({ answers: true });
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual(expect.arrayContaining([`POST /boxes/${box.id}/stop`, `POST /boxes/${box.id}/resume`]));
    expect(recovery.status(botId)).toMatchObject({ state: "restarted", manual: true });
    expect(told).toEqual([]);
  });

  it("restart says when the computer still does not answer, and deletes nothing", async () => {
    const { botId, box } = await botWith("ready");
    commandStatus.set(box.id, 502);
    expect(await recovery.restart(botId)).toEqual({ answers: false });
    expect(deletes()).toHaveLength(0);
  });

  it("refuses to restart a computer the provider reports in error", async () => {
    const { botId } = await botWith("error");
    await expect(recovery.restart(botId)).rejects.toThrow(/replace it instead/);
  });

  it("replace deletes through the same path, needs no hourly allowance, and the bot hears it was the person's", async () => {
    const { botId, box } = await botWith("ready");
    expect(await recovery.replace(botId)).toEqual({ replaced: true });
    expect(deletes().map((request) => request.headers["x-ascii-confirm-delete"])).toEqual([box.id]);
    expect(recovery.status(botId)).toMatchObject({ state: "replaced", manual: true });
    expect(told).toEqual([]);
    const created = await provisioned(botId);
    expect(recovery.notice(created.boxId)).toBe(words.CLOUD_COMPUTER_REPLACED_BY_PERSON);
    expect(await recovery.replace(botId)).toEqual({ replaced: true });
    expect(deletes()).toHaveLength(2);
  });

  it("replace also takes a computer the provider reports in error", async () => {
    const { botId, box } = await botWith("error");
    expect(await recovery.replace(botId)).toEqual({ replaced: true });
    expect(deletes().map((request) => request.headers["x-ascii-confirm-delete"])).toEqual([box.id]);
  });
});

describe("a start the Admin refuses right after a replacement", () => {
  it("tells the bot the computer is being replaced, not that the plan is full", async () => {
    const { botId } = await botWith("ready");
    await recovery.replace(botId);
    const refusal = boat.boatRefusal(429, "boat create", { ok: false, code: "limit_reached", reason: "at_once", limit: 1, used: 1 }, true);
    expect(recovery.claimSentence(botId, refusal)).toBe(words.CLOUD_COMPUTER_NOT_RESPONDING);
    expect(recovery.claimSentence("another-bot", refusal)).toBeUndefined();
  });
});

describe("with automatic replacement off, the default", () => {
  beforeEach(() => { autoOn = false; });

  it("is off unless the environment or config.json turns it on, and the environment wins", () => {
    const on = recoveryModule.cloudComputerAutoReplace;
    expect(on({}, {})).toBe(false);
    expect(on({ features: { cloudComputerAutoReplace: true } }, {})).toBe(true);
    expect(on({}, { OMB_CLOUD_COMPUTER_AUTO_REPLACE: "1" })).toBe(true);
    expect(on({ features: { cloudComputerAutoReplace: true } }, { OMB_CLOUD_COMPUTER_AUTO_REPLACE: "0" })).toBe(false);
    expect(on({}, { OMB_CLOUD_COMPUTER_AUTO_REPLACE: "yes" })).toBe(false);
  });

  it("never deletes a computer the provider reports in error: the bot and the person hear it once", async () => {
    const { botId } = await botWith("error");
    await boat.findBoat(cfg, botId);
    for (let i = 0; i < 3; i++) { await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toThrow(words.CLOUD_COMPUTER_NEEDS_PERSON); at += DEAD_CONFIRM; }
    expect(deletes()).toHaveLength(0);
    expect(requests.some((request) => request.method === "POST" && request.path === "/boxes")).toBe(false);
    expect(told).toEqual([[botId, "needsPerson"]]);
    expect(recovery.status(botId)?.state).toBe("needs-person");
  });

  it("still restarts a computer that stopped answering, but never deletes it after ten minutes", async () => {
    const { botId, box } = await botWith("ready");
    const witness = await botWith("ready");
    commandStatus.set(box.id, 502);
    await boat.findBoat(cfg, botId);
    stopsAnswering(box.id);
    health.answered(witness.box.id);
    await until(() => recovery.status(botId)?.state === "needs-person");
    expect(stops().map((request) => request.path)).toEqual([`/boxes/${box.id}/stop`]);
    expect(requests.some((request) => request.path === `/boxes/${box.id}/resume`)).toBe(true);
    expect(deletes()).toHaveLength(0);
    expect(told).toEqual([[botId, "needsPerson"]]);
    expect(recovery.refusal(box.id, "after")).toBe(words.CLOUD_COMPUTER_NEEDS_PERSON);
    expect(recovery.refusal(box.id, "before")).toBeNull();
    at += 6 * 60_000;
    health.answered(witness.box.id);
    health.unanswered(box.id);
    expect(recovery.status(botId)?.state).toBe("not-responding");
    await until(() => recovery.status(botId)?.state === "needs-person");
    expect(deletes()).toHaveLength(0);
    expect(told).toEqual([[botId, "needsPerson"]]);
  });

  it("does not reach the hourly limit either: nothing is deleted, so nothing is counted", async () => {
    const { botId } = await botWith("error");
    await boat.findBoat(cfg, botId);
    await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toThrow(words.CLOUD_COMPUTER_NEEDS_PERSON);
    at += 2 * 60 * 60_000;
    await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toThrow(words.CLOUD_COMPUTER_NEEDS_PERSON);
    expect(deletes()).toHaveLength(0);
    expect(told.filter(([, line]) => line === "capped")).toEqual([]);
  });

  it("Replace computer still deletes it and the next start makes a new one", async () => {
    const { botId, box } = await botWith("error");
    await boat.findBoat(cfg, botId);
    await expect(boat.provisionBoat(cfg, botId, "Bot")).rejects.toThrow(words.CLOUD_COMPUTER_NEEDS_PERSON);
    expect(await recovery.replace(botId)).toEqual({ replaced: true });
    expect(deletes().map((request) => request.headers["x-ascii-confirm-delete"])).toEqual([box.id]);
    const created = await provisioned(botId);
    expect(created.boxId).not.toBe(box.id);
    expect(recovery.notice(created.boxId)).toBe(words.CLOUD_COMPUTER_REPLACED_BY_PERSON);
  });
});

describe("deletes from this installation", () => {
  it("are sent one at a time, whoever asks for them, with each one fenced on disk before it waits", async () => {
    deleteDelayMs = 300;
    const first = await botWith("ready");
    const second = await botWith("ready");
    await boat.findBoat(cfg, first.botId);
    await boat.findBoat(cfg, second.botId);
    const both = Promise.all([recovery.replace(first.botId), recovery.replace(second.botId)]);
    await until(() => deletes().length === 1);
    expect(journal.getBoatDeletion(second.box.id)).toBeTruthy();
    await both;
    expect(deleteSpans).toHaveLength(2);
    const [a, b] = deleteSpans;
    expect(b!.start).toBeGreaterThanOrEqual(a!.end);
  });
});
