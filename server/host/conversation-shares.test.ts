import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { personKey } from "../person-key.ts";
import { createConversationShares, shareKey } from "./conversation-shares.ts";
import { teamMemoryLine, TEAM_MEMORY_TEXT_MAX } from "./team-memory-saves.ts";

const rui = personKey({ id: "", email: "rui@acme.test" });
const marta = personKey({ id: "", email: "marta@acme.test" });
const ana = personKey({ id: "", email: "ana@acme.test" });
let dir = "";

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "team-share-shares-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("conversation shares", () => {
  it("gives a conversation shared with one person an audience of its own that names no person, read by those two", () => {
    const shares = createConversationShares({ dataDir: dir, team: true });
    shares.share("t1", rui, marta, 100);
    expect(shares.audienceOf("t1")).toBe(`member:${shareKey("t1")}`);
    expect(shareKey("t1")).not.toBe(rui);
    expect(shares.readers("t1")).toEqual([rui, marta]);
    expect(shares.isShareKey(shareKey("t1"))).toBe(true);
    expect(shares.isShareKey(rui)).toBe(false);
    expect(shares.audienceOf("t2"), "never shared").toBeNull();
    shares.share("t1", rui, "team", 200);
    expect(shares.audienceOf("t1")).toBe("team");
    expect(shares.readers("t1")).toBeNull();
    expect(createConversationShares({ dataDir: dir, team: true }).audienceOf("t1"), "kept across a restart").toBe("team");
  });

  it("is nothing off a team", () => {
    createConversationShares({ dataDir: dir, team: true }).share("t1", rui, marta);
    const off = createConversationShares({ dataDir: dir, team: false });
    expect(off.audienceOf("t1")).toBeNull();
    expect(off.readers("t1")).toBeNull();
  });

  it("keeps what was said before a share with its owner, and what was said while shared with one person with those two", () => {
    const shares = createConversationShares({ dataDir: dir, team: true });
    shares.share("t1", rui, marta, 100);
    expect(shares.reaches({ threadId: "t1", at: 50 }, marta)).toBe(false);
    expect(shares.reaches({ threadId: "t1", at: 50 }, rui)).toBe(true);
    expect(shares.reaches({ threadId: "t1", at: 150 }, marta)).toBe(true);
    shares.share("t1", rui, "team", 200);
    expect(shares.reaches({ threadId: "t1", at: 150 }, marta)).toBe(true);
    expect(shares.reaches({ threadId: "t1", at: 150 }, ana)).toBe(false);
    expect(shares.reaches({ threadId: "t1", at: 50 }, marta)).toBe(false);
    expect(shares.reaches({ threadId: "t1", at: 250 }, ana)).toBe(true);
  });

  it("dissolves a share with one person when either leaves, into the other's own; the team's stays", () => {
    const shares = createConversationShares({ dataDir: dir, team: true });
    shares.share("handed", rui, marta);
    shares.share("received", ana, rui);
    shares.share("team", rui, "team");
    expect(shares.personLeft(rui)).toEqual([{ threadId: "handed", to: marta }, { threadId: "received", to: ana }]);
    expect(shares.audienceOf("handed")).toBeNull();
    expect(shares.audienceOf("team")).toBe("team");
  });

  it("marks each person's copy: shared, and who the other reader is", () => {
    const shares = createConversationShares({ dataDir: dir, team: true });
    shares.share("t1", rui, marta);
    const names = (key: string) => (key === rui ? "Rui" : "Marta");
    expect(shares.forViewer({ threadId: "t1" }, rui, names)).toEqual({ threadId: "t1", shared: true, sharedWith: { name: "Marta", byYou: true } });
    expect(shares.forViewer({ threadId: "t1" }, marta, names)).toEqual({ threadId: "t1", shared: true, sharedWith: { name: "Rui" } });
    expect(shares.forViewer({ threadId: "t9" }, rui, names)).toEqual({ threadId: "t9" });
  });
});

describe("a team memory line", () => {
  it("says who saved it and when", () => {
    expect(teamMemoryLine("  We ship\non 3 March ", "Rui", Date.UTC(2026, 10, 11))).toBe("We ship on 3 March (saved by Rui, 2026-11-11)");
  });

  it("keeps one note's worth of a long message, cut at a word, and says it was shortened", () => {
    const line = teamMemoryLine(Array.from({ length: 400 }, () => "word").join(" "), "Rui", Date.UTC(2026, 10, 11));
    expect(line).toMatch(/^word( word)*… \(shortened; saved by Rui, 2026-11-11\)$/);
    expect(line.length).toBeLessThanOrEqual(TEAM_MEMORY_TEXT_MAX + 50);
  });
});
