// Where the person is comes from where the turn came from, never from asking them: a send one of the owner's phones made
// is the phone's, the person at the computer works the usual way, and a run nobody typed is unattended. Shared servers
// and other people's sessions get no phone.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CloudLendingTurn } from "../cloud-lending.ts";
import { PHONE_PLACE_PROMPT } from "../phones/instructions.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import type { BotRecord } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createPhones, type PhonesDeps } from "./phones.ts";

const THREAD = "thread-1";
const TURN = { botId: "chief", threadId: THREAD, generation: "gen-1" };
const PHONE_SESSION = { id: "phone-session", label: "Omkar's iPhone" } as SessionRecord;
const DESK_SESSION = { id: "desk-session", label: "Laptop" } as SessionRecord;
const session = (record: SessionRecord): RequestAuth => ({ kind: "session", session: record, via: "bearer", scopes: ["admin", "client"] });
const loopback: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const chief = { id: "chief", name: "MausBot", color: "teal", chiefOfStaff: true } as BotRecord;

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

function world(overrides: Partial<PhonesDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-phones-host-"));
  dirs.push(dir);
  // The owner's iPhone, paired as a session, allowing Calendar.
  writeFileSync(join(dir, "phones.json"), JSON.stringify({ version: 1, phones: [{
    key: `session:${PHONE_SESSION.id}`, owner: "owner", registeredAt: 1, seen: Date.now(), lastUsedAt: null,
    registration: { installId: "install-0001", name: "Omkar's iPhone", platform: "ios", appVersion: "1.6.0", timeZone: "Asia/Kolkata", capabilities: { calendar: "full" } },
  }] }));
  const lines: Array<{ id: string; role: string; sendId?: string; sender?: { id: string } }> = [];
  const requests = new Map<string, { messageId?: string; automation?: unknown; origin?: { kind: string } }>();
  const phones = createPhones({
    dataDir: dir, shared: false, cloudHome: false, cloudOwnerKey: null, loopbackTrust: "owner", sharedMembership: () => false,
    store: { messagesFor: () => lines, bot: () => chief, groupByThread: () => undefined, appendMessage: () => {} } as unknown as PhonesDeps["store"],
    sessions: { list: () => [], isLive: () => true, onSessionRevoked: () => () => {} }, routines: () => null, ownerOrAdmin: (auth) => auth.scopes.includes("admin"), cloudOwnerSession: () => false,
    cloudLendingRefusal: () => null,
    cloudLendingTurn: () => ({ thread: lines, request: { ...requests.get(THREAD), generations: new Set([TURN.generation]) }, generation: TURN.generation, starters: [], reportsFromOthers: false,
      ownerPerson: () => true, cardAnswerer: () => undefined, routineRun: () => null }) as unknown as CloudLendingTurn,
    originIsUser: () => true, request: (threadId) => requests.get(threadId), nudge: () => {}, mint: () => "turn-token",
    harnessUrl: "http://127.0.0.1:1", active: () => true,
    ...overrides,
  });
  /** A person's line in the thread and the direct request it starts. */
  const send = (sendId: string, request: { automation?: unknown; origin?: { kind: string } } = { origin: { kind: "user" } }, sender?: string) => {
    const id = `line-${lines.length + 1}`;
    lines.push({ id, role: "user", sendId, ...(sender ? { sender: { id: sender } } : {}) });
    requests.set(THREAD, { messageId: id, ...request });
  };
  return { phones, send };
}

