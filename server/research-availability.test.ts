import { expect, it, vi } from "vitest";

import { createResearchAvailability } from "./research.ts";

const PLAN = { token: "plan-test", api: "https://research.example.test", included: true };
function deferred() {
  let resolve!: (answer: boolean | null) => void;
  const promise = new Promise<boolean | null>(done => { resolve = done; });
  return { promise, resolve };
}

it("keeps a call's newer refusal when an older availability probe answers true", async () => {
  const probe = deferred();
  const offered = vi.fn(() => probe.promise);
  const research = createResearchAvailability({ credential: () => PLAN, offered });
  expect(research.available()).toBe(true);
  research.refused();
  expect(research.available()).toBe(false);
  probe.resolve(true);
  await probe.promise;
  expect(research.available()).toBe(false);
  expect(offered).toHaveBeenCalledTimes(1);
});

it("lets the scheduled recheck proceed even when the superseded probe has not settled", async () => {
  const old = deferred(), current = deferred();
  let now = 0;
  const offered = vi.fn((): Promise<boolean | null> => Promise.resolve(null)).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const research = createResearchAvailability({ credential: () => PLAN, offered, now: () => now, recheckOffMs: 100 });
  research.available();
  research.refused();
  now = 100;
  expect(research.available()).toBe(false);
  expect(offered).toHaveBeenCalledTimes(2);
  old.resolve(true);
  await old.promise;
  expect(research.available()).toBe(false);
  expect(offered).toHaveBeenCalledTimes(2);
  current.resolve(true);
  await current.promise;
  expect(research.available()).toBe(true);
});

it("does not replace the current credential's answer with an older credential's result", async () => {
  const old = deferred(), current = deferred();
  let credential = PLAN;
  const offered = vi.fn((): Promise<boolean | null> => Promise.resolve(null)).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const research = createResearchAvailability({ credential: () => credential, offered });
  research.available();
  credential = { ...PLAN, token: "new-plan-test" };
  research.available();
  current.resolve(false);
  await current.promise;
  expect(research.available()).toBe(false);
  old.resolve(true);
  await old.promise;
  expect(research.available()).toBe(false);
  expect(offered).toHaveBeenCalledTimes(2);
});

it("shares one ordinary pending probe and keeps its answer", async () => {
  const probe = deferred();
  const offered = vi.fn(() => probe.promise);
  const research = createResearchAvailability({ credential: () => PLAN, offered });
  research.available();
  research.available();
  expect(offered).toHaveBeenCalledTimes(1);
  probe.resolve(false);
  await probe.promise;
  expect(research.available()).toBe(false);
});
