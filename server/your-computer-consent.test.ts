import { describe, expect, it } from "vitest";

import { claimWithYourComputerConsent, YourComputerDeclined } from "./your-computer-consent.ts";

describe("claimWithYourComputerConsent", () => {
  const run = (levels: boolean[], answer: "allow" | "deny" = "allow") => {
    const steps: string[] = [];
    let reads = 0;
    const askNow = () => levels[Math.min(reads++, levels.length - 1)];
    const ask = async () => { steps.push("ask"); if (answer === "deny") throw new YourComputerDeclined("no"); };
    const bind = async () => { steps.push("bind"); };
    return { steps, done: claimWithYourComputerConsent(askNow, ask, bind) };
  };

  it("never asks at Full access, before or after the wait", async () => {
    const { steps, done } = run([false, false]);
    await done;
    expect(steps).toEqual(["bind"]);
  });

  it("asks once, before the wait, below Full access", async () => {
    const { steps, done } = run([true, true]);
    await done;
    expect(steps).toEqual(["ask", "bind"]);
  });

  it("asks after the wait when the thread dropped to Ask while it waited", async () => {
    const { steps, done } = run([false, true]);
    await done;
    expect(steps).toEqual(["bind", "ask"]);
  });

  it("fails the claim when the person denies after the wait", async () => {
    const { steps, done } = run([false, true], "deny");
    await expect(done).rejects.toBeInstanceOf(YourComputerDeclined);
    expect(steps).toEqual(["bind", "ask"]);
  });
});
