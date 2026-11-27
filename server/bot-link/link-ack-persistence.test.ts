import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BotLink, BotLinkDeps, LinkState } from "./link.ts";
import type { Frame } from "./protocol.ts";

vi.mock("node:fs", { spy: true });
vi.resetModules();
const spied = await import("node:fs");
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const { createBotLink } = await import("./link.ts");

const PEER = "fixture-peer";
const OTHER = "other-peer";
const AT = 1_700_000_000_000;
const ACK_AT = AT + 100;
const fixtures: Array<{ directory: string; links: BotLink[] }> = [];
const done = (index: number): Frame => ({ t: "done", id: `work-${index}` });
const hello = (): Frame => ({ t: "hello", place: { id: "computer", name: "Updated computer" }, bots: [] });

function fixture(count: number, options: Partial<BotLinkDeps> = {}, change?: (state: LinkState) => void) {
  const directory = mkdtempSync(join(tmpdir(), "omb-link-acks-"));
  const file = join(directory, "bot-link.json");
  const state: LinkState = {
    v: 2, role: "acceptor", self: { id: "cloud", name: "Cloud" },
    peers: {
      [PEER]: { place: { id: "computer", name: "Computer" }, bots: [], seenAt: AT, sessionId: "fixture-session" },
      [OTHER]: { place: { id: "other", name: "Other" }, bots: [], seenAt: AT, sessionId: "other-session" },
    },
    threads: {},
    work: Object.fromEntries(Array.from({ length: count }, (_, index) => [`work-${index}`, {
      peer: PEER, root: `link-work-${index}`, from: "Writer", at: AT, done: { ok: true, text: "Completed report" },
    }])),
  };
  change?.(state);
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  const deps: BotLinkDeps = {
    dataDir: directory,
    coordinator: () => { throw new Error("acknowledgments do not run coordinator work"); },
    bots: () => [], bot: () => undefined, level: () => "full", openThread: () => undefined,
    hasThread: () => false, personName: () => undefined, sentRow: () => {}, resultRow: () => {},
    kick: () => {}, now: () => ACK_AT, ...options,
  };
  const link = createBotLink(deps);
  const links = [link];
  fixtures.push({ directory, links });
  vi.mocked(spied.writeFileSync).mockClear();
  return {
    link, directory,
    read: () => JSON.parse(readFileSync(file, "utf8")) as LinkState,
    reopen: () => { const reopened = createBotLink(deps); links.push(reopened); return reopened; },
  };
}

beforeEach(() => {
  vi.mocked(spied.fsyncSync).mockReset().mockImplementation(actualFs.fsyncSync);
  vi.mocked(spied.renameSync).mockReset().mockImplementation(actualFs.renameSync);
});

