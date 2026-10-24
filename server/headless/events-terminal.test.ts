import { expect, it, vi } from "vitest";
import { eventsVerb } from "./events.ts";
import type { VerbContext } from "./context.ts";

it.each([["blocked", 3], ["cancelled", 130]])("events --until-settled stops on %s without opening another stream", async (state, exitCode) => {
  const json = vi.fn().mockResolvedValue({ state, since: 1000, reason: "Explicit terminal result", nodes: [], counts: {} });
  const raw = vi.fn().mockRejectedValue(Object.assign(new Error("No stream should be opened"), { status: 403 }));
  const out = vi.fn();
  const ctx = { flags: { job: "t1", "until-settled": true }, signal: new AbortController().signal,
    client: async () => ({ json, raw }), io: { out }, output: { progress: vi.fn() } } as unknown as VerbContext;
  expect(await eventsVerb(ctx)).toMatchObject({ result: { state }, exitCode });
  expect(json).toHaveBeenCalledTimes(1);
  expect(raw).not.toHaveBeenCalled();
  expect(JSON.parse(out.mock.calls[0]![0])).toMatchObject({ kind: "job", threadId: "t1", state });
});
