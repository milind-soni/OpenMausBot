import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { WAIT_KINDS } from "../../shared/waits.ts";
import type { NewWait, WaitRecord } from "../waits.ts";
import { createWaitRoutes, findWaitPeer, hostWaitRefusal, isNetworkPath, parseWaitRequest, waitSourceRefusal, WAIT_MESSAGES } from "./waits.ts";
import { PASS } from "./table.ts";

const HOME = "/home/maus";
const FILE_WAIT = { label: "the report", kind: "file_exists", path: "/r.txt" };

const waits = {
  create: vi.fn(async (input: NewWait) => ({ state: "created", wait: { id: "w1", label: input.label, expiresAt: 0 } }) as never),
  list: vi.fn((_botId: string): WaitRecord[] => []),
  cancel: vi.fn((_id: string, _botId: string): WaitRecord | null => null),
};

const readBody = vi.fn(async (): Promise<unknown> => undefined);

async function call(method: string, path: string, body?: unknown, overrides: Partial<Parameters<ReturnType<typeof createWaitRoutes>>[0]> = {}, cloudHome = false, sleeps = cloudHome) {
  const route = createWaitRoutes({ waits, home: () => HOME, cloudHome, sleeps });
  const json = vi.fn();
  const outcome = await route({
    method, path, res: {} as never, json, botId: "bot-1", threadId: "thread-1", readBody: async () => { readBody(); return body; },
    sourceRefusal: () => null, hostRefusal: () => null, guest: () => false, peer: () => null, ...overrides,
  });
  const [, status, payload] = json.mock.calls[0] ?? [];
  return { outcome, status: status as number | undefined, payload: payload as { text?: string; error?: string } };
}

