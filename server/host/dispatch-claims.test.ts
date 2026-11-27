import { describe, expect, it } from "vitest";
import { createDispatchClaims } from "./dispatch-claims.ts";

type Claim = { id: string; phase: "setup" | "dispatching" };

const settledYet = async (promise: Promise<void>): Promise<boolean> => {
  let done = false;
  void promise.then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

describe("createDispatchClaims", () => {
  it("resolves at once when the thread holds no claim", async () => {
    expect(await settledYet(createDispatchClaims<Claim>().released("t1"))).toBe(true);
  });

  it("waits through a phase change of the same claim and resolves when it is cleared", async () => {
    const claims = createDispatchClaims<Claim>();
    claims.set("t1", { id: "c1", phase: "setup" });
    const released = claims.released("t1");
    claims.set("t1", { id: "c1", phase: "dispatching" });
    expect(await settledYet(released)).toBe(false);
    claims.set("t2", { id: "c1", phase: "setup" });
    claims.delete("t2");
    expect(await settledYet(released), "another thread's claim, even one with the same id").toBe(false);
    claims.delete("t1");
    expect(await settledYet(released)).toBe(true);
  });

  it("resolves when another turn's claim replaces it, and then waits on that one only for a new caller", async () => {
    const claims = createDispatchClaims<Claim>();
    claims.set("t1", { id: "c1", phase: "dispatching" });
    const first = claims.released("t1");
    claims.set("t1", { id: "c2", phase: "setup" });
    expect(await settledYet(first)).toBe(true);
    const second = claims.released("t1");
    expect(await settledYet(second)).toBe(false);
    claims.clear();
    expect(await settledYet(second)).toBe(true);
  });
});
