import { describe, expect, it } from "vitest";

import { writeMemoryDoc, threadNotesPath } from "./memory-store.ts";
import { reachThreads } from "./thread-notes.ts";
import { ensureWorkspace } from "./workspace.ts";

let nextBot = 0;
function fixture(titles: string[], notes: string[] = []) {
  const botId = `short-search-${process.pid}-${nextBot++}`;
  ensureWorkspace(botId, "en");
  const threads = titles.map((title, index) => ({ threadId: `matter-${index}`, title }));
  notes.forEach((text, index) => writeMemoryDoc(botId, threadNotesPath(threads[index]!.threadId), text));
  return (query?: string) => reachThreads({ botId, current: "here", threads, query, messages: () => [] });
}

describe("short terms in conversation search", () => {
  it("uses a single digit to distinguish otherwise identical matter names", () => {
    const search = fixture(["Contract 7", "Contract 8"]);
    expect(search("Contract 7")).toMatchObject({ total: 1, threads: [{ threadId: "matter-0" }] });
    expect(search("Contract 9")).toEqual({ total: 0, threads: [] });
  });

  it("matches a single-character surname without returning every conversation", () => {
    const search = fixture(["李先生的租约", "张先生的租约"]);
    expect(search("李")).toMatchObject({ total: 1, threads: [{ threadId: "matter-0" }] });
    expect(search("王")).toEqual({ total: 0, threads: [] });
  });

  it("applies every term when the identifying number occurs only in notes", () => {
    const search = fixture(["Acme NDA", "Other NDA"], ["Agreed clause 7", "Agreed clause 8"]);
    expect(search("clause 7")).toMatchObject({ total: 1, threads: [{ threadId: "matter-0" }] });
  });

  it("retains the unfiltered listing for an omitted or blank query", () => {
    const search = fixture(["Contract A", "Contract B"]);
    expect(search()).toMatchObject({ total: 2 });
    expect(search(" ")).toMatchObject({ total: 2 });
  });
});
