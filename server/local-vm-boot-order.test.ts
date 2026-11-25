// The Local VM's recovery and its first availability read start as the server loads, not after the desktop window is in
// use (perf/launch-probe.ts): a queued or channel turn sent as the server listens must find a running VM, and the first
// turn's tool list must already be the one every later turn gets.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("the Local VM at server start", () => {
  it("recovers running VMs before the server listens, never behind the window", () => {
    const recover = source.indexOf("void recoverLocalVms({");
    expect(recover).toBeGreaterThan(0);
    expect(recover).toBeLessThan(source.indexOf("server.listen(PORT"));
    expect(source).not.toMatch(/afterLaunchSettles\(\(\) => void recoverLocalVms/);
  });

  it("starts its availability read at once", () => {
    expect(source).toMatch(/createLocalVmAvailability\(\(\) => containerRuntimeStatus\(\)\);/);
  });
});
