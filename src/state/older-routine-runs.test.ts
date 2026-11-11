// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RoutineRun } from "@/lib/routines";
import { useRoutineRunsFrom, useThreadRoutineRun } from "./older-routine-runs";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  dispatch: vi.fn(),
  state: { routineRunsSince: 1_000 as number | null, routineRuns: [] as unknown[], bots: [] as unknown[] },
}));
vi.mock("./store", () => ({ api: fixture.api, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));

const settle = () => new Promise((resolve) => setTimeout(resolve));
const mount = (hook: () => void) => {
  const root = createRoot(document.createElement("div"));
  flushSync(() => root.render(createElement(() => { hook(); return null; })));
  return root;
};
const run = { id: "old", target: "bot", botId: "b", threadId: "t", scheduledFor: 10 } as RoutineRun;

describe("older routine runs on demand", () => {
  beforeEach(() => {
    fixture.api.mockReset().mockResolvedValue({ runs: [run] });
    fixture.dispatch.mockReset();
    fixture.state = { routineRunsSince: 1_000, routineRuns: [], bots: [] };
  });

  it("a view loads the dates before the app's window, once", async () => {
    mount(() => useRoutineRunsFrom(400));
    await settle();
    expect(fixture.api.mock.calls).toEqual([["/api/routines?from=400&to=1000"]]);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "routineRunsLoaded", runs: [run], from: 400, to: 1_000 });
  });

  it.each([["inside the window", 1_000, 2_000], ["when every run is loaded", null, 400]])("a view asks for nothing %s", async (_name, since, start) => {
    fixture.state.routineRunsSince = since;
    mount(() => useRoutineRunsFrom(start));
    await settle();
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("a chat of an old run loads that run; any other chat asks for nothing", async () => {
    fixture.state.bots = [{ id: "b", tasks: [{ threadId: "t", routineRunId: "old" }, { threadId: "plain" }] }];
    mount(() => useThreadRoutineRun("b", "plain"));
    await settle();
    expect(fixture.api).not.toHaveBeenCalled();
    mount(() => useThreadRoutineRun("b", "t"));
    await settle();
    expect(fixture.api.mock.calls).toEqual([["/api/routines?thread=t"]]);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "routineRunsLoaded", runs: [run] });
  });
});
