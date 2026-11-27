import { describe, expect, it } from "vitest";

import { isStatusOnly, mayBeStatusOnly, statusReplyPrompt } from "./status-reply.ts";
import type { Assignment } from "./types.ts";

const root: Assignment = {
  id: "gen-1", rootId: "gen-1", depth: 0,
  origin: { kind: "person", source: "chat", ref: "chief-chat" },
  requester: { kind: "person", threadId: "chief-chat" },
  assignee: { botId: "chief", destination: { kind: "standing_thread", threadId: "chief-chat" } },
  mode: "work", reply: "resume", brief: "Tell the builder", status: "waiting", level: "ask", levelSource: "own",
  executions: 1, restarts: 0, createdAt: 1_000, lastActivityAt: 2_000, result: "", rework: false, version: 1,
};
const child: Assignment = {
  ...root, id: "as-1", parentId: "gen-1", depth: 1, brief: "FYI: the mailbox moved.", status: "running",
  requester: { kind: "bot_turn", botId: "chief", threadId: "chief-chat" },
  assignee: { botId: "builder", destination: { kind: "work_thread", threadId: "builder-work" } },
};

describe("which replies are asked about", () => {
  it("a short reply to plain work under a person's or a bot's turn", () => {
    expect(mayBeStatusOnly(child, root, "Noted.", undefined)).toBe(true);
    expect(mayBeStatusOnly(child, { ...root, requester: { kind: "bot_turn", botId: "lead", threadId: "lead-work" } }, "Noted.", undefined)).toBe(true);
  });

  it("never one under a routine's run or an outside runtime, which take their turn anyway", () => {
    expect(mayBeStatusOnly(child, { ...root, requester: { kind: "routine_run", runId: "run-1", botId: "chief", threadId: "chief-chat" } }, "Noted.", undefined)).toBe(false);
    expect(mayBeStatusOnly(child, { ...root, requester: { kind: "external_runtime", runId: "run-1" }, reply: "poll" }, "Noted.", undefined)).toBe(false);
  });

  it("never a question, a done_when, work that used a tool, an empty or a long reply, or a reply deeper in the tree", () => {
    expect(mayBeStatusOnly({ ...child, mode: "consult" }, root, "Noted.", undefined)).toBe(false);
    expect(mayBeStatusOnly({ ...child, doneWhen: "the mailbox works" }, root, "Noted.", undefined)).toBe(false);
    expect(mayBeStatusOnly(child, root, "Noted.", { toolCalls: 1 })).toBe(false);
    expect(mayBeStatusOnly(child, root, "  ", undefined)).toBe(false);
    expect(mayBeStatusOnly(child, root, "x".repeat(601), undefined)).toBe(false);
    expect(mayBeStatusOnly(child, { ...root, parentId: "above" }, "Noted.", undefined)).toBe(false);
  });

  it("reads a plain ACK as status only, and anything else as needing the requester", () => {
    expect(isStatusOnly(" ack ")).toBe(true);
    for (const answer of ["NEEDS", "ACK, nothing needed", "", undefined]) expect(isStatusOnly(answer)).toBe(false);
    expect(statusReplyPrompt("FYI", "Noted.")).toContain("<teammate_reply>\nNoted.\n</teammate_reply>");
  });
});
