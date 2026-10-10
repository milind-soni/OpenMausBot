// The full server with Cloud Pro's included decision model, over its real
// HTTP boundary, against one stub that plays Jev (/jev, the person's own
// decider.baseUrl) and the Admin's relay (/relay). With no key to paste,
// rooms start on Auto and ask the relay; an own key wins and goes only to
// Jev; clearing it falls back; an explicit off wins. The included token goes
// only to <OMB_CLOUD_DECIDER_URL>/v1/systemone, only with the two requests
// the relay accepts, and is never saved, shown, logged or handed to a child.
// Disposable home; no network.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const RELAY_PATH = "/relay/api/cloud/services/decider";
// What the Admin's relay accepts, pinned here as literals: changing the app's
// copy must fail this test, because the relay would refuse it.
const ROOM_INSTRUCTIONS = "Which bot in this room should answer `new_message`? Choose __everyone__ only when the message needs several members to answer.";
const ROOM_STATE_KEYS = ["room", "humans_in_room", "bots_in_room", "recent_messages", "new_message"];
const KEY_CHECK = {
  state: { purpose: "OpenMausBot is checking that a decision-model key works." },
  questions: { answer: { type: "noul", instructions: "Is this a connection check?" } },
};

/** The relay's own check of a request body. */
function relayTakes(raw: string, body: any): boolean {
  if (Buffer.byteLength(raw) > 64 * 1024 || Buffer.byteLength(JSON.stringify(body.state)) > 24_000) return false;
  if (JSON.stringify({ state: body.state, questions: body.questions }) === JSON.stringify(KEY_CHECK)) return true;
  const ids = Object.keys(body.questions ?? {});
  const question = body.questions?.answer;
  const state = body.state;
  return ids.length === 1 && question?.type === "choice" && question.instructions === ROOM_INSTRUCTIONS &&
    Boolean(state) && typeof state === "object" && Object.keys(state).every((key) => ROOM_STATE_KEYS.includes(key));
}
const INCLUDED = `omb_decide_${randomBytes(32).toString("base64url")}`;
const OWN = "tsk_own_person_key_5e1c";
let stub: Server;
let relayUrl = "";
const requests: Array<{ side: string; path: string; auth: string; type?: string; refused?: boolean }> = [];
/** The bot the stub picks, at 0.95. */
let pick = "";
let home: string;
let data: string;
let engineDump: string;
let base: string;
let child: ChildProcess;
let log = "";

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub.test");
      const side = url.pathname.startsWith("/relay/") ? "relay" : url.pathname.startsWith("/jev/") ? "jev" : "";
      const body = JSON.parse(raw || "{}");
      const question = body.questions?.answer;
      const auth = String(req.headers.authorization ?? "");
      const refused = side === "relay" && !relayTakes(raw, body);
      requests.push({ side, path: url.pathname, auth, type: question?.type, ...(refused ? { refused } : {}) });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      // Each side knows only its own account, and serves only its one route.
      const route = side === "relay" ? `${RELAY_PATH}/v1/systemone` : "/jev/v1/systemone";
      if (!side || req.method !== "POST" || url.pathname !== route) return send(404, { error: { type: "not_found" } });
      if (auth !== (side === "relay" ? `Bearer ${INCLUDED}` : `Bearer ${OWN}`)) return send(401, { error: { type: "invalid_api_key" } });
      if (refused) return send(400, { error: { type: "invalid_request" } });
      if (question?.type === "noul") return send(200, { answers: { answer: { type: "noul", noul: 0.97 } } });
      const other = Object.keys(question.criteria).find((key) => key !== pick)!;
      send(200, { answers: { answer: { type: "choice", choice: pick, probabilities: { [pick]: 0.95, [other]: 0.05 } } } });
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  relayUrl = `${stubBase}${RELAY_PATH}`;

  home = mkdtempSync(join(tmpdir(), "omb-decider-included-"));
  data = join(home, ".openmausbot");
  mkdirSync(data, { recursive: true });
  engineDump = join(home, "engine-dump.json");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      quick: {
        driver: "claudeAgent", displayName: "Quick fixture", config: { cli: FAKE_CLAUDE },
        environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: engineDump },
      },
    },
    // Where an own key goes: never where the included token goes.
    decider: { baseUrl: `${stubBase}/jev` },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH,
      ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: data, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      OMB_CLOUD_DECIDER_URL: relayUrl,
      OMB_CLOUD_DECIDER_TOKEN: INCLUDED,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { if ((await api("GET", "/api/health")).body?.pid === child.pid) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (stub) await new Promise<void>((resolve) => stub.close(() => resolve()));
  if (home) await removeTempDir(home);
});

