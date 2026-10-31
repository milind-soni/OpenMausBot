import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("paired devices limited to one department, bot or group chat", () => {
  let fixture: VerificationServer;
  const evidence: unknown[] = [];
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const threads: Record<string, string> = {};

  const api = async (method: string, path: string, body?: unknown, as?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const result = { status: response.status, body: text ? JSON.parse(text) : null };
    evidence.push({ as: as ?? "owner", method, path, status: result.status });
    return result;
  };
  const pair = async (name: string, view?: unknown) => {
    const invitation = await api("POST", "/api/auth/pairing", { label: name, scopes: ["admin", "client"], ...(view === undefined ? {} : { view }) });
    expect(invitation.status, JSON.stringify(invitation.body)).toBe(200);
    const accepted = await api("POST", "/api/auth/pair", { code: invitation.body.code, label: name });
    expect(accepted.status).toBe(200);
    tokens[name] = accepted.body.token;
    return accepted.body.session;
  };
  const seen = async (as: string) => {
    const { body } = await api("GET", "/api/bots?messages=0", undefined, as);
    return { bots: body.bots.map((bot: any) => bot.id).sort(), groups: body.groups.map((group: any) => group.id).sort(), sections: body.sections, raw: body };
  };
  const sorted = (...values: string[]) => [...values].sort();
  const only = (targets: { sections?: string[]; bots?: string[]; groups?: string[] }) => ({ sections: [], bots: [], groups: [], ...targets });

  function openStream(as: string, since?: string) {
    const controller = new AbortController();
    const frames: any[] = [];
    const state = { hello: false, ended: false, cursor: "", resumed: false };
    void (async () => {
      try {
        const res = await fetch(`${fixture.info.url}/api/events${since ? `?since=${encodeURIComponent(since)}` : ""}`, { headers: { origin: fixture.info.url, authorization: `Bearer ${tokens[as]}` }, signal: controller.signal });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const frame = JSON.parse(line.slice(6));
              if (frame.kind === "hello") Object.assign(state, { hello: true, cursor: frame.cursor, resumed: frame.resumed });
              else if (frame.kind !== "ping") frames.push(frame);
            }
          }
        }
      } catch {
      }
      state.ended = true;
    })();
    return { frames, state, close: () => controller.abort() };
  }

  beforeAll(async () => {
    fixture = await launchVerificationServer();
    for (const [key, name, section] of [["ops1", "Ops One", "Ops"], ["ops2", "Ops Two", "Ops"], ["hr", "Payroll", "People"]] as const) {
      const created = await api("POST", "/api/bots", { name, section });
      expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
      ids[key] = created.body.bot.id;
      threads[key] = created.body.bot.threadId;
    }
    for (const [key, name, members] of [["roomOps", "Ops standup", ["ops1", "ops2"]], ["roomMixed", "Pay questions", ["ops1", "hr"]]] as const) {
      const created = await api("POST", "/api/groups", { name, memberIds: members.map((member) => ids[member]) });
      expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
      ids[key] = created.body.group.id;
      threads[key] = created.body.group.threadId;
      expect((await api("PATCH", `/api/groups/${ids[key]}/setup`, { action: "skip" })).status).toBe(200);
    }
  }, 120_000);

  afterAll(async () => {
    if (!fixture) return;
    const evidencePath = `${fixture.info.logPath}.device-views.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, ids, requests: evidence }, null, 2));
    console.info(JSON.stringify({ ...fixture.info, evidencePath }));
    await fixture.close();
  });

  it("pairs a device with a view as a client only, and refuses a view that names nothing", async () => {
    expect((await api("POST", "/api/auth/pairing", { view: { bot: "nope" } })).status).toBe(400);
    expect((await api("POST", "/api/auth/pairing", { view: only({ sections: ["Finance"] }) })).status).toBe(400);
    expect((await api("POST", "/api/auth/pairing", { view: { group: ids.roomOps, bot: ids.ops1 } })).status).toBe(400);

    expect(await pair("ops-tablet", { section: "Ops" })).toMatchObject({ scopes: ["client"], view: only({ sections: ["Ops"] }) });
    expect(await pair("ops1-phone", { bot: ids.ops1 })).toMatchObject({ scopes: ["client"], view: only({ bots: [ids.ops1] }) });
    expect(await pair("room-screen", { group: ids.roomMixed })).toMatchObject({ scopes: ["client"], view: only({ groups: [ids.roomMixed] }) });
    expect((await pair("plain-phone")).view).toBeUndefined();

    const session = await api("GET", "/api/auth/session", undefined, "ops-tablet");
    expect(session.body).toMatchObject({ kind: "session", scopes: ["client"], view: only({ sections: ["Ops"] }) });
    expect((await api("GET", "/api/auth/sessions", undefined, "ops-tablet")).status).toBe(403);
    const listed = (await api("GET", "/api/auth/sessions")).body.sessions;
    expect(listed.find((row: any) => row.label === "room-screen").view).toEqual(only({ groups: [ids.roomMixed] }));
  });

  it("a department device lists and reaches that department only", async () => {
    const view = await seen("ops-tablet");
    expect(view.bots).toEqual(sorted(ids.ops1, ids.ops2));
    expect(view.groups).toEqual([ids.roomOps]);
    expect(view.sections).toEqual(["Ops"]);
    expect((await api("GET", `/api/threads/${threads.ops2}/messages`, undefined, "ops-tablet")).status).toBe(200);
    expect((await api("GET", `/api/threads/${threads.hr}/messages`, undefined, "ops-tablet")).status).toBe(404);
    expect((await api("GET", `/api/threads/${threads.roomMixed}/messages`, undefined, "ops-tablet")).status).toBe(404);
    expect((await api("POST", `/api/bots/${ids.hr}/messages`, { text: "hi", threadId: threads.hr }, "ops-tablet")).status).toBe(404);
  });

  it("a bot device lists and reaches that bot only", async () => {
    const view = await seen("ops1-phone");
    expect(view.bots).toEqual([ids.ops1]);
    expect(view.groups).toEqual([]);
    expect((await api("GET", `/api/threads/${threads.ops1}/messages`, undefined, "ops1-phone")).status).toBe(200);
    expect((await api("GET", `/api/threads/${threads.ops2}/messages`, undefined, "ops1-phone")).status).toBe(404);
    expect((await api("GET", `/api/threads/${threads.roomOps}/messages`, undefined, "ops1-phone")).status).toBe(404);
    expect((await api("PATCH", `/api/bots/${ids.ops2}`, { pinned: true }, "ops1-phone")).status).toBe(404);
    const call = await api("POST", "/api/live/session", { sdp: "v=0", client: "web", botId: ids.ops1 }, "ops1-phone");
    expect(call.status, "a Live call needs admin, which a limited device never has").toBe(403);
  });

  it("a group device sees the room and its bots as members, never their own chats", async () => {
    const view = await seen("room-screen");
    expect(view.groups).toEqual([ids.roomMixed]);
    expect(view.bots).toEqual(sorted(ids.ops1, ids.hr));
    for (const bot of view.raw.bots) {
      expect(bot.tasks).toEqual([]);
      expect(bot.threadId).toBeUndefined();
      expect(bot.messages).toEqual([]);
      expect(bot.roomOnly).toBe(true);
    }
    expect((await api("GET", `/api/threads/${threads.roomMixed}/messages`, undefined, "room-screen")).status).toBe(200);
    expect((await api("GET", `/api/threads/${threads.ops1}/messages`, undefined, "room-screen")).status).toBe(404);
    expect((await api("GET", `/api/threads/${threads.roomOps}/messages`, undefined, "room-screen")).status).toBe(404);
    expect((await api("POST", `/api/bots/${ids.ops1}/messages`, { text: "direct", threadId: threads.ops1 }, "room-screen")).status).toBe(404);
    expect((await api("POST", `/api/bots/${ids.ops1}/tasks`, { title: "side chat" }, "room-screen")).status).toBe(404);
    expect((await api("PATCH", `/api/bots/${ids.ops1}`, { pinned: true }, "room-screen")).status).toBe(404);
    expect(view.raw.computerControl, "a member bot's computer is its own").toEqual({});
    expect((await api("PUT", "/api/bots/order", { botIds: [ids.hr, ids.ops1] }, "room-screen")).status).toBe(400);
    expect((await api("POST", "/api/groups", { name: "Side room", memberIds: [ids.ops1] }, "room-screen")).status).toBe(400);
    expect((await api("POST", "/api/routines", { botId: ids.ops1, prompt: "x", schedule: { kind: "daily", time: "09:00" } }, "room-screen")).status).toBe(404);
    const posted = await api("POST", `/api/groups/${ids.roomMixed}/messages`, { text: "Hello room", threadId: threads.roomMixed }, "room-screen");
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
  });

  it("a group-limited device cannot see, change or run a member bot's own routine", async () => {
    const created = await api("POST", "/api/routines", {
      name: "Private check", prompt: "Private Ops routine", botId: ids.ops1, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const routineId = created.body.routine.id;
    const listed = await api("GET", "/api/routines", undefined, "room-screen");
    expect(JSON.stringify(listed.body)).not.toContain("Private Ops routine");
    expect((await api("PATCH", `/api/routines/${routineId}`, { prompt: "changed" }, "room-screen")).status).toBe(404);
    expect((await api("POST", `/api/routines/${routineId}/run`, undefined, "room-screen")).status).toBe(404);
    expect((await api("DELETE", `/api/routines/${routineId}`, undefined, "room-screen")).status).toBe(404);
    expect(JSON.stringify((await api("GET", "/api/team-map", undefined, "room-screen")).body)).not.toContain(ids.ops1);
    expect((await api("DELETE", `/api/routines/${routineId}`)).status).toBeLessThan(300);
  });

  it("a stream carries only what the device's view shows", async () => {
    const room = openStream("room-screen");
    const tablet = openStream("ops-tablet");
    await expect.poll(() => room.state.hello && tablet.state.hello, { timeout: 10_000 }).toBe(true);
    expect((await api("POST", `/api/bots/${ids.ops1}/messages`, { text: "Private Ops note", threadId: threads.ops1 })).status).toBe(202);
    await expect.poll(() => tablet.frames.some((frame) => frame.kind === "message" && frame.threadId === threads.ops1), { timeout: 15_000 }).toBe(true);
    expect((await api("POST", `/api/bots/${ids.hr}/messages`, { text: "Salary bands", threadId: threads.hr })).status).toBe(202);
    await expect.poll(async () => (await api("GET", `/api/threads/${threads.hr}/messages`)).body.messages.length, { timeout: 15_000 }).toBeGreaterThan(1);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.every((bot: any) => !bot.busy), { timeout: 20_000 }).toBe(true);
    const roomSeen = JSON.stringify(room.frames);
    expect(roomSeen).not.toContain(threads.ops1);
    expect(roomSeen).not.toContain("Private Ops note");
    expect(roomSeen).not.toContain(threads.hr);
    expect(roomSeen).not.toContain("Salary bands");
    expect(JSON.stringify(tablet.frames)).not.toContain(threads.hr);
    expect(JSON.stringify(tablet.frames)).not.toContain("Salary bands");
    room.close();
    tablet.close();
  }, 60_000);

  it("a bot added to the device's room arrives on its stream", async () => {
    const room = openStream("room-screen");
    await expect.poll(() => room.state.hello, { timeout: 10_000 }).toBe(true);
    expect((await api("PATCH", `/api/groups/${ids.roomMixed}`, { memberIds: [ids.ops1, ids.hr, ids.ops2] })).status).toBeLessThan(300);
    await expect.poll(() => room.state.ended, { timeout: 10_000 }).toBe(true);
    const back = openStream("room-screen", room.state.cursor);
    await expect.poll(() => back.state.hello, { timeout: 10_000 }).toBe(true);
    expect(back.state.resumed).toBe(false);
    expect((await seen("room-screen")).bots).toEqual(sorted(ids.ops1, ids.ops2, ids.hr));
    back.close();
    expect((await api("PATCH", `/api/groups/${ids.roomMixed}`, { memberIds: [ids.ops1, ids.hr] })).status).toBeLessThan(300);
  });

  it("an admin changes a paired device's view; its stream ends and it never gets admin back", async () => {
    const sessions = (await api("GET", "/api/auth/sessions")).body.sessions;
    const plain = sessions.find((row: any) => row.label === "plain-phone");
    expect(plain.scopes).toEqual(["admin", "client"]);
    const stream = openStream("plain-phone");
    await expect.poll(() => stream.state.hello, { timeout: 10_000 }).toBe(true);

    expect((await api("PATCH", `/api/auth/sessions/${plain.id}`, { view: { bot: "nope" } })).status).toBe(400);
    expect((await api("PATCH", `/api/auth/sessions/${plain.id}`, { view: { bot: ids.hr } }, "ops-tablet")).status).toBe(403);
    const changed = await api("PATCH", `/api/auth/sessions/${plain.id}`, { view: only({ bots: [ids.hr] }) });
    expect(changed.status).toBe(200);
    expect(changed.body.session).toMatchObject({ scopes: ["client"], view: only({ bots: [ids.hr] }) });
    await expect.poll(() => stream.state.ended, { timeout: 10_000 }).toBe(true);
    const back = openStream("plain-phone", stream.state.cursor);
    await expect.poll(() => back.state.hello, { timeout: 10_000 }).toBe(true);
    expect(back.state.resumed).toBe(false);
    back.close();
    expect((await seen("plain-phone")).bots).toEqual([ids.hr]);
    expect((await api("GET", "/api/auth/sessions", undefined, "plain-phone")).status).toBe(403);

    const cleared = await api("PATCH", `/api/auth/sessions/${plain.id}`, { view: null });
    expect(cleared.body.session.view).toBeUndefined();
    expect(cleared.body.session.scopes).toEqual(["client"]);
    const everyBot = (await api("GET", "/api/bots?messages=0")).body.bots.map((bot: any) => bot.id).sort();
    expect((await seen("plain-phone")).bots).toEqual(everyBot);
  });

  it("a device limited to several targets sees their union, and room members only as members", async () => {
    expect((await api("POST", "/api/auth/pairing", { view: { bots: [ids.ops2], groups: ["nope"] } })).status).toBe(400);
    expect((await api("POST", "/api/auth/pairing", { view: { sections: [], bots: [], groups: [] } })).status).toBe(400);
    await pair("front-desk", { bots: [ids.ops2], groups: [ids.roomMixed] });
    const view = await seen("front-desk");
    expect(view.bots).toEqual(sorted(ids.ops1, ids.ops2, ids.hr));
    expect(view.groups).toEqual([ids.roomMixed]);
    const listed = (await api("GET", "/api/bots?messages=0", undefined, "front-desk")).body.bots;
    expect(listed.find((bot: any) => bot.id === ids.ops2).threadId).toBe(threads.ops2);
    for (const member of [ids.ops1, ids.hr]) expect(listed.find((bot: any) => bot.id === member).threadId).toBeUndefined();
    expect((await api("GET", `/api/threads/${threads.ops2}/messages`, undefined, "front-desk")).status).toBe(200);
    expect((await api("GET", `/api/threads/${threads.roomMixed}/messages`, undefined, "front-desk")).status).toBe(200);
    expect((await api("GET", `/api/threads/${threads.ops1}/messages`, undefined, "front-desk")).status).toBe(404);
    expect((await api("GET", `/api/threads/${threads.roomOps}/messages`, undefined, "front-desk")).status).toBe(404);
    expect((await api("GET", `/api/threads/${threads.hr}/messages`, undefined, "front-desk")).status).toBe(404);
  });

  it("a deleted target leaves the device seeing nothing", async () => {
    const extra = await api("POST", "/api/bots", { name: "Temp" });
    await pair("temp-phone", { bot: extra.body.bot.id });
    expect((await seen("temp-phone")).bots).toEqual([extra.body.bot.id]);
    expect((await api("DELETE", `/api/bots/${extra.body.bot.id}`)).status).toBeLessThan(300);
    const after = await seen("temp-phone");
    expect(after.bots).toEqual([]);
    expect(after.groups).toEqual([]);
  });

  it("an admin turns every target off: the device stays limited and sees nothing", async () => {
    await pair("paused-phone", only({ bots: [ids.ops1] }));
    const row = (await api("GET", "/api/auth/sessions")).body.sessions.find((session: any) => session.label === "paused-phone");
    expect((await api("PATCH", `/api/auth/sessions/${row.id}`, { view: {} })).status).toBe(400);
    const paused = await api("PATCH", `/api/auth/sessions/${row.id}`, { view: only({}) });
    expect(paused.status).toBe(200);
    expect(paused.body.session).toMatchObject({ scopes: ["client"], view: only({}) });
    const after = await seen("paused-phone");
    expect(after.bots).toEqual([]);
    expect(after.groups).toEqual([]);
  });

  it("a department deleted and made again under its name grants a device nothing", async () => {
    expect((await api("POST", "/api/sidebar-sections", { name: "Contractors", botIds: [] })).status).toBeLessThan(300);
    await pair("contractor-tablet", { section: "Contractors" });
    expect((await api("DELETE", "/api/sidebar-sections?section=Contractors")).status).toBe(200);
    const row = (await api("GET", "/api/auth/sessions")).body.sessions.find((session: any) => session.label === "contractor-tablet");
    expect(row.view).toEqual(only({}));
    expect((await api("POST", "/api/sidebar-sections", { name: "Contractors", botIds: [ids.ops2] })).status).toBeLessThan(300);
    expect((await seen("contractor-tablet")).bots).toEqual([]);
    expect((await api("PUT", "/api/sidebar-sections?section=Ops", { addBotIds: [ids.ops2], removeBotIds: [] })).status).toBe(200);
    expect((await api("DELETE", "/api/sidebar-sections?section=Contractors")).status).toBe(200);
  });

  it("a device away while a bot left its department starts over rather than keep that bot", async () => {
    const tablet = openStream("ops-tablet");
    await expect.poll(() => tablet.state.hello, { timeout: 10_000 }).toBe(true);
    tablet.close();
    await expect.poll(() => tablet.state.ended, { timeout: 10_000 }).toBe(true);
    expect((await api("PATCH", `/api/bots/${ids.ops2}`, { section: "People" })).status).toBeLessThan(300);
    const back = openStream("ops-tablet", tablet.state.cursor);
    await expect.poll(() => back.state.hello, { timeout: 10_000 }).toBe(true);
    expect(back.state.resumed, "a replay cannot withdraw a bot the device already has").toBe(false);
    back.close();
    expect((await api("PATCH", `/api/bots/${ids.ops2}`, { section: "Ops" })).status).toBeLessThan(300);
  });
});
