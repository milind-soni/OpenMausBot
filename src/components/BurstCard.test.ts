import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BurstCardData } from "../../shared/burst";

vi.mock("@/state/store", () => ({ api: vi.fn(), openThread: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));

const { BurstCard, BurstRows } = await import("./BurstCard");

const card = (over: Partial<BurstCardData> = {}): BurstCardData => ({
  version: 1, burstId: "b1", botId: "bot", task: "Research these companies", phase: "preview", total: 20, requested: 20, parallel: 10, modelName: "Fast 1",
  estimateMinutes: 6, counts: { queued: 20, running: 0, done: 0, failed: 0, cancelled: 0 }, sample: ["Acme", "Globex"], ...over,
});
const render = (data: BurstCardData) => renderToStaticMarkup(createElement(BurstCard, { card: data }));

describe("BurstCard preview", () => {
  it("offers Run, Edit and Cancel, with the plan and a sample of the tasks", () => {
    const markup = render(card());
    expect(markup).toContain("Burst: Research these companies");
    expect(markup).toContain("20 tasks");
    expect(markup).toContain("10 at once");
    expect(markup).toContain("about 6 min");
    expect(markup).toContain("Acme · Globex");
    expect(markup).toContain("+18 more");
    for (const label of ["Run", "Edit", "Cancel"]) expect(markup).toContain(`>${label}</button>`);
    expect(markup).not.toContain("Retry failed");
  });

  it("says plainly what a small plan's task limit does, without a wall", () => {
    const markup = render(card({ total: 10, requested: 20, taskLimit: 10, smallPlan: true, parallel: 2 }));
    expect(markup).toContain("10 of the 20 tasks will run");
    expect(markup).toContain("Pro runs more at once.");
    expect(markup).toContain(">Run</button>");
  });

  it("names the limit without the upsell on a larger plan", () => {
    const markup = render(card({ total: 200, requested: 300, taskLimit: 200 }));
    expect(markup).toContain("200 of the 300 tasks will run");
    expect(markup).not.toContain("Pro runs more");
  });
});

describe("BurstCard progress", () => {
  it("shows counts with Retry failed and Cancel all while it runs", () => {
    const markup = render(card({ phase: "running", counts: { queued: 7, running: 10, done: 2, failed: 1, cancelled: 0 } }));
    expect(markup).toContain("2 of 20 done");
    expect(markup).toContain("10 running");
    expect(markup).toContain("7 waiting");
    expect(markup).toContain("1 failed");
    expect(markup).toContain(">Retry failed</button>");
    expect(markup).toContain(">Cancel all</button>");
    expect(markup).not.toContain(">Run</button>");
  });

  it("names what did not finish once it settles, and keeps only Retry failed", () => {
    const markup = render(card({ phase: "done", counts: { queued: 0, running: 0, done: 19, failed: 1, cancelled: 0 }, failed: [{ title: "Globex", reason: "It ran out of memory." }] }));
    expect(markup).toContain("19 of 20 done");
    expect(markup).toContain("Not finished: Globex");
    expect(markup).toContain(">Retry failed</button>");
    expect(markup).not.toContain(">Cancel all</button>");
  });

  it("says when it was cancelled, with nothing left to press but the tasks", () => {
    const markup = render(card({ phase: "cancelled", counts: { queued: 0, running: 0, done: 3, failed: 0, cancelled: 17 } }));
    expect(markup).toContain("Cancelled");
    expect(markup).not.toContain("Retry failed");
    expect(markup).not.toContain("Cancel all");
  });

  it("collapses the parts, and a part that started opens its own thread", () => {
    expect(render(card({ phase: "running" }))).toContain("Show tasks");
    const markup = renderToStaticMarkup(createElement(BurstRows, { botId: "bot", rows: [
      { seq: 0, title: "Acme", status: "done", threadId: "t1" },
      { seq: 1, title: "Globex", status: "queued" },
    ] }));
    expect(markup).toContain("Acme");
    expect(markup.match(/<button/g)).toHaveLength(1);
  });
});
