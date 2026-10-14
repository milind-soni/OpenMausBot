import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionRegistry } from "./sessions.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { startFakeControlPlane, type FakeControlPlane, type FakeRelayRequest } from "./testing/fake-control-plane.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
/** What the bot asks to run: the thing a push must never carry. */
const SECRET_COMMAND = "cat /Users/someone/Documents/payroll.csv && export API_KEY=sk-live-must-not-leak";
const WATCHING_TOKEN = "aa".repeat(32);
const POCKET_TOKEN = "bb".repeat(32);

let child: ChildProcess;
let home = "";
let base = "";
let log = "";
let relay: FakeControlPlane;
let phoneToken = "";
let phoneSessionId = "";

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
/** A paired session's phone (bearer), and a companion phone (the headers the sidecar adds). */
const sessionPhone = () => ({ authorization: `Bearer ${phoneToken}` });
const companionPhone = { "x-openmausbot-companion": "1", "x-openmausbot-companion-device": "pocket-phone" };
const sends = (kind?: string) => relay.requests.filter((request: FakeRelayRequest) =>
  request.path === "/v1/installations/self/push/send" && (!kind || (request.body?.notification as { kind?: string } | undefined)?.kind === kind));

posixOnly("closed-app phone alerts through the relay", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    relay = await startFakeControlPlane();
    home = mkdtempSync(join(tmpdir(), "omb-phone-push-e2e-"));
    const data = join(home, ".openmausbot");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: {
        // every turn stops to ask whether it may run SECRET_COMMAND
        asks: {
          driver: "grokAgent",
          environment: {
            FAKE_ACP_MODE: "permission",
            FAKE_ACP_PERMISSION_TOOL_CALL: JSON.stringify({ kind: "execute", rawInput: { command: SECRET_COMMAND }, title: SECRET_COMMAND }),
          },
          config: { cli: FAKE_CLI, fullAuto: false },
        },
      },
    }));
    // a phone paired with this server directly, chat-only
    const registry = new SessionRegistry({ file: join(data, "sessions.json") });
    const issued = registry.issue({ label: "Watching phone", scopes: ["client"] });
    phoneToken = issued.token;
    phoneSessionId = issued.session.id;
    registry.close();

    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        OMB_CONTROL_PLANE_URL: relay.url,
        OMB_INSTALLATION_CREDENTIAL: relay.credential,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => (log += chunk));
    child.stderr!.on("data", (chunk) => (log += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${log}`);
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`server never came up:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 45_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await relay?.stop();
    if (home) await removeTempDir(home);
  });

  it("wakes the phone that is not watching, once, with no content", async () => {
    // both phones register; the relay learns both tokens for this installation
    const watching = await api("PUT", "/api/push/device", { token: WATCHING_TOKEN, environment: "production", pairing: "watching-pair" }, sessionPhone());
    expect(watching, log.slice(-2_000)).toMatchObject({ status: 200, body: { push: "on", relay: "registered" } });
    const pocket = await api("PUT", "/api/push/device", { token: POCKET_TOKEN, environment: "sandbox", pairing: "pocket-pair-1" }, companionPhone);
    expect(pocket).toMatchObject({ status: 200, body: { push: "on", relay: "registered" } });
    expect(relay.registered().sort()).toEqual([WATCHING_TOKEN, POCKET_TOKEN].sort());

    const created = await api("POST", "/api/bots", {});
    expect(created.status).toBe(201);
    const bot = (await api("PATCH", `/api/bots/${created.body.bot.id}`, {
      name: "Scout",
      notifications: true,
      modelSelection: { instanceId: "asks", model: "fake-model" },
      approvalMode: "ask",
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Launch",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    })).body.group;
    expect(room?.id).toBeTruthy();

    // the watching phone's app is open: it holds the event stream
    const stream = await openSse(`${base}/api/events`, sessionPhone());
    try {
      const posted = await api("POST", `/api/groups/${room.id}/messages`, { text: "ship it" });
      expect(posted.status, JSON.stringify(posted.body)).toBe(202);
      const frame = await stream.until((candidate) => candidate.kind === "notify" && candidate.notification?.kind === "approval", 30_000);
      expect(frame.notification.threadId).toBe(room.threadId);
      const push = await relay.waitFor((request) => request.path === "/v1/installations/self/push/send");

      expect(push.authorization).toBe(`Bearer ${relay.credential}`);
      expect(push.body).toEqual({
        v: 1,
        token: POCKET_TOKEN,
        pairing: "pocket-pair-1",
        notification: {
          kind: "approval",
          title: "Scout in Launch needs approval",
          botId: bot.id,
          botName: "Scout",
          threadId: room.threadId,
          roomId: room.id,
          roomName: "Launch",
        },
      });
      for (const leak of ["payroll", "sk-live", "/Users/", "API_KEY", "cat "]) expect(push.raw).not.toContain(leak);

      // Answer the card; the turn's reply is the barrier: anything the
      // approval could still have sent was sent before it.
      const card = (await api("GET", `/api/threads/${room.threadId}/messages`)).body.messages
        .find((message: any) => message.card?.requestId && !message.card.answered);
      expect(card, log.slice(-2_000)).toBeTruthy();
      expect((await api("POST", `/api/threads/${room.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" })).status).toBe(200);
      await stream.until((candidate) => candidate.kind === "message" && candidate.message?.text === "handled the permission decision", 30_000);
      expect(sends("approval")).toHaveLength(1);
      expect(sends().every((request) => request.body?.token === POCKET_TOKEN)).toBe(true);
    } finally {
      stream.close();
    }
  }, 90_000);

  it("drops a revoked phone's token at the relay", async () => {
    expect((await api("DELETE", `/api/auth/sessions/${phoneSessionId}`)).status).toBeLessThan(300);
    const unregister = await relay.waitFor((request) => request.path === "/v1/installations/self/push/unregister");
    expect(unregister.body).toEqual({ v: 1, token: WATCHING_TOKEN });
    expect(relay.registered()).toEqual([POCKET_TOKEN]);
  }, 30_000);
});