afterEach(() => {
  vi.mocked(spied.fsyncSync).mockReset().mockImplementation(actualFs.fsyncSync);
  vi.mocked(spied.renameSync).mockReset().mockImplementation(actualFs.renameSync);
  for (const { directory, links } of fixtures.splice(0)) {
    for (const link of links) link.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("completed-result acknowledgment persistence", () => {
  it.each([1, 100, 500])("durably saves %i acknowledgments once before returning and does not replay them after reload", (count) => {
    const { link, read, reopen, directory } = fixture(count);

    link.receive(PEER, Array.from({ length: count }, (_, index) => done(index)));

    expect(spied.writeFileSync).toHaveBeenCalledTimes(1);
    expect(spied.fsyncSync).toHaveBeenCalledTimes(1);
    expect(spied.renameSync).toHaveBeenCalledTimes(1);
    expect(Object.values(read().work).map((work) => work.ackedAt)).toEqual(Array(count).fill(ACK_AT));
    expect(readdirSync(directory)).toEqual(["bot-link.json"]);
    link.close();
    const reloaded = reopen();
    reloaded.sessionStarted(PEER);
    expect(reloaded.outgoing(PEER, 0).filter(({ frame }) => frame.t === "result")).toEqual([]);
  });

  it("does not save empty batches or acknowledgments that do not change completed work", () => {
    const { link, read } = fixture(3, {}, (state) => {
      state.work["work-0"]!.ackedAt = AT;
      state.work["work-1"]!.peer = OTHER;
      delete state.work["work-2"]!.done;
    });
    const before = read();

    link.receive(PEER, []);
    link.receive(PEER, [done(0), done(1), done(2), done(99)]);

    expect(spied.writeFileSync).not.toHaveBeenCalled();
    expect(spied.fsyncSync).not.toHaveBeenCalled();
    expect(read()).toEqual(before);
  });

  it("keeps the first timestamp per result and evaluates the clock for each new acknowledgment", () => {
    const now = vi.fn().mockReturnValueOnce(ACK_AT).mockReturnValueOnce(ACK_AT + 1);
    const { link, read } = fixture(2, { now });

    link.receive(PEER, [done(0), done(0), done(1), done(1)]);
    link.receive(PEER, [done(0), done(1)]);

    expect(now).toHaveBeenCalledTimes(2);
    expect(read().work["work-0"]!.ackedAt).toBe(ACK_AT);
    expect(read().work["work-1"]!.ackedAt).toBe(ACK_AT + 1);
    expect(spied.fsyncSync).toHaveBeenCalledTimes(1);
  });

  it("persists each acknowledgment segment before a directory change can observe it", () => {
    const changed = vi.fn();
    const { link, read } = fixture(4, { directoryChanged: changed });
    const observed: LinkState[] = [];
    changed.mockImplementation(() => { observed.push(read()); });

    link.receive(PEER, [done(0), done(1), hello(), done(2), done(3)]);

    expect(changed).toHaveBeenCalledTimes(1);
    expect(observed[0]!.peers[PEER]!.place.name).toBe("Updated computer");
    expect(Object.values(observed[0]!.work).map((work) => work.ackedAt)).toEqual([ACK_AT, ACK_AT, undefined, undefined]);
    expect(Object.values(read().work).map((work) => work.ackedAt)).toEqual(Array(4).fill(ACK_AT));
    expect(spied.fsyncSync).toHaveBeenCalledTimes(3);
  });

  it("persists preceding acknowledgments before reporting an invalid frame", () => {
    const log = vi.fn();
    const { link, read } = fixture(2, { log });
    const observed: LinkState[] = [];
    log.mockImplementation(() => { observed.push(read()); });

    link.receive(PEER, [done(0), { t: "unsupported" }, done(1)]);

    expect(log).toHaveBeenCalledExactlyOnceWith("bot link: a frame that did not parse was dropped");
    expect(observed[0]!.work["work-0"]!.ackedAt).toBe(ACK_AT);
    expect(observed[0]!.work["work-1"]!.ackedAt).toBeUndefined();
    expect(read().work["work-1"]!.ackedAt).toBe(ACK_AT);
    expect(spied.fsyncSync).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing one-attempt and logged-error behavior for a single failed acknowledgment", () => {
    const log = vi.fn();
    const { link, read, directory } = fixture(1, { log });
    const error = Object.assign(new Error("fixture disk unavailable"), { code: "EIO" });
    vi.mocked(spied.fsyncSync).mockImplementationOnce(() => { throw error; });

    expect(() => link.receive(PEER, [done(0), done(0)])).not.toThrow();

    expect(spied.fsyncSync).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith(`bot link: done failed (${String(error)})`);
    expect(read().work["work-0"]!.ackedAt).toBeUndefined();
    expect(readdirSync(directory)).toEqual(["bot-link.json"]);
    link.receive(PEER, [done(0)]);
    expect(spied.fsyncSync).toHaveBeenCalledTimes(1);
    link.receive(PEER, [hello()]);
    expect(read().work["work-0"]!.ackedAt).toBe(ACK_AT);
  });

  it("uses the remaining new acknowledgment's write opportunity after a transient fsync failure", () => {
    const log = vi.fn();
    const { link, read } = fixture(2, { log });
    vi.mocked(spied.fsyncSync).mockImplementationOnce(() => { throw new Error("fixture transient fsync"); });

    link.receive(PEER, [done(0), done(1)]);

    expect(spied.fsyncSync).toHaveBeenCalledTimes(2);
    expect(spied.renameSync).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith("bot link: done failed (Error: fixture transient fsync)");
    expect(Object.values(read().work).map((work) => work.ackedAt)).toEqual([ACK_AT, ACK_AT]);
  });

  it("bounds persistent-failure attempts by changed work, excluding duplicate and ignored acknowledgments", () => {
    const log = vi.fn();
    const { link, read, directory } = fixture(4, { log }, (state) => {
      state.work["work-2"]!.peer = OTHER;
      delete state.work["work-3"]!.done;
    });
    vi.mocked(spied.fsyncSync).mockImplementation(() => { throw new Error("fixture persistent fsync"); });

    expect(() => link.receive(PEER, [done(0), done(0), done(1), done(1), done(2), done(3), done(99)])).not.toThrow();

    expect(spied.fsyncSync).toHaveBeenCalledTimes(2);
    expect(log.mock.calls).toEqual(Array.from({ length: 2 }, () => ["bot link: done failed (Error: fixture persistent fsync)"]));
    expect(Object.values(read().work).every((work) => work.ackedAt === undefined)).toBe(true);
    expect(readdirSync(directory)).toEqual(["bot-link.json"]);
    vi.mocked(spied.fsyncSync).mockImplementation(actualFs.fsyncSync);
    link.receive(PEER, [hello()]);
    expect(Object.values(read().work).map((work) => work.ackedAt)).toEqual([ACK_AT, ACK_AT, undefined, undefined]);
  });

  it("keeps replacement failure atomic and uses a later acknowledgment's write opportunity", () => {
    const log = vi.fn();
    const { link, read, directory } = fixture(2, { log });
    vi.mocked(spied.renameSync).mockImplementationOnce(() => { throw Object.assign(new Error("fixture rename failed"), { code: "EIO" }); });

    link.receive(PEER, [done(0), done(1)]);

    expect(spied.fsyncSync).toHaveBeenCalledTimes(2);
    expect(spied.renameSync).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledExactlyOnceWith("bot link: done failed (Error: fixture rename failed)");
    expect(Object.values(read().work).map((work) => work.ackedAt)).toEqual([ACK_AT, ACK_AT]);
    expect(readdirSync(directory)).toEqual(["bot-link.json"]);
  });

  it("keeps a nested receive's persistence separate from the surrounding segments", () => {
    const changed = vi.fn();
    const { link, read } = fixture(4, { directoryChanged: changed });
    const observed: LinkState[] = [];
    changed.mockImplementation(() => {
      observed.push(read());
      link.receive(PEER, [done(1), done(2)]);
      observed.push(read());
    });

    link.receive(PEER, [done(0), hello(), done(3)]);

    expect(Object.values(observed[0]!.work).map((work) => work.ackedAt)).toEqual([ACK_AT, undefined, undefined, undefined]);
    expect(Object.values(observed[1]!.work).map((work) => work.ackedAt)).toEqual([ACK_AT, ACK_AT, ACK_AT, undefined]);
    expect(Object.values(read().work).map((work) => work.ackedAt)).toEqual(Array(4).fill(ACK_AT));
    expect(spied.fsyncSync).toHaveBeenCalledTimes(4);
  });

  it("persists preceding acknowledgments even when inspecting a later input throws", () => {
    const { link, read } = fixture(1);
    const error = new Error("fixture frame getter failed");
    const frame = { get t() { throw error; } };

    expect(() => link.receive(PEER, [done(0), frame])).toThrow(error);

    expect(read().work["work-0"]!.ackedAt).toBe(ACK_AT);
    expect(spied.fsyncSync).toHaveBeenCalledTimes(1);
  });
});
