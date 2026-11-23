import { describe, expect, it } from "vitest";
import { exchangeLines, exchangesOf, exchangeState, type JobNodeRead, type JobRead } from "./bot-exchanges";

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
        state: "needs-you", createdAt: 1_200 },
      { id: "a", asker: { botId: "maestro", name: "Maestro" }, helper: { botId: "pessoal", name: "Pessoal" }, threadId: "work",
        state: "answered", createdAt: 1_100, finishedAt: 1_900 },
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

});

describe("an exchange's lines in the helper's thread", () => {
  const asked = (id: string, at: number, exchange: string) => ({ id, role: "bot", at, roomRequest: { id: exchange, phase: "request" as const } });
  const said = (id: string, at: number, extra = {}) => ({ id, role: "bot", at, ...extra });
  // A was asked and answered; B, asked 300 ms after A's answer, ran next in the same thread.
  const thread = [said("old", 1_000), asked("a-ask", 2_000, "A"), said("a-reply", 9_700), asked("b-ask", 10_200, "B"), said("b-reply", 15_000)];
  const ids = (lines: ReturnType<typeof exchangeLines>) => lines.kind === "lines" ? [...lines.ids] : lines.kind;

  it("run from the hand-off's own request line to the next turn's start, whatever the clocks say", () => {
    expect(ids(exchangeLines(thread, { id: "A", state: "answered", finishedAt: 9_800 }))).toEqual(["a-ask", "a-reply"]);
    expect(ids(exchangeLines(thread, { id: "B", state: "working" }))).toEqual(["b-ask", "b-reply"]);
  });

  it("are none while the hand-off waits its turn behind another in the same thread", () => {
    const running = thread.slice(0, 3);
    expect(ids(exchangeLines(running, { id: "B", state: "asking" }))).toBe("waiting");
    expect(ids(exchangeLines(running, { id: "A", state: "working" }))).toEqual(["a-ask", "a-reply"]);
  });

  it("keep a message handed into the running turn, and stop at one that starts another", () => {
    const steered = { id: "aside", role: "user", at: 3_000, steered: true };
    const person = { id: "person", role: "user", at: 9_900 };
    expect(ids(exchangeLines([...thread.slice(0, 2), steered, said("a-reply", 9_700), person, said("p-reply", 9_950)], { id: "A", state: "working" })))
      .toEqual(["a-ask", "aside", "a-reply"]);
  });

  it("end when the hand-off ended", () => {
    expect(ids(exchangeLines([...thread.slice(0, 3), said("digest", 9_900)], { id: "A", state: "answered", finishedAt: 9_800 }))).toEqual(["a-ask", "a-reply"]);
  });

  it("are not guessed when the request line is not in the thread", () => {
    expect(ids(exchangeLines(thread, { id: "C", state: "answered", finishedAt: 20_000 }))).toBe("unknown");
  });
});
