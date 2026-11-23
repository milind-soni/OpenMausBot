import { describe, expect, it } from "vitest";
import { exchangesOf, exchangeState, exchangeWindow, inWindow, type JobNodeRead, type JobRead } from "./bot-exchanges";

const node = (id: string, extra: Partial<JobNodeRead> = {}): JobNodeRead => ({
  id, botId: "maestro", botName: "Maestro", threadId: "chat", status: "running", reply: "required", createdAt: 1_000, ...extra,
});
const job = (nodes: JobNodeRead[], needsInput: string[] = []): JobRead =>
  ({ since: 0, version: "v1", nodes, needsInput: needsInput.map((id) => ({ id })) });

describe("an exchange's state", () => {
  it.each([
    [{ status: "queued" }, false, "asking"],
    [{ status: "running" }, false, "working"],
    [{ status: "waiting" }, false, "working"],
    [{ status: "resume" }, false, "working"],
    [{ status: "needs_input" }, false, "needs-you"],
    [{ status: "running" }, true, "needs-you"],
    [{ status: "completed", outcome: "done" }, false, "answered"],
    [{ status: "cancelled", outcome: "stopped" }, false, "stopped"],
    [{ status: "failed", outcome: "expired" }, false, "expired"],
    [{ status: "cancelled", outcome: "expired" }, false, "expired"],
    [{ status: "failed", outcome: "error" }, false, "failed"],
    [{ status: "cancelled" }, false, "failed"],
  ] as const)("%o (asking the person: %s) is %s", (record, needsYou, state) => {
    expect(exchangeState(record, needsYou)).toBe(state);
  });
});

describe("the exchanges in a job", () => {
  const root = node("root");
  it("are hand-offs from one bot to another, with the asker taken from the parent, open ones first", () => {
    const done = node("a", { parentId: "root", botId: "pessoal", botName: "Pessoal", threadId: "work", status: "completed", createdAt: 1_100, finishedAt: 1_900 });
    const deeper = node("b", { parentId: "a", botId: "research", botName: "Research", threadId: "work-2", createdAt: 1_200 });
    expect(exchangesOf(job([root, done, deeper], ["b"]), "A teammate")).toEqual([
      { id: "b", asker: { botId: "pessoal", name: "Pessoal" }, helper: { botId: "research", name: "Research" }, threadId: "work-2",
        state: "needs-you", live: true, createdAt: 1_200 },
      { id: "a", asker: { botId: "maestro", name: "Maestro" }, helper: { botId: "pessoal", name: "Pessoal" }, threadId: "work",
        state: "answered", live: false, createdAt: 1_100, finishedAt: 1_900 },
    ]);
  });

  it("leave out a bot's thread on itself, room work and the conversation's own turn", () => {
    const own = node("self", { parentId: "root", threadId: "side" });
    const room = node("room", { parentId: "root", botId: "pessoal", groupId: "g1" });
    expect(exchangesOf(job([root, own, room]), "A teammate")).toEqual([]);
  });

  it("name the asker a teammate when its row is hidden from the reader", () => {
    const [entry] = exchangesOf(job([node("a", { parentId: "unseen", botId: "pessoal", botName: "Pessoal" })]), "A teammate");
    expect(entry!.asker).toEqual({ name: "A teammate" });
  });

  it("do not keep the line alive for a notice that waits for no answer", () => {
    const [entry] = exchangesOf(job([root, node("n", { parentId: "root", botId: "pessoal", reply: "none" })]), "A teammate");
    expect(entry).toMatchObject({ state: "working", live: false });
  });
});

describe("an exchange's lines in the helper's thread", () => {
  it("start just before the hand-off and end when it ended", () => {
    const window = exchangeWindow({ createdAt: 10_000, finishedAt: 20_000 });
    expect([8_999, 9_000, 15_000, 20_000, 20_001].map((at) => inWindow(at, window))).toEqual([false, true, true, true, false]);
  });

  it("run on while it is open", () => {
    expect(inWindow(90_000, exchangeWindow({ createdAt: 10_000 }))).toBe(true);
  });
});
