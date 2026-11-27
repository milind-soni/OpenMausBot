import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PHONE_PUSH_RELAY_PATHS } from "../shared/phone-push.ts";
import { CLOCK_STEP_MS, cloudSignedTimestamp, cloudSigningTime, registerCloudClock } from "./cloud-clock.ts";
import { createWokeNotifier } from "./cloud-woke.ts";
import { pagesAuthHeaders } from "./pages/access.ts";
import { cloudHomePushRequest } from "./phone-push-admin.ts";

// A home a resume left behind signs its own calls to the Admin (phone notifications, the wake notice, Pages, Slack, team rules,
// the roster) with the true time its measurement gives, so the Admin, which judges them by its own clock, doesn't refuse them
// all while the clock waits to be set. Nov 26 2026: a home 40 minutes behind for 10.5 hours.
const NOW = Date.parse("2026-11-26T12:00:00Z"), BEHIND = 40 * 60_000;
const seconds = (ms: number) => String(Math.floor(ms / 1000));
afterEach(() => { registerCloudClock(null); });

/** A clock watch that measured this clock `errorMs` off (positive: behind); `settled` resolves when the test says. */
function measured(errorMs: number | null) {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const state = { errorMs, waiting: false };
  registerCloudClock({ woke() {}, report: () => ({ v: 1, errorMs: state.errorMs, measuredAt: null }), settled: () => (state.waiting ? pending : Promise.resolve()) });
  return { state, release };
}

describe("the time a home signs its own calls with", () => {
  it("is this clock, unless a fresh measurement says it is 30 s or more off", () => {
    expect(cloudSigningTime(NOW)).toBe(NOW);
    measured(BEHIND);
    expect(cloudSigningTime(NOW)).toBe(NOW + BEHIND);
    expect(cloudSignedTimestamp(NOW)).toBe(seconds(NOW + BEHIND));
    measured(CLOCK_STEP_MS - 1);
    expect(cloudSigningTime(NOW)).toBe(NOW);
    measured(null);
    expect(cloudSigningTime(NOW)).toBe(NOW);
    // Ahead: signed with the true time too (the Admin's clock is the one that counts).
    measured(-BEHIND);
    expect(cloudSigningTime(NOW)).toBe(NOW - BEHIND);
  });

  it("is what a phone notification, a Pages call and the wake notice carry", async () => {
    measured(BEHIND);
    const push = cloudHomePushRequest({ admin: "https://admin.example", machineId: "m1", secret: "S".repeat(43) }, PHONE_PUSH_RELAY_PATHS.send, { v: 1 }, NOW);
    expect((push!.init.headers as Record<string, string>)["x-omb-cloud-timestamp"]).toBe(seconds(NOW + BEHIND));
    expect(pagesAuthHeaders({ kind: "home", url: "https://admin.example", machineId: "m1", secret: "S".repeat(43) }, "{}", NOW)["x-omb-cloud-timestamp"]).toBe(seconds(NOW + BEHIND));
    const sent: Request[] = [];
    const notify = createWokeNotifier({ adminOrigin: "https://admin.example", machineId: "m1", secret: "S".repeat(43), now: () => NOW,
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => { sent.push(new Request(input, init)); return new Response(null, { status: 204 }); }) as typeof fetch });
    notify();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent.map((request) => request.headers.get("x-omb-cloud-timestamp"))).toEqual([seconds(NOW + BEHIND)]);
  });

  it("the wake notice waits for the measurement a wake starts, and is signed with what it found", async () => {
    const clock = measured(null);
    clock.state.waiting = true;
    const sent: Request[] = [];
    const notify = createWokeNotifier({ adminOrigin: "https://admin.example", machineId: "m1", secret: "S".repeat(43), now: () => NOW,
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => { sent.push(new Request(input, init)); return new Response(null, { status: 204 }); }) as typeof fetch });
    notify();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toEqual([]);
    clock.state.errorMs = BEHIND;
    clock.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent.map((request) => request.headers.get("x-omb-cloud-timestamp"))).toEqual([seconds(NOW + BEHIND)]);
  });

  it("is used by every call the home signs for the Admin", () => {
    // Each place that sends `x-omb-cloud-timestamp` takes it from cloudSignedTimestamp; the Admin-side verifiers and tests excluded.
    const root = join(import.meta.dirname), files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) { if (name !== "node_modules") walk(path); } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(path); } };
    walk(root);
    const senders = files.filter((file) => /"x-omb-cloud-timestamp":\s*timestamp/.test(readFileSync(file, "utf8")));
    expect(senders.length).toBeGreaterThanOrEqual(8);
    const unsigned = senders.filter((file) => !/const timestamp = cloudSignedTimestamp\(/.test(readFileSync(file, "utf8")) && !file.includes(`${join("server", "testing")}`));
    expect(unsigned.map((file) => relative(root, file))).toEqual([]);
  });
});
