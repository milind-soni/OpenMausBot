import { describe, expect, it } from "vitest";
import type { UsageRow } from "../usage-ledger.ts";
import { linkTurns, type TurnNode } from "./build.ts";

const AT = Date.UTC(2026, 9, 22, 9);
function row(id: string, parent?: string, offset = 0): UsageRow {
  return {
    at: new Date(AT + offset + 1).toISOString(), threadId: id, turnId: "turn", botId: id, botName: id,
    instanceId: "fixture", driverKind: "claude", model: "fixture", input: 100, cachedInput: 50, output: 20,
    costUsd: 0.1, trigger: { kind: "owner" }, startedAt: new Date(AT + offset).toISOString(),
    ...(parent === undefined ? {} : { parent: { threadId: parent, turnId: "turn" } }),
  };
}

function shape(roots: TurnNode[]) {
  const output: Array<[string, string[]]> = [];
  const pending = [...roots].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    output.push([node.threadId, node.children.map((child) => child.threadId)]);
    for (let index = node.children.length - 1; index >= 0; index--) pending.push(node.children[index]!);
  }
  return output;
}

describe("usage trace parent linking", () => {
  it.each([false, true])("does bounded parent work for a resumed-turn chain (reverse=%s)", (reverse) => {
    let reads = 0;
    const count = 2_000;
    const rows = Array.from({ length: count }, (_, index) => {
      const value = row(String(index), undefined, index);
      if (index) value.parent = Object.freeze({
        get threadId() { reads++; return String(index - 1); },
        get turnId() { reads++; return "turn"; },
      });
      return Object.freeze(value);
    });
    if (reverse) rows.reverse();
    const roots = linkTurns(rows, [], () => null);
    const parentReads = reads;
    expect(roots).toHaveLength(1);
    expect(shape(roots)).toEqual(Array.from({ length: count }, (_, index) => [String(index), index + 1 < count ? [String(index + 1)] : []]));
    expect(parentReads).toBeLessThanOrEqual(count * 6);
  });

  it("keeps cycle members and turns feeding a cycle as separate roots", () => {
    const roots = linkTurns([row("a", "b"), row("b", "a"), row("c", "b"), row("d", "c"), row("self", "self")], [], () => null);
    expect(shape(roots)).toEqual([["a", []], ["b", []], ["c", []], ["d", []], ["self", []]]);
  });

  it("links a child to a root whose named parent is outside the loaded period", () => {
    expect(shape(linkTurns([row("child", "root"), row("root", "outside")], [], () => null)))
      .toEqual([["root", ["child"]], ["child", []]]);
  });

  it("keeps root insertion order and stable chronological sibling order", () => {
    const roots = linkTurns([
      row("second-root"), row("late", "first-root", 50), row("tie-a", "first-root", 10),
      row("first-root"), row("early", "first-root", 0), row("tie-b", "first-root", 10),
    ], [], () => null);
    expect(shape(roots)).toEqual([
      ["second-root", []], ["first-root", ["early", "tie-a", "tie-b", "late"]],
      ["early", []], ["tie-a", []], ["tie-b", []], ["late", []],
    ]);
  });

  it("uses both thread and turn identifiers when linking live and booked nodes", () => {
    const roots = linkTurns([row("same")], [{
      threadId: "same", turnId: "resumed", provider: "claude", startedAt: AT + 100,
      parent: { threadId: "same", turnId: "turn" }, spans: [],
    }], () => null);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.key).toBe("same:turn");
    expect(roots[0]!.children.map((child) => child.key)).toEqual(["same:resumed"]);
  });

  it("merges booked rows before linking and does not duplicate a matching live turn", () => {
    const first = row("child", "root");
    const roots = linkTurns([row("root"), first, { ...first, at: new Date(AT + 2).toISOString() }], [{
      threadId: "child", turnId: "turn", provider: "claude", startedAt: AT, spans: [],
    }], () => null);
    expect(shape(roots)).toEqual([["root", ["child"]], ["child", []]]);
    expect(roots[0]!.children[0]!.tokens).toEqual({ input: 200, cachedInput: 100, output: 40 });
    expect(roots[0]!.children[0]!.costUsd).toBe(0.2);
  });

  it("handles an empty period and an acyclic branch next to a cycle", () => {
    expect(linkTurns([], [], () => null)).toEqual([]);
    expect(shape(linkTurns([row("a", "b"), row("b", "a"), row("leaf", "root"), row("root")], [], () => null)))
      .toEqual([["a", []], ["b", []], ["root", ["leaf"]], ["leaf", []]]);
  });
});
