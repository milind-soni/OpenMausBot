import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { removeTempDir } from "./testing/cleanup.ts";

type RoomFixture = {
  fixture: VerificationServer;
  env: { OPENMAUSBOT_URL: string };
  bot: any;
  channel: any;
};

async function createRoomFixture(options: {
  parentEnv?: NodeJS.ProcessEnv;
  extraProviders?: ReadonlyArray<"acp" | "opencode">;
  fakeAcpMode?: string;
  dataDir?: string;
} = {}): Promise<RoomFixture> {
  const fixture = await launchVerificationServer(
    options.parentEnv ?? process.env,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.extraProviders ?? [],
    undefined,
    { dataDir: options.dataDir, fakeAcpMode: options.fakeAcpMode },
  );
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  const control = (args: string[]) => runControlOmb(args, { env }) as Promise<any>;
  const bot = (await control(["new-bot", "--name", "Parity bot"])).bot;
  const configuredAcp = options.extraProviders?.find((provider) => provider === "acp" || provider === "opencode");
  if (configuredAcp) {
    const catalog = await control(["models"]);
    const model = catalog.instances.find((instance: any) => instance.instanceId === configuredAcp)?.models.options[0]?.id;
    expect(model).toBeTruthy();
    await control(["set-model", "--bot", bot.id, "--instance", configuredAcp, "--model", model]);
  }
  const channel = (await handleToolCall("create_channel", {
    name: "Runtime parity room",
    member_ids: [bot.id],
    default_responder: { kind: "member", bot_id: bot.id },
  }, (path, init) => request(path, init, fixture.info.url)) as any).channel;
  return { fixture, env, bot, channel };
}

const api = (fixture: VerificationServer, path: string, init: RequestInit = {}) =>
  request(path, init, fixture.info.url) as Promise<any>;

const control = (fixture: RoomFixture, args: string[]) =>
  runControlOmb(args, { env: fixture.env }) as Promise<any>;

const messages = (fixture: RoomFixture) =>
  api(fixture.fixture, `/api/threads/${fixture.channel.activeTaskId}/messages`)
    .then((result) => result.messages as any[]);

const wait = async (fixture: RoomFixture) => {
  const result = await control(fixture, ["wait", "--channel", fixture.channel.id, "--timeout", "30"]);
  expect(result.status).toBe("settled");
};

async function openPermissionCard(fixture: RoomFixture, text: string): Promise<any> {
  await control(fixture, ["send-channel", "--channel", fixture.channel.id, "--text", text]);
  let card: any;
  await expect.poll(async () => {
    card = (await messages(fixture)).find((message) => message.card?.requestId && !message.card.answered);
    return card
      ? {
          working: (await control(fixture, ["channels"]))
            .channels.find((candidate: any) => candidate.id === fixture.channel.id)?.working,
          title: card.card.title,
          options: card.card.options,
        }
      : null;
  }, { timeout: 15_000 }).toEqual({
    working: true,
    title: "Approval needed",
    options: ["Allow", "Deny"],
  });
  expect((await control(fixture, ["wait", "--channel", fixture.channel.id, "--timeout", "1"])).status)
    .toBe("needs-user");
  return card;
}

const canonicalCard = (message: any) => ({
  kind: message.kind,
  title: message.card.title,
  subtitle: message.card.subtitle,
  options: message.card.options,
  tool: message.card.tool,
  allowSession: message.card.allowSession ?? false,
});

