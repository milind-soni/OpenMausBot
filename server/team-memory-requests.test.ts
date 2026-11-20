import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DecisionRow } from "./decision-log.ts";
import { TeamMemory } from "./team-memory.ts";
import { createTeamMemoryRequests } from "./team-memory-requests.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import type { OptionCardData } from "../shared/wire.ts";

type Row = { id: string; card?: OptionCardData; from?: { botId: string } };

let dir: string;
let memory: TeamMemory;
let rows: Row[];
let decisions: Array<Omit<DecisionRow, "at">>;
let requests: ReturnType<typeof createTeamMemoryRequests>;
const scout = { id: "b1", name: "Scout", color: "#000", section: "" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-team-memory-requests-"));
  memory = new TeamMemory(join(dir, "team-memory.json"));
  rows = [];
  decisions = [];
  requests = createTeamMemoryRequests({
    teamMemory: memory,
    store: {
      messagesFor: () => rows,
      appendMessage: (_threadId, message) => {
        const row = { id: `m${rows.length + 1}`, card: message.card, ...(message.from ? { from: { botId: message.from.botId } } : {}) };
        rows.push(row);
        return row;
      },
      patchMessage: (_threadId, messageId, patch) => {
        rows = rows.map((row) => (row.id === messageId ? { ...row, card: patch.card } : row));
      },
      bot: (id) => (id === scout.id ? scout : null),
      botByThread: () => scout,
    },
    sectionKey: (section) => section ?? "",
    language: () => undefined,
    decide: (row) => decisions.push(row),
  });
});

afterEach(async () => {
  await removeTempDir(dir);
});

const accepted = () => memory.list("").filter((entry) => entry.status === "accepted").map((entry) => entry.name);
const card = (requestId: string) => rows.find((row) => row.card?.requestId === requestId)!.card!;

function save(name: string, detail: string) {
  const saved = requests.submit(scout, "t1", false, { kind: "term", name, detail }, "level");
  expect(saved.status).toBe(201);
  return saved;
}

describe("forget", () => {
  it("removes the entry at once with an Undo that brings it back", () => {
    save("OKR", "The quarter's goals.");
    const forgotten = requests.forget(scout, "t1", false, { kind: "term", name: "okr" }, "Saved in the wrong team.", "level");
    expect(forgotten).toMatchObject({ status: 201, body: { status: "applied", state: "applied" } });
    expect(accepted()).toEqual([]);
    const requestId = String(forgotten.body.requestId);
    expect(card(requestId)).toMatchObject({
      title: "Forgotten for the team", subtitle: "Term: OKR — The quarter's goals. · Why: Saved in the wrong team.",
      answered: "allow", autoApplied: true, options: [], tool: "propose_team_memory", teamMemoryRequest: { forget: true },
    });
    expect(decisions.at(-1)).toMatchObject({ requestId, decision: "auto-approved", source: "level" });
    expect(requests.undo("t1", requestId)).toEqual({ claimed: true, state: "undone" });
    expect(accepted()).toEqual(["OKR"]);
    expect(card(requestId).undone).toBe(true);
    expect(requests.undo("t1", requestId)).toEqual({ claimed: true, state: "already_undone" });
  });

  it("waits for the owner's card when the change may not apply on its own, and Keep changes nothing", () => {
    save("OKR", "The quarter's goals.");
    const kept = requests.forget(scout, "t1", false, { kind: "term", name: "OKR" }, "", null);
    expect(kept.body).toMatchObject({ status: "proposed", state: "pending" });
    const keptId = String(kept.body.requestId);
    expect(card(keptId)).toMatchObject({ title: "Forget this for the team?", subtitle: "Term: OKR — The quarter's goals.", options: ["Forget", "Keep"] });
    expect(card(keptId).autoApplied).toBeUndefined();
    expect(accepted()).toEqual(["OKR"]);
    expect(requests.resolve("t1", keptId, "deny")).toEqual({ ok: true, outcome: "rejected" });
    expect(accepted()).toEqual(["OKR"]);

    const removed = requests.forget(scout, "t1", false, { kind: "term", name: "OKR" }, "", null);
    const removedId = String(removed.body.requestId);
    expect(requests.resolve("t1", removedId, "allow")).toEqual({ ok: true, outcome: "allowed-once" });
    expect(accepted()).toEqual([]);
    expect(card(removedId).answered).toBe("allow");
    expect(requests.resolve("t1", removedId, "allow")).toEqual({ ok: true, outcome: "allowed-once", alreadySettled: true });
    expect(decisions.filter((row) => row.source === "user").map((row) => row.decision)).toEqual(["user-denied", "user-approved"]);
  });

  it("does not remove an entry that changed after the owner's card was shown", () => {
    save("OKR", "first");
    const pending = requests.forget(scout, "t1", false, { kind: "term", name: "OKR" }, "", null);
    save("OKR", "second");
    expect(requests.resolve("t1", String(pending.body.requestId), "allow")).toEqual({ ok: true, outcome: "unavailable" });
    expect(memory.list("").map((entry) => entry.detail)).toEqual(["second"]);
  });

  it("removes nothing when no accepted entry matches, and says how to find one", () => {
    save("OKR", "The quarter's goals.");
    const missing = requests.forget(scout, "t1", false, { key: "term:kpi" }, "", "level");
    expect(missing.status).toBe(404);
    expect(String(missing.body.error)).toContain('No accepted team memory entry has the key "term:kpi", so nothing was removed. Find it with session_search scope=team');
    expect(String(missing.body.error)).toContain('{"action":"forget","kind":"term","name":"OKR","detail":"Saved in the wrong team."}');
    expect(requests.forget({ ...scout, section: "Other team" }, "t1", false, { kind: "term", name: "OKR" }, "", "level").status).toBe(404);
    expect(accepted()).toEqual(["OKR"]);
  });
});