type RoomMessage = { id: string; kind: string; role: string; from?: { botId: string; name: string }; routedBy?: { provider: string } };

async function roomMessages(roomId: string): Promise<{ working: boolean; messages: RoomMessage[] }> {
  const room = (await api("GET", "/api/bots?messages=200")).body.groups.find((group: { id: string }) => group.id === roomId);
  return { working: Boolean(room?.working), messages: room?.messages ?? [] };
}

/** Send one message and wait for the round to settle; who spoke first. */
async function round(roomId: string, text: string): Promise<RoomMessage> {
  const before = new Set((await roomMessages(roomId)).messages.map((message) => message.id));
  expect((await api("POST", `/api/groups/${roomId}/messages`, { text })).status).toBe(202);
  let replies: RoomMessage[] = [];
  await expect.poll(async () => {
    const { working, messages } = await roomMessages(roomId);
    replies = messages.filter((message) => !before.has(message.id) && message.kind === "text" && message.role === "bot");
    return !working && replies.length > 0;
  }, { timeout: 20_000, interval: 150 }).toBe(true);
  return replies[0]!;
}

const routed = () => requests.filter((request) => request.type === "choice");
/** A credential on the side that does not know it. */
const crossed = () => requests.filter((request) =>
  (request.side === "jev" && request.auth.includes(INCLUDED)) || (request.side === "relay" && !request.auth.includes(INCLUDED)));

