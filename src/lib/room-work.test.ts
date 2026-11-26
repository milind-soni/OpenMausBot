import { describe, expect, it } from "vitest";
import type { BoardItem } from "../../shared/board";
import { workStatus } from "./room-work";

const item = (extra: Partial<BoardItem>): BoardItem => ({
  threadId: "t1", groupId: "g1", title: "Draft the post", state: "ready", needs: [], labels: {}, attempts: 0,
  createdBy: { kind: "bot", id: "lead", name: "Lead" }, createdAt: 1, updatedAt: 1, ...extra,
});
const names: Record<string, string> = { writer: "Writer" };
const status = (extra: Partial<BoardItem>, viewer: string | null = "p_me") => workStatus(item(extra), viewer, (id) => names[id]);

describe("a work thread's one status", () => {
  it("is Up next while it waits for a bot or for what it needs", () => {
    expect(status({ state: "ready" })).toEqual({ kind: "next", label: "Up next" });
    expect(status({ state: "waiting", needs: ["t0"] })).toEqual({ kind: "next", label: "Up next" });
  });

  it("names the bot working on it", () => {
    expect(status({ state: "working", holder: { botId: "writer", since: 1 } })).toEqual({ kind: "working", label: "Writer working" });
    expect(status({ state: "working", holder: { botId: "gone", since: 1 } })).toEqual({ kind: "working", label: "In progress" });
  });

  it("needs you when you were asked, or nobody in particular was; else names whom it needs", () => {
    const asked = { text: "Which date?", askedAt: 1 };
    expect(status({ state: "needs_person", question: { ...asked, person: "p_me", name: "Me" } })).toEqual({ kind: "needs", label: "Needs you" });
    expect(status({ state: "needs_person", question: asked })).toEqual({ kind: "needs", label: "Needs you" });
    expect(status({ state: "needs_person", question: { ...asked, person: "p_mira", name: "Mira" } })).toEqual({ kind: "needs", label: "Needs Mira", someoneElse: true });
    expect(status({ state: "needs_person", question: { ...asked, person: "p_mira" } }), "an item asked before names were kept").toEqual({ kind: "needs", label: "Needs an answer", someoneElse: true });
    expect(status({ state: "needs_person", question: { ...asked, person: "p_me" } }, null), "before the viewer is known").toEqual({ kind: "needs", label: "Needs an answer", someoneElse: true });
  });

  it("is Done or Stopped once settled, and nothing once cancelled or with no item", () => {
    expect(status({ state: "done", result: "Posted." })).toEqual({ kind: "done", label: "Done" });
    expect(status({ state: "failed" })).toEqual({ kind: "stopped", label: "Stopped" });
    expect(status({ state: "cancelled" })).toBeNull();
    expect(workStatus(undefined, "p_me", () => undefined)).toBeNull();
  });
});