it("keeps the permission broker and request-card lifecycle equivalent on fresh and resumed room turns", async () => {
  const room = await createRoomFixture({ extraProviders: ["acp"], fakeAcpMode: "permission" });
  try {
    const patched = await fetch(`${room.fixture.info.url}/api/bots/${room.bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalMode: "ask" }),
    });
    expect(patched.status).toBe(200);

    const fresh = await openPermissionCard(room, "Run the parity command once");
    const allowed = await api(room.fixture, `/api/threads/${room.channel.activeTaskId}/respond`, {
      method: "POST",
      body: JSON.stringify({ requestId: fresh.card.requestId, behavior: "allow" }),
    });
    expect(allowed).toMatchObject({ ok: true, outcome: "allowed-once" });
    await wait(room);
    expect((await messages(room)).find((message) => message.id === fresh.id)?.card)
      .toMatchObject({ answered: "allow" });

    const resumed = await openPermissionCard(room, "Run the parity command twice");
    expect(canonicalCard(resumed)).toEqual(canonicalCard(fresh));
    const denied = await api(room.fixture, `/api/threads/${room.channel.activeTaskId}/respond`, {
      method: "POST",
      body: JSON.stringify({ requestId: resumed.card.requestId, behavior: "deny" }),
    });
    expect(denied).toMatchObject({ ok: true, outcome: "rejected" });
    await wait(room);
    expect((await messages(room)).find((message) => message.id === resumed.id)?.card)
      .toMatchObject({ answered: "deny", dismissed: false });

    const native = readFileSync(join(room.fixture.info.dataDir, "native", `${room.channel.activeTaskId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(native.filter((entry) => ["session/new", "session/load"].includes(entry.msg?.method))
      .map((entry) => entry.msg.method)).toEqual(["session/new", "session/load"]);
    expect((await messages(room)).filter((message) => message.card?.requestId && !message.card.answered)).toEqual([]);
  } finally {
    await room.fixture.close();
  }
}, 60_000);

it("keeps an exact-operation session approval on the resumed room session without reopening a card", async () => {
  const room = await createRoomFixture({ extraProviders: ["acp"], fakeAcpMode: "permission" });
  try {
    const first = await openPermissionCard(room, "Use the same approved operation");
    const answered = await api(room.fixture, `/api/threads/${room.channel.activeTaskId}/respond`, {
      method: "POST",
      body: JSON.stringify({ requestId: first.card.requestId, behavior: "allow", always: true }),
    });
    expect(answered).toMatchObject({ ok: true, outcome: "allowed-once" });
    await wait(room);

    const cardsBefore = (await messages(room)).filter((message) => message.card?.requestId).length;
    await control(room, ["send-channel", "--channel", room.channel.id, "--text", "Use the same approved operation"]);
    await wait(room);
    const allMessages = await messages(room);
    expect(allMessages.filter((message) => message.card?.requestId)).toHaveLength(cardsBefore);
    expect(allMessages.filter((message) => message.card?.requestId && !message.card.answered)).toEqual([]);

    const native = readFileSync(join(room.fixture.info.dataDir, "native", `${room.channel.activeTaskId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(native.filter((entry) => ["session/new", "session/load"].includes(entry.msg?.method))
      .map((entry) => entry.msg.method)).toEqual(["session/new", "session/load"]);
  } finally {
    await room.fixture.close();
  }
}, 60_000);

it("keeps approval mode, MCP setup, and turn-scoped capabilities equivalent across fresh and resumed room turns", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-room-session-parity-"));
  const finishGate = join(scratch, "finish");
  const room = await createRoomFixture({
    parentEnv: {
      ...process.env,
      FAKE_CLAUDE_MODE: "slow",
      FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
      FAKE_CLAUDE_TOOL_CALLS: "[]",
    },
  });
  try {
    let previousPid: number | undefined;
    const start = async (text: string) => {
      rmSync(finishGate, { force: true });
      await control(room, ["send-channel", "--channel", room.channel.id, "--text", text]);
      await expect.poll(() => {
        if (!existsSync(room.fixture.fixtureDumpPath)) return null;
        const dump = JSON.parse(readFileSync(room.fixture.fixtureDumpPath, "utf8"));
        return dump.pid === previousPid ? null : dump.pid;
      }, { timeout: 15_000 }).toEqual(expect.any(Number));
      const dump = JSON.parse(readFileSync(room.fixture.fixtureDumpPath, "utf8"));
      previousPid = dump.pid;
      const permissionAt = dump.argv.indexOf("--permission-mode");
      const agents = dump.mcpConfig.mcpServers.agents;
      return {
        dump,
        canonical: {
          permissionMode: dump.argv[permissionAt + 1],
          mcpNames: Object.keys(dump.mcpConfig.mcpServers).sort(),
          agentsCommand: basename(agents.command),
          agentsArgs: agents.args.map((arg: string) => basename(arg)),
        },
        token: agents.env.OMB_COMMS_TOKEN as string,
      };
    };
    const assertActiveThenRevoked = async (token: string) => {
      expect(token).toMatch(/^[a-f0-9]{48}$/);
      const active = await fetch(`${room.fixture.info.url}/api/internal/agents`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(active.status).toBe(200);
      writeFileSync(finishGate, "finish");
      await wait(room);
      const expired = await fetch(`${room.fixture.info.url}/api/internal/agents`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(expired.status).toBe(401);
    };

    const fresh = await start("Fresh runtime parity turn");
    expect(fresh.dump.argv).toContain("--session-id");
    expect((await control(room, ["wait", "--channel", room.channel.id, "--timeout", "1"])).status).toBe("timed-out");
    await assertActiveThenRevoked(fresh.token);

    const resumed = await start("Resumed runtime parity turn");
    expect(resumed.dump.argv).toContain("--resume");
    expect(resumed.canonical).toEqual(fresh.canonical);
    expect(resumed.token).not.toBe(fresh.token);
    expect((await control(room, ["wait", "--channel", room.channel.id, "--timeout", "1"])).status).toBe("timed-out");
    await assertActiveThenRevoked(resumed.token);

    const stopped = await start("Stop after the resumed provider accepted this turn");
    expect(stopped.dump.argv).toContain("--resume");
    expect((await fetch(`${room.fixture.info.url}/api/internal/agents`, {
      headers: { authorization: `Bearer ${stopped.token}` },
    })).status).toBe(200);
    await control(room, ["interrupt", "--channel", room.channel.id]);
    await wait(room);
    expect((await fetch(`${room.fixture.info.url}/api/internal/agents`, {
      headers: { authorization: `Bearer ${stopped.token}` },
    })).status).toBe(401);
    expect((await messages(room)).filter((message) => message.card?.requestId && !message.card.answered)).toEqual([]);
  } finally {
    await room.fixture.close();
    await removeTempDir(scratch);
  }
}, 90_000);

it("reapplies an ACP variant on a resumed room session without rotating its cursor", async () => {
  const room = await createRoomFixture({ extraProviders: ["opencode"] });
  try {
    const catalog = await control(room, ["models"]);
    const model = catalog.instances.find((instance: any) => instance.instanceId === "opencode")?.models.options[0]?.id;
    expect(model).toBe("opencode/fixture-model");
    const select = async (variant: string) => fetch(`${room.fixture.info.url}/api/bots/${room.bot.id}/model`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "opencode", model, variant }),
    });
    expect((await select("low")).status).toBe(200);
    await control(room, ["send-channel", "--channel", room.channel.id, "--text", "Fresh ACP variant turn"]);
    await wait(room);

    expect((await select("high")).status).toBe(200);
    await control(room, ["send-channel", "--channel", room.channel.id, "--text", "Resumed ACP variant turn"]);
    await wait(room);

    const native = readFileSync(join(room.fixture.info.dataDir, "native", `${room.channel.activeTaskId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(native.filter((entry) => ["session/new", "session/load"].includes(entry.msg?.method))
      .map((entry) => entry.msg.method)).toEqual(["session/new", "session/load"]);
    expect(native.filter((entry) => entry.msg?.method === "session/set_config_option")
      .map((entry) => entry.msg.params?.value)).toEqual(["low", "high"]);
  } finally {
    await room.fixture.close();
  }
}, 60_000);

it("stops a resumed room turn cleanly while its provider is still setting up", async () => {
  let room = await createRoomFixture({ extraProviders: ["acp"], fakeAcpMode: "receipt" });
  let cleanupFixture = room.fixture;
  try {
    await control(room, ["send-channel", "--channel", room.channel.id, "--text", "Establish a resumable session"]);
    await wait(room);
    const statePath = join(room.fixture.info.dataDir, "room-continuations.json");
    const owner = () => JSON.parse(readFileSync(statePath, "utf8")).records.find((record: any) =>
      record.groupId === room.channel.id
      && record.threadId === room.channel.activeTaskId
      && record.botId === room.bot.id);
    const establishedCursors = owner().cursors;
    expect(Object.keys(establishedCursors)).toHaveLength(1);
    const dataDir = room.fixture.info.dataDir;

    await room.fixture.stop();
    const restarted = await launchVerificationServer(
      process.env,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ["acp"],
      undefined,
      { dataDir, fakeAcpMode: "hang-initialize" },
    );
    cleanupFixture = restarted;
    room = {
      ...room,
      fixture: restarted,
      env: { OPENMAUSBOT_URL: restarted.info.url },
    };

    await control(room, ["send-channel", "--channel", room.channel.id, "--text", "Stop during provider setup"]);
    await expect.poll(async () => (await control(room, ["channels"]))
      .channels.find((candidate: any) => candidate.id === room.channel.id)?.busyBotId, { timeout: 15_000 })
      .toBe(room.bot.id);
    await control(room, ["interrupt", "--channel", room.channel.id]);
    expect((await control(room, ["wait", "--channel", room.channel.id, "--timeout", "30"])).status)
      .toBe("failed");

    expect((await control(room, ["channels"]))
      .channels.find((candidate: any) => candidate.id === room.channel.id)?.working).toBe(false);
    expect((await messages(room)).filter((message) => message.card?.requestId && !message.card.answered)).toEqual([]);
    expect(owner().cursors).toEqual(establishedCursors);
  } finally {
    await cleanupFixture.close();
  }
}, 60_000);
