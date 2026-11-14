// Real OMB server and renderer; only the paid Boat provider is an owned local
// HTTP stand-in. No guest commands execute and no real credentials are read.
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { launchUi } from "./control-omb-ui.ts";
import { fakeDesktopFrame } from "./fake-desktop-frame.ts";
import { fixtureApi } from "./preview-fixture.ts";

const MAP_TEAMS = [
  { team: "Research", bots: ["Iris", "Theo", "Mira", "Jonah"] },
  { team: "Growth", bots: ["Nova", "Felix", "Ruby", "Omar"] },
  { team: "Design", bots: ["Luna", "Kai", "Esme", "Remy"] },
  { team: "Ops", bots: ["Atlas", "Wren", "Sol", "Juno"] },
];

/** A Team map worth looking at: four teams whose bots each have their own cloud computer, one team sharing one, most
 * of them working (the fixture engine holds every turn open) and one asleep. */
export async function seedTeamMap(url: string): Promise<{ botIds: string[] }> {
  const api = fixtureApi(url);
  const botIds: string[] = [];
  for (const { team, bots } of MAP_TEAMS) {
    await api("POST", "/api/sidebar-sections", { name: team });
    for (const [index, name] of bots.entries()) {
      const { bot } = await api("POST", "/api/bots", { name, section: team, title: index === 0 ? "Chief of staff" : `${team} specialist` });
      if (index === 0) await api("PATCH", `/api/bots/${bot.id}`, { chiefOfStaff: true, managedSections: [], acknowledgePeerScope: true });
      if (team !== "Ops" || index === 0) {
        await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
        await api("POST", `/api/bots/${bot.id}/computer/provision`, {});
      }
      botIds.push(bot.id);
    }
  }
  const computer: { id: string } = await api("POST", "/api/team-computers", { name: "Ops desktop", requestId: crypto.randomUUID(), acknowledgeCost: true });
  await api("PATCH", `/api/team-computers/${computer.id}`, { section: "Ops", acknowledgeSharedAccess: true });
  await api("POST", `/api/bots/${botIds[7]}/computer/sleep`, {});
  for (const [index, botId] of botIds.entries()) {
    if (index % 5 !== 3) await api("POST", `/api/bots/${botId}/messages`, { text: "Work on your task on your computer." });
  }
  return { botIds };
}

export async function launchTeamComputersPreview(options: { frames?: boolean; map?: boolean } = {}) {
  const boats: Array<{ id: string; name: string; state: string }> = [];
  const calls: Array<{ method: string; path: string }> = [];
  const idempotency = new Map<string, string>();
  const shots = new Map<string, number>();
  const frameTicks = new Map<string, number>();
  let refuseCreate = false;
  const provider = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const path = requestUrl.pathname;
      const send = (body: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = raw ? JSON.parse(raw) : {};
      if (path === "/__fixture") {
        if (method === "POST") refuseCreate = body.refuseCreate === true;
        return send({ calls, boats, refuseCreate, shots: Object.fromEntries(shots) });
      }
      if (request.headers.authorization !== "Bearer box_verification_fixture") return send({ message: "fixture authentication failed" }, 401);
      calls.push({ method, path });
      // Boat's public API v1: /sandboxes paths and sandbox/sandboxes envelopes.
      if (method === "GET" && path === "/sandboxes") return send({ ok: true, type: "sandbox.list", sandboxes: boats, pageInfo: { nextCursor: null } });
      if (method === "POST" && path === "/sandboxes") {
        if (refuseCreate) return send({ message: "Fixture account is rate-limited. Retry this computer." }, 429);
        const key = String(request.headers["idempotency-key"] ?? "");
        if (!key || body.noEnv !== true) return send({ message: "fixture requires isolated idempotent creation" }, 400);
        const previous = idempotency.get(key);
        if (previous) return send({ ok: true, type: "sandbox.created", sandbox: boats.find((boat) => boat.id === previous) }, 202);
        const id = `bx_234567${"89abcdefghjkmnpqrstuvwxyz"[Math.floor(boats.length / 24)]}${"9abcdefghjkmnpqrstuvwxyz"[boats.length % 24]}`;
        const boat = { id, name: "fixture-pending", state: "idle" };
        boats.push(boat); idempotency.set(key, id);
        return send({ ok: true, type: "sandbox.created", sandbox: boat }, 202);
      }
      const match = path.match(/^\/sandboxes\/(bx_[23456789abcdefghjkmnpqrstuvwxyz]{8})(?:\/(commands|desktop|stop|resume|artifacts))?$/);
      const boat = boats.find((candidate) => candidate.id === match?.[1]);
      if (!match || !boat) return send({ message: "fixture resource not found" }, 404);
      if (method === "GET" && !match[2]) return send({ ok: true, sandbox: boat });
      if (method === "PATCH" && !match[2]) { boat.name = body.name; return send({ ok: true, sandbox: boat }); }
      if (method === "POST" && match[2] === "commands") {
        const captures = options.frames === true && String(body.command ?? "").includes("echo captured");
        return send({ ok: true, exitCode: 0, stdout: captures ? "captured\n" : "", stderr: "" });
      }
      if (method === "GET" && match[2] === "artifacts" && options.frames === true && boat.state === "idle") {
        const tick = (frameTicks.get(boat.id) ?? 0) + 1;
        frameTicks.set(boat.id, tick);
        // Receipts count only the Team map's own small frames; a turn's screen poller reads a different file.
        if (requestUrl.searchParams.get("path")?.includes("map-frame")) shots.set(boat.id, (shots.get(boat.id) ?? 0) + 1);
        const frame = fakeDesktopFrame(boats.indexOf(boat), tick);
        response.writeHead(200, { "content-type": "image/png", "content-length": String(frame.length) });
        response.end(frame);
        return;
      }
      if (method === "POST" && match[2] === "desktop") return send({ ok: true, desktopUrl: `https://desktop.invalid/${boat.id}` });
      if (method === "POST" && (match[2] === "stop" || match[2] === "resume")) {
        boat.state = match[2] === "stop" ? "archived" : "idle";
        return send({ ok: true, sandbox: boat }, 202);
      }
      // Unexpected deletion is deliberately refused and remains in receipts.
      return send({ message: "fixture does not implement this mutation" }, 405);
    })().catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
    });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Boat fixture has no loopback port");
  const boatFixtureApi = `http://127.0.0.1:${address.port}`;
  const stdout = new Writable({ write(chunk, _encoding, done) {
    const info = JSON.parse(String(chunk));
    if (!options.map) {
      process.stdout.write(`${JSON.stringify({ ...info, boatFixtureApi }, null, 2)}\n`, done);
      return;
    }
    seedTeamMap(info.url).then(
      (seeded) => process.stdout.write(`${JSON.stringify({ ...info, boatFixtureApi, ...seeded }, null, 2)}\n`, done),
      (error) => done(error instanceof Error ? error : new Error(String(error))),
    );
  } });
  try {
    await launchUi(options.map ? ["--mode", "hang"] : [], process.env, { stdout, stderr: process.stderr }, { boatFixtureApi });
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((done, reject) => provider.close((error) => error ? reject(error) : done()));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const map = process.argv.includes("--map");
  await launchTeamComputersPreview({ map, frames: map || process.argv.includes("--frames") });
}