describe("Cloud Pro's included decision model", { timeout: 90_000 }, () => {
  const bots: Record<string, { id: string }> = {};
  let room: { id: string };

  it("works with no key: Settings sees it included and on, and a new room starts on Auto", async () => {
    const config = await api("GET", "/api/config");
    expect(config.body.decider).toEqual({ provider: "jev", configured: true, included: true, enabled: true, jobs: { roomRouting: true } });
    expect(config.text).not.toContain(INCLUDED);
    for (const name of ["Maya", "Theo"]) {
      bots[name] = (await api("POST", "/api/bots", {
        name, modelSelection: { instanceId: "quick", model: "claude-sonnet-5" }, requireAvailableModel: true,
      })).body.bot;
    }
    const created = await api("POST", "/api/groups", { name: "Launch", memberIds: [bots.Maya!.id, bots.Theo!.id] });
    expect(created.body.group.defaultResponder).toEqual({ kind: "auto" });
    room = created.body.group;
    expect((await api("PATCH", `/api/groups/${room.id}/setup`, { action: "complete", cwd: null, bulletin: "", defaultResponder: { kind: "auto" } })).status).toBe(200);
  });

  it("asks the relay who answers, at exactly <OMB_CLOUD_DECIDER_URL>/v1/systemone with the included token", async () => {
    pick = bots.Theo!.id;
    const reply = await round(room.id, "The signup button overlaps the footer on Safari.");
    expect(reply.from!.name).toBe("Theo");
    expect(reply.routedBy).toMatchObject({ provider: "jev" });
    expect(routed().at(-1)).toMatchObject({ side: "relay", path: new URL(`${relayUrl}/v1/systemone`).pathname, auth: `Bearer ${INCLUDED}` });
    expect(routed().at(-1)).not.toHaveProperty("refused");
  });

  it("Test checks the relay with one tiny call; a pasted draft is tested at Jev", async () => {
    const included = await api("POST", "/api/decider/test", {});
    expect(included.body).toMatchObject({ ok: true });
    expect(requests.at(-1)).toMatchObject({ side: "relay", type: "noul" });
    const draft = await api("POST", "/api/decider/test", { key: "tsk_draft_not_known" });
    expect(draft.body).toEqual({ ok: false, reason: "rejected", status: 401 });
    expect(requests.at(-1)).toMatchObject({ side: "jev", auth: "Bearer tsk_draft_not_known" });
    expect(included.text + draft.text).not.toContain(INCLUDED);
  });

  it("an own key wins and goes only to Jev; clearing it falls back to the included decisions", async () => {
    const saved = await api("PUT", "/api/config", { decider: { key: OWN } });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.decider).toEqual({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
    pick = bots.Maya!.id;
    expect((await round(room.id, "Can someone redo the pricing page copy?")).from!.name).toBe("Maya");
    expect(routed().at(-1)).toMatchObject({ side: "jev", auth: `Bearer ${OWN}` });

    const cleared = await api("PUT", "/api/config", { decider: { key: "" } });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body.decider).toEqual({ provider: "jev", configured: true, included: true, enabled: true, jobs: { roomRouting: true } });
    pick = bots.Theo!.id;
    expect((await round(room.id, "The navbar flickers on scroll.")).from!.name).toBe("Theo");
    expect(routed().at(-1)).toMatchObject({ side: "relay", auth: `Bearer ${INCLUDED}` });
  });

  it("an explicit off wins: no call, the room's lead answers, new rooms keep a lead", async () => {
    const off = await api("PUT", "/api/config", { decider: { enabled: false } });
    expect(off.status, off.text).toBe(200);
    expect(off.body.decider).toEqual({ provider: "jev", configured: true, included: true, enabled: false, jobs: { roomRouting: true } });
    const asked = routed().length;
    pick = bots.Theo!.id;
    const reply = await round(room.id, "Who can look at the webhook retries?");
    expect(reply.from!.name).toBe("Maya");
    expect(reply.routedBy).toBeUndefined();
    expect(routed().length).toBe(asked);
    const another = await api("POST", "/api/groups", { name: "Quiet", memberIds: [bots.Maya!.id, bots.Theo!.id] });
    expect(another.body.group.defaultResponder).not.toEqual({ kind: "auto" });
    // switching back on needs no key of the person's own
    const on = await api("PUT", "/api/config", { decider: { enabled: true } });
    expect(on.status, on.text).toBe(200);
    expect(on.body.decider).toMatchObject({ included: true, enabled: true });
  });

  it("never sends a credential to the other side, nor the relay a request it refuses, and never saves, logs or hands on the included token", async () => {
    expect(crossed()).toEqual([]);
    // two room decisions and one key check, and nothing else
    expect(requests.filter((request) => request.side === "relay").map((request) => request.type)).toEqual(["choice", "noul", "choice"]);
    expect(requests.filter((request) => request.refused)).toEqual([]);
    expect(readFileSync(join(data, "config.json"), "utf8")).not.toContain(INCLUDED);
    const decisions = join(data, "decider-log");
    const rows = readdirSync(decisions).map((name) => readFileSync(join(decisions, name), "utf8")).join("");
    expect(rows).toContain('"seam":"roomRouting"');
    expect(rows).not.toContain(INCLUDED);
    expect(log).not.toContain(INCLUDED);
    // An engine's environment.
    expect(existsSync(engineDump)).toBe(true);
    const engine = JSON.parse(readFileSync(engineDump, "utf8")).env;
    expect(engine).not.toHaveProperty("OMB_CLOUD_DECIDER_TOKEN");
    expect(JSON.stringify(engine)).not.toContain(INCLUDED);
    // A tool started with a copy of the server's own environment, as it is:
    // the token is gone from it, not merely filtered on the way out.
    const dump = join(home, "cli-env.json");
    const cli = join(home, "dump-env.mjs");
    writeFileSync(cli, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));
console.log("dump-env 1.0.0");
`, { mode: 0o755 });
    const probe = await api("POST", "/api/cli-test", { cli });
    expect(probe.body, probe.text).toMatchObject({ ok: true, version: "dump-env 1.0.0" });
    const raw = JSON.parse(readFileSync(dump, "utf8"));
    // Proves the dump is the server's environment, not an empty one. Every
    // OMB_CLOUD_* value, the relay URL included, is stripped from a probed CLI.
    expect(raw.HOME).toBe(home);
    expect(raw).not.toHaveProperty("OMB_CLOUD_DECIDER_URL");
    expect(raw).not.toHaveProperty("OMB_CLOUD_DECIDER_TOKEN");
    expect(JSON.stringify(raw)).not.toContain(INCLUDED);
  });
});