describe("the waits route", () => {
  it("passes requests that are not its own", async () => {
    expect((await call("GET", "/api/internal/triggers")).outcome).toBe(PASS);
    expect((await call("DELETE", "/api/internal/waits")).outcome).toBe(PASS);
  });
  it("makes a wait for the capability's bot and chat, never ids from the body", async () => {
    waits.create.mockClear();
    const { status, payload } = await call("POST", "/api/internal/waits", { label: "the report", kind: "file_exists", path: "~/r.txt", botId: "evil", threadId: "evil" });
    expect(waits.create).toHaveBeenCalledWith({ botId: "bot-1", threadId: "thread-1", label: "the report", condition: { kind: "file_exists", path: join(HOME, "r.txt") }, hours: 24 });
    expect([status, payload.text]).toEqual([201, expect.stringContaining("(wait id w1)")]);
  });
  it("carries follow_up as followUp and says so in the answer", async () => {
    waits.create.mockClear();
    const { payload } = await call("POST", "/api/internal/waits", { ...FILE_WAIT, follow_up: "  tell me the size ", hours: 2 });
    expect(waits.create).toHaveBeenCalledWith(expect.objectContaining({ followUp: "tell me the size", hours: 2 }));
    expect(payload.text).toContain("you will then do what you wrote in follow_up");
    expect(payload.text).toContain("plain checks, no AI, until 1970-01-01T00:00:00.000Z");
  });
  it("says on a Cloud home that a sleeping My Cloud wakes to check every 30 minutes, and that the follow-up reports in its own results chat", async () => {
    const here = (await call("POST", "/api/internal/waits", { ...FILE_WAIT, follow_up: "Deploy it." })).payload.text!;
    expect(here).toContain("lands in this chat, and you will then do what you wrote in follow_up. Tell the person");
    expect(here).not.toContain("My Cloud");
    const cloud = (await call("POST", "/api/internal/waits", { ...FILE_WAIT, follow_up: "Deploy it." }, {}, true)).payload.text!;
    expect(cloud).toContain("lands in this chat, and you will then do what you wrote in follow_up in a run that reports in its own results chat, not this one.");
    expect(cloud).toContain(" While My Cloud sleeps it wakes to check every 30 minutes, so the message can come up to 30 minutes late: tell the person that too. Tell the person in one sentence;");
    expect((await call("POST", "/api/internal/waits", FILE_WAIT, {}, true)).payload.text).toContain("lands in this chat. While My Cloud sleeps it wakes to check every 30 minutes");
  });
  it("never says a Team Cloud sleeps: its plan never does", async () => {
    const team = (await call("POST", "/api/internal/waits", { ...FILE_WAIT, follow_up: "Deploy it." }, {}, true, false)).payload.text!;
    expect(team).toContain("in a run that reports in its own results chat, not this one.");
    expect(team).not.toContain("sleeps");
  });
  it("answers 200 for a condition already true and the manager's status for a refusal, and appends a note", async () => {
    waits.create.mockResolvedValueOnce({ state: "already", text: "It exists already." } as never);
    expect(await call("POST", "/api/internal/waits", FILE_WAIT)).toMatchObject({ status: 200, payload: { text: "It exists already." } });
    waits.create.mockResolvedValueOnce({ state: "refused", status: 409, error: "Too many." } as never);
    expect(await call("POST", "/api/internal/waits", FILE_WAIT)).toMatchObject({ status: 409, payload: { error: "Too many." } });
    waits.create.mockResolvedValueOnce({ state: "created", wait: { id: "w2", label: "l", expiresAt: 0 }, note: "Slow page." } as never);
    expect((await call("POST", "/api/internal/waits", FILE_WAIT)).payload.text).toMatch(/\n\nSlow page\.$/);
  });
  it("refuses a turn the person did not start in their own chat, for making and for stopping", async () => {
    waits.create.mockClear(); waits.cancel.mockClear(); readBody.mockClear();
    for (const [path, body] of [["/api/internal/waits", FILE_WAIT], ["/api/internal/waits/cancel", { id: "w1" }]] as const) {
      expect(await call("POST", path, body, { sourceRefusal: () => WAIT_MESSAGES.notPerson })).toMatchObject({ status: 403, payload: { error: WAIT_MESSAGES.notPerson } });
    }
    expect(waits.create).not.toHaveBeenCalled();
    expect(waits.cancel).not.toHaveBeenCalled();
    expect(readBody).not.toHaveBeenCalled();
  });
  it("refuses a Cloud guest's follow-up, since it would run as the owner's, and still makes a guest's wait that only tells", async () => {
    waits.create.mockClear();
    const guest = { guest: () => true };
    const page = { label: "the price drops", kind: "url_contains", url: "https://x.test/", text: "sale" };
    expect(await call("POST", "/api/internal/waits", { ...page, follow_up: "Buy it." }, guest)).toMatchObject({ status: 403, payload: { error: WAIT_MESSAGES.guestFollowUp } });
    expect(waits.create).not.toHaveBeenCalled();
    expect(await call("POST", "/api/internal/waits", page, guest)).toMatchObject({ status: 201 });
    expect(waits.create).toHaveBeenCalledWith(expect.not.objectContaining({ followUp: expect.anything() }));
    expect(await call("POST", "/api/internal/waits", { ...page, follow_up: "Buy it." })).toMatchObject({ status: 201 });
  });
  it("refuses file and program waits away from the bot's own computer, and allows pages and bots there", async () => {
    const away = { hostRefusal: () => WAIT_MESSAGES.otherComputer, peer: () => ({ id: "b2", name: "Coder" }) };
    expect(await call("POST", "/api/internal/waits", FILE_WAIT, away)).toMatchObject({ status: 403, payload: { error: WAIT_MESSAGES.otherComputer } });
    expect(await call("POST", "/api/internal/waits", { label: "l", kind: "process_gone", process: "make" }, away)).toMatchObject({ status: 403 });
    expect(await call("POST", "/api/internal/waits", { label: "l", kind: "url_contains", url: "https://x.test/", text: "ok" }, away)).toMatchObject({ status: 201 });
    expect(await call("POST", "/api/internal/waits", { label: "l", kind: "bot_idle", bot: "coder" }, away)).toMatchObject({ status: 201 });
  });
  it.each([
    [{ label: "", kind: "file_exists", path: "/r" }, "label: the person's words for what you wait for, up to 120 characters."],
    [{ label: "l", kind: "file_seen", path: "/r" }, `kind is one of: ${WAIT_KINDS.join(", ")}.`],
    [{ label: "l", kind: "url_contains", url: "https://x.test/" }, "url_contains needs url and text."],
    [{ label: "l", kind: "file_exists", path: "/r", text: "x" }, "text applies only to url_contains and url_missing."],
    [{ label: "l", kind: "url_missing", url: "ftp://x.test/", text: "x" }, "url must be an http or https address."],
    [{ label: "l", kind: "url_missing", url: "https://u:p@x.test/", text: "x" }, "Put no sign-in details in the address."],
    [{ label: "l", kind: "url_contains", url: "https://x.test/", text: "" }, "text must be 1 to 500 characters."],
    [{ label: "l", kind: "url_missing", url: "https://x.test/", text: "   " }, "text must be 1 to 500 characters."],
    [{ label: "l", kind: "file_exists", path: "build/out.txt" }, "path must be a full path or start with ~."],
    [{ label: "l", kind: "file_exists", path: "/r", hours: 169 }, "hours is a whole number from 1 to 168."],
    [{ label: "l", kind: "file_exists", path: "/r", hours: 0 }, "hours is a whole number from 1 to 168."],
    [{ label: "l", kind: "file_exists", path: "/r", follow_up: "   " }, "follow_up must be 1 to 2000 characters."],
    [{ label: "l", kind: "bot_idle", bot: "x", path: "/r" }, "path applies only to file_exists, file_missing and file_changed."],
  ])("refuses %j", async (body, error) => {
    waits.create.mockClear();
    expect(await call("POST", "/api/internal/waits", body)).toMatchObject({ status: 400, payload: { error } });
    expect(waits.create).not.toHaveBeenCalled();
  });
  it("refuses a network path with either slash, mixed or percent-encoded, before anything checks it", async () => {
    waits.create.mockClear();
    const error = "path must be on this computer: a network path (\\\\server\\share or //server/share) is never checked.";
    for (const path of ["\\\\host\\share\\x", "//host/share/x", "\\/host/share", "/\\host\\share", "\\\\?\\UNC\\host\\share\\x", " \\\\host\\share", "%5C%5Chost%5Cshare", "%2f%2fhost/share", "/%2Fhost/share", "%255C%255Chost"]) {
      expect(await call("POST", "/api/internal/waits", { ...FILE_WAIT, path }), path).toMatchObject({ status: 400, payload: { error } });
    }
    expect(waits.create).not.toHaveBeenCalled();
    for (const path of ["/srv/share/x", "~/a//b", "C:\\Users\\maus\\r.txt", "/a/%2F/b"]) expect(isNetworkPath(path), path).toBe(false);
  });
  it("treats null as absent and a body that is not an object as an error", async () => {
    expect(parseWaitRequest({ ...FILE_WAIT, text: null, hours: null }, HOME)).toMatchObject({ ok: true, request: { hours: 24 } });
    expect(parseWaitRequest("nope", HOME)).toEqual({ ok: false, error: "Send a JSON object." });
  });
  it("finds the other bot by name or id among the bots it may reach, never itself", async () => {
    const peers = [{ id: "b2", name: "Coder" }, { id: "b3", name: "Hidden", hidden: true }, { id: "bot-1", name: "Pepper" }];
    expect(findWaitPeer(peers, "bot-1", "coder")).toEqual({ id: "b2", name: "Coder" });
    expect(findWaitPeer(peers, "bot-1", "b2")).toEqual({ id: "b2", name: "Coder" });
    expect([findWaitPeer(peers, "bot-1", "Hidden"), findWaitPeer(peers, "bot-1", "pepper")]).toEqual([null, "self"]);
    expect(await call("POST", "/api/internal/waits", { label: "l", kind: "bot_idle", bot: "nobody" }, { peer: () => null })).toMatchObject({ status: 400, payload: { error: WAIT_MESSAGES.noPeer } });
    expect(await call("POST", "/api/internal/waits", { label: "l", kind: "bot_idle", bot: "me" }, { peer: () => "self" })).toMatchObject({ status: 400, payload: { error: WAIT_MESSAGES.self } });
  });
  it("for a bot that lives in another of the person's places, says where instead; with no word on that, that bots work as one place", async () => {
    const lives = "Ledger lives on Garage server, not here.";
    expect(await call("POST", "/api/internal/waits", { label: "l", kind: "bot_idle", bot: "Ledger" }, { peer: () => null, elsewhere: () => ({ where: lives }) }))
      .toMatchObject({ status: 400, payload: { error: lives } });
    expect(await call("POST", "/api/internal/waits", { label: "l", kind: "bot_idle", bot: "Ledger" }, { peer: () => null, elsewhere: () => ({ hint: "Bots work together only within one place." }) }))
      .toMatchObject({ status: 400, payload: { error: `${WAIT_MESSAGES.noPeer} Bots work together only within one place.` } });
    expect(await call("POST", "/api/internal/waits", { label: "l", kind: "bot_idle", bot: "Ledger" }, { peer: () => null, elsewhere: () => null }))
      .toMatchObject({ status: 400, payload: { error: WAIT_MESSAGES.noPeer } });
  });
  it("waits for the found bot by id and name", async () => {
    waits.create.mockClear();
    await call("POST", "/api/internal/waits", { label: "l", kind: "bot_idle", bot: "coder" }, { peer: () => ({ id: "b2", name: "Coder" }) });
    expect(waits.create).toHaveBeenCalledWith(expect.objectContaining({ condition: { kind: "bot_idle", botId: "b2", botName: "Coder" } }));
  });
  it("lets a bot cancel only waits made in this chat and lists only those", async () => {
    waits.cancel.mockClear(); waits.list.mockClear();
    const mine = { id: "w1", label: "the build", threadId: "thread-1", condition: { kind: "process_gone", process: "make" }, createdAt: 0, expiresAt: 0 } as WaitRecord;
    const elsewhere = { ...mine, id: "w9", label: "other chat", threadId: "thread-A" } as WaitRecord;
    waits.list.mockReturnValue([mine, elsewhere]);
    expect(await call("POST", "/api/internal/waits/cancel", { id: "w9" })).toMatchObject({ status: 404, payload: { error: "None of your waits in this chat has that id. Use list_waits." } });
    expect(waits.cancel).not.toHaveBeenCalled();
    waits.cancel.mockReturnValueOnce(mine);
    expect(await call("POST", "/api/internal/waits/cancel", { id: "w1" })).toMatchObject({ status: 200, payload: { text: "Stopped waiting for the build." } });
    expect(waits.cancel.mock.calls).toEqual([["w1", "bot-1"]]);
    const listed = (await call("GET", "/api/internal/waits")).payload.text;
    expect(listed).toContain("w1 · the build");
    expect(listed).not.toContain("w9");
    expect(waits.list).toHaveBeenCalledWith("bot-1");
    expect(await call("GET", "/api/internal/waits", undefined, { threadId: "thread-B" })).toMatchObject({ status: 200, payload: { text: "You are not waiting for anything in this chat." } });
    expect(await call("POST", "/api/internal/waits/cancel", { id: "w1" }, { threadId: "thread-B" }))
      .toMatchObject({ status: 404, payload: { error: "You are not waiting for anything in this chat, so there is nothing to cancel." } });
    waits.list.mockReturnValue([]);
  });
  it("keeps a turn that is not the person's conversation from listing", async () => {
    expect(await call("GET", "/api/internal/waits", undefined, { sourceRefusal: () => WAIT_MESSAGES.notYours })).toMatchObject({ status: 403, payload: { error: WAIT_MESSAGES.notYours } });
  });
  it("keeps the address as the URL parser normalises it and the label to one line", async () => {
    waits.create.mockClear();
    await call("POST", "/api/internal/waits", { label: "l", kind: "url_contains", url: "https://X.test", text: "ok" });
    expect(waits.create).toHaveBeenCalledWith(expect.objectContaining({ condition: { kind: "url_contains", url: "https://x.test/", text: "ok" } }));
    expect(await call("POST", "/api/internal/waits", { ...FILE_WAIT, label: "a\nb" })).toMatchObject({ status: 400, payload: { error: "label must be a single line of plain text." } });
  });
  it("lets only a person's own one-to-one turn make a wait", () => {
    const person = { owned: true, room: false, depth: 0, handedOff: false, routineRun: false, outsideDriven: false, personStarted: true, guest: false };
    expect(waitSourceRefusal(person)).toBeNull();
    expect(waitSourceRefusal({ ...person, personStarted: false, guest: true })).toBeNull();
    expect(waitSourceRefusal({ ...person, owned: false })).toBe(WAIT_MESSAGES.notYours);
    expect(waitSourceRefusal({ ...person, room: true })).toBe(WAIT_MESSAGES.room);
    for (const other of [{ depth: 1 }, { handedOff: true }, { routineRun: true }, { outsideDriven: true }, { personStarted: false }]) {
      expect(waitSourceRefusal({ ...person, ...other }), JSON.stringify(other)).toBe(WAIT_MESSAGES.notPerson);
    }
  });
  it("offers files and programs only on the bot's own computer", () => {
    const own = { cloudHome: false, hosted: false, guest: false, place: null };
    for (const place of [null, "local", "browser"] as const) expect(hostWaitRefusal({ ...own, place })).toBeNull();
    for (const place of ["vm", "cloud"] as const) expect(hostWaitRefusal({ ...own, place })).toBe(WAIT_MESSAGES.otherComputer);
    expect([hostWaitRefusal({ ...own, cloudHome: true }), hostWaitRefusal({ ...own, hosted: true }), hostWaitRefusal({ ...own, guest: true })])
      .toEqual([WAIT_MESSAGES.serverHost, WAIT_MESSAGES.serverHost, WAIT_MESSAGES.guest]);
  });
});