describe("where the person is", () => {
  it("a send from the owner's phone is the phone's; the same words typed at the computer stay at the computer", () => {
    const { phones, send } = world();
    // The phone's send: its id was noted when the phone made it.
    send(phones.sendIdFor(session(PHONE_SESSION)));
    expect(phones.place(THREAD, true)).toBe("phone");
    // At the computer (this machine, or a paired laptop that is no phone): the usual way, never the phone's place.
    send(phones.sendIdFor(loopback));
    expect(phones.place(THREAD, true)).toBe("computer");
    send(phones.sendIdFor(session(DESK_SESSION)));
    expect(phones.place(THREAD, true)).toBe("computer");
    // A send id the computer chose itself is not the phone's, though a phone made one before.
    send("desk-send-000000000001");
    expect(phones.place(THREAD, true)).toBe("computer");
    phones.noteSend("phone-send-00000000001");
    send("phone-send-00000000001");
    expect(phones.place(THREAD, true)).toBe("phone");
  });

  it("a turn nobody typed is unattended, whatever line it answers", () => {
    const { phones, send } = world();
    send("desk-send-000000000002", { automation: { routineId: "r1" }, origin: { kind: "user" } });
    expect(phones.place(THREAD, true)).toBe("unattended");
    send("desk-send-000000000003", { origin: { kind: "outside" } });
    expect(phones.place(THREAD, true)).toBe("unattended");
    send("desk-send-000000000004");
    expect(phones.place(THREAD, false)).toBe("unattended");
    expect(phones.place("no-such-thread", true)).toBe("unattended");
  });

  it("a mounted turn is told where the person is, and no place asks them to choose", () => {
    const { phones, send } = world();
    send(phones.sendIdFor(loopback));
    for (const place of ["phone", "computer", "unattended"] as const) {
      const [device, where] = phones.promptParts(chief, { mounted: true, offered: true, turn: TURN, place });
      expect(device).toMatchObject({ id: "device", label: "Phone", text: expect.stringContaining("Omkar's iPhone is an iPhone; this bot may use: Calendar.") });
      expect(where).toEqual({ id: "device-place", label: "Where the person is", text: PHONE_PLACE_PROMPT[place] });
    }
    for (const text of Object.values(PHONE_PLACE_PROMPT)) {
      expect(text).not.toMatch(/here or on (their|your) phone|ask (once|them|the person|whether)|\?/iu);
    }
    expect(PHONE_PLACE_PROMPT.computer).toContain("only when they name the phone; otherwise do it here.");
    expect(PHONE_PLACE_PROMPT.phone).toContain("do it on the phone with the PHONE tools");
    // Unmounted: why the owner's phone is not here, and no place at all.
    expect(phones.promptParts(chief, { mounted: false, offered: true, turn: TURN, place: "phone" })).toEqual([
      { id: "device", label: "Phone", text: expect.stringContaining("Paired: Omkar's iPhone.") },
    ]);
    expect(phones.promptParts(chief, { mounted: false, offered: false, turn: TURN, place: "phone" })).toEqual([{ id: "device", label: "Phone", text: "" }]);
  });
});

describe("whose phones", () => {
  it("only the owner's own requests and turns reach the desktop owner's phones", () => {
    const { phones, send } = world();
    expect(phones.fromPhone(session(PHONE_SESSION))).toBe(true);
    expect(phones.fromPhone(session(DESK_SESSION))).toBe(false);
    expect(phones.fromPhone(loopback)).toBe(false);
    // No request this turn can prove: no phone.
    expect(phones.turnOwner(TURN)).toBeNull();
    send(phones.sendIdFor(loopback));
    expect(phones.turnOwner(TURN)).toBe("owner");
    expect(phones.integration(chief, TURN)).toMatchObject({ env: { OMB_MCP_TOKEN_DEVICE: "turn-token", OMB_HARNESS_URL: "http://127.0.0.1:1" } });
    // A line from a person who holds no admin session here is not the owner's, nor is anything after it.
    send("guest-send-0000000001", { origin: { kind: "user" } }, "p_guest");
    expect(phones.turnOwner(TURN)).toBeNull();
    expect(phones.integration(chief, TURN)).toBeNull();
  });

  it("a Team Cloud or hosted workspace, a server several people sign in to, and a service-trust machine get no phone", () => {
    for (const overrides of [{ shared: true }, { sharedMembership: () => true }, { loopbackTrust: "service" as const }]) {
      const { phones, send } = world(overrides);
      send(phones.sendIdFor(loopback));
      expect(phones.fromPhone(session(PHONE_SESSION))).toBe(true);
      expect(phones.turnOwner(TURN)).toBeNull();
      expect(phones.integration(chief, TURN)).toBeNull();
      expect(phones.previewParts(chief, true)).toEqual([]);
      expect(phones.promptParts(chief, { mounted: false, offered: true, turn: TURN, place: "computer" })).toEqual([{ id: "device", label: "Phone", text: "" }]);
    }
  });

  it("on a Cloud home only the owner's session holds a phone, and only a turn the lent Mac would allow reaches it", () => {
    let refusal: string | null = null;
    const { phones } = world({ cloudHome: true, cloudOwnerKey: "owner", cloudOwnerSession: (auth) => auth.kind === "session" && auth.session.id === PHONE_SESSION.id, cloudLendingRefusal: () => refusal });
    expect(phones.turnOwner(TURN)).toBe("owner");
    refusal = "someone-else";
    expect(phones.turnOwner(TURN)).toBeNull();
    expect(phones.integration(chief, TURN)).toBeNull();
  });
});
