// The idle sleep over HTTP, against one stub that plays both Boat (/boat, public API v1) and the Admin's relay (/relay,
// the legacy box dialect): the stop reaches whichever one the credential belongs to, after Chrome is asked to exit.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const INCLUDED = "box_omb_included-relay-token";
const OWN = "boat_own-key";
const botId = "auto-sleep-test";
const boxId = "bx_23456789";
const machineName = `ogb-${botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "")}-${createHash("sha256").update(botId).digest("hex").slice(0, 6)}`;

let api: Server;
let base = "";
let state = "ready";
/** Status the stub answers a stop with; a 2xx archives the computer. */
let stopStatus = 200;
const requests: Array<{ method: string; path: string; auth: string; command?: string; at: number }> = [];

const stops = () => requests.filter(request => request.method === "POST" && request.path.endsWith("/stop"));
const waitFor = async (accept: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!accept()) {
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(requests)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

beforeAll(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://boat.test");
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ method: req.method ?? "GET", path: url.pathname, auth: String(req.headers.authorization ?? ""), command: body.command, at: Date.now() });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify(payload));
      };
      const [, prefix = "", rest = ""] = /^(\/boat\/api\/v1|\/relay\/api\/box\/v1)(\/.*)$/.exec(url.pathname) ?? [];
      const legacy = prefix === "/relay/api/box/v1";
      const expected = legacy ? `Bearer ${INCLUDED}` : `Bearer ${OWN}`;
      if (!prefix || req.headers.authorization !== expected) return send(401, { ok: false, code: "unauthorized", message: "Unauthorized" });
      const [root, one, many] = legacy ? ["/boxes", "box", "boxes"] : ["/sandboxes", "sandbox", "sandboxes"];
      const row = { id: boxId, name: machineName, state };
      if (rest === root) return send(200, { ok: true, [many]: [row], pageInfo: { nextCursor: null } });
      if (rest === `${root}/${boxId}` && req.method === "GET") return send(200, { ok: true, [one]: row });
      if (rest === `${root}/${boxId}/commands`) return send(200, { exitCode: 0, stdout: "", stderr: "" });
      if (rest === `${root}/${boxId}/stop`) {
        if (stopStatus < 300) state = "archived";
        return send(stopStatus, stopStatus < 300 ? { ok: true } : { ok: false, message: "Cloud computers are not available right now." });
      }
      send(404, { ok: false, code: "not_found", message: `unexpected ${req.method} ${url.pathname}` });
    });
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => api.close(() => resolve()));
});

describe("a cloud computer goes to sleep after its idle window", () => {
  let power: ReturnType<typeof import("./host/cloud-computer-power.ts").createCloudComputerPower>;
  let logs: string[];
  let busy: boolean;

  async function powerFor(cfg: import("./config.ts").AppConfig) {
    vi.resetModules();
    const { createCloudComputerPower } = await import("./host/cloud-computer-power.ts");
    power = createCloudComputerPower({
      cfg,
      busy: () => busy,
      claim: () => () => {},
      owners: () => [{ botId, name: "Auto sleep", inUse: busy }],
      routines: () => [],
      routineComputer: () => null,
      broadcast: () => {},
      log: line => logs.push(line),
    });
    return power;
  }

  beforeEach(() => {
    requests.length = 0;
    state = "ready";
    stopStatus = 200;
    logs = [];
    busy = false;
    vi.stubEnv("BOX_TOKEN", undefined);
    vi.stubEnv("OMB_BOAT_API", `${base}/boat/api/v1`);
    vi.stubEnv("OMB_CLOUD_BOAT_URL", `${base}/relay/api/box/v1`);
    vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", INCLUDED);
    vi.stubEnv("OMB_CLOUD_COMPUTER_IDLE_MS", "1000");
  });

  afterEach(() => {
    power?.close();
    vi.unstubAllEnvs();
  });

  it("with a person's own Boat key, stops it at boat.dev, asking Chrome to exit first", async () => {
    await powerFor({ box: { token: OWN } });
    power.used(botId);
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(stops()).toEqual([]);
    await waitFor(() => stops().length === 1);
    expect(stops()[0]).toMatchObject({ path: `/boat/api/v1/sandboxes/${boxId}/stop`, auth: `Bearer ${OWN}` });
    const quiesce = requests.findIndex(request => request.path.endsWith("/commands"));
    expect(requests[quiesce]?.command).toContain("kill -TERM");
    expect(quiesce).toBeLessThan(requests.indexOf(stops()[0]!));
    expect(requests.every(request => request.path.startsWith("/boat/"))).toBe(true);
    expect(state).toBe("archived");
  });

  it("with the cloud computer a Cloud plan includes, stops it through the Admin relay only", async () => {
    await powerFor({});
    power.used(botId);
    await waitFor(() => stops().length === 1);
    expect(stops()[0]).toMatchObject({ path: `/relay/api/box/v1/boxes/${boxId}/stop`, auth: `Bearer ${INCLUDED}` });
    expect(requests.every(request => request.path.startsWith("/relay/"))).toBe(true);
  });

  it("after a restart, finds a computer left on through the relay and puts it to sleep", async () => {
    await powerFor({});
    await power.armRunning();
    expect(requests.map(request => `${request.method} ${request.path}`)).toEqual(["GET /relay/api/box/v1/boxes"]);
    await waitFor(() => stops().length === 1);
    expect(stops()[0]?.path).toBe(`/relay/api/box/v1/boxes/${boxId}/stop`);
  });

  it("keeps a busy computer on, and leaves one already asleep alone", async () => {
    await powerFor({ box: { token: OWN } });
    busy = true;
    power.used(botId);
    await new Promise(resolve => setTimeout(resolve, 3_500));
    expect(requests).toEqual([]);
    busy = false;
    state = "archived";
    await new Promise(resolve => setTimeout(resolve, 1_800));
    expect(stops()).toEqual([]);
    expect(requests.map(request => request.method)).toEqual(["GET"]);
  });

  it("a stop the relay refuses is logged and retried after a longer wait each time", async () => {
    stopStatus = 503;
    await powerFor({});
    power.used(botId);
    await waitFor(() => stops().length === 3 && logs.length === 3, 10_000);
    for (const line of logs) {
      expect(line).toBe("cloud computer auto-sleep-test: could not go to sleep, retrying in 1 min: boat sleep failed: Cloud computers are not available right now.");
    }
    const [first, second, third] = stops().map(stop => stop.at);
    // A Node timer may fire up to a millisecond before its delay by Date.now().
    expect(second! - first!).toBeGreaterThanOrEqual(1_000 - 5);
    expect(third! - second!).toBeGreaterThanOrEqual(2_000 - 5);
  });
});
