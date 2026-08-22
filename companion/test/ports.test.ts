// The sidecar refuses ports the harness owns.
//
// This exists because of a bug that shipped: the sidecar's device port was
// 8800, and a later harness release started opening a webhook receiver one
// port above itself — 8800, by default. Two processes, one socket, and the
// loser was whichever started second. Started by the desktop app the harness
// wins and the companion never comes up; started by hand first the companion
// wins and the harness logs its webhook receiver unavailable, a hundred lines
// away from anything the person was doing.
//
// So the defaults moved clear, and the overlap is now refused by name rather
// than discovered as EADDRINUSE. This checks the refusal, because the value
// of the whole thing is the sentence it prints.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "src", "index.ts");

/** Start the sidecar and collect how it died. Never reaches `listen` in any
 * case here — the check runs first, so nothing binds and nothing to clean.
 *
 * The home directory still has to travel, though. `DeviceRegistry` is built at
 * module scope, before the port check runs, and it reads its device file from
 * `homedir()`. Without HOME/USERPROFILE the child inherits nothing and falls
 * back to the account running the suite, so this would quietly read whatever
 * real paired fleet the developer has. The suite's own throwaway home is
 * already on `process.env` — see server/testing/setup.ts — along with the
 * OMB_COMPANION_DIR that pins the sidecar's own data directory inside it,
 * which is carried for the same reason and is the one that actually decides
 * where the child writes. */
const start = (env: Record<string, string>): Promise<{ code: number | null; err: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
        ...(process.env.OMB_COMPANION_DIR ? { OMB_COMPANION_DIR: process.env.OMB_COMPANION_DIR } : {}),
        ...env,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, err }));
    setTimeout(() => child.kill("SIGKILL"), 15_000).unref?.();
  });

describe("port conflicts with the harness", () => {
  it("refuses the harness's own port, and says so", async () => {
    const { code, err } = await start({ OMB_PORT: "9100", OMB_COMPANION_PORT: "9100" });
    expect(code).toBe(1);
    expect(err).toContain("OMB_COMPANION_PORT");
    expect(err).toContain("the harness itself");
  }, 20_000);

  // The one that actually bit. The webhook port is implicit — one above the
  // harness — so someone reading only their own config sees no overlap.
  it("refuses the webhook receiver's port, and names it", async () => {
    const { code, err } = await start({ OMB_PORT: "9100", OMB_COMPANION_PORT: "9101" });
    expect(code).toBe(1);
    expect(err).toContain("9101");
    expect(err).toContain("webhook receiver");
  }, 20_000);

  it("refuses it for the control port too", async () => {
    const { code, err } = await start({
      OMB_PORT: "9100",
      OMB_COMPANION_PORT: "9200",
      OMB_CONTROL_PORT: "9101",
    });
    expect(code).toBe(1);
    expect(err).toContain("OMB_CONTROL_PORT");
    expect(err).toContain("webhook receiver");
  }, 20_000);

  // The sidecar's own two ports. Left to bind order this is an EADDRINUSE
  // naming a port the person can see nothing on — the something-else using
  // it is this same process, one line earlier — and the message blames
  // "another copy of the companion", sending someone to hunt for a process
  // that is not running.
  it("refuses to put the device port and the control port on one socket", async () => {
    const { code, err } = await start({
      OMB_PORT: "9100",
      OMB_COMPANION_PORT: "9300",
      OMB_CONTROL_PORT: "9300",
    });
    expect(code).toBe(1);
    expect(err).toContain("OMB_COMPANION_PORT");
    expect(err).toContain("OMB_CONTROL_PORT");
    expect(err).toContain("9300");
    // named by the check, not discovered by the second bind
    expect(err).not.toContain("already in use");
  }, 20_000);

  // An explicit OMB_WEBHOOK_PORT moves the receiver, which frees the port
  // above the harness. Refusing it anyway would be refusing a port nothing
  // is on.
  it("follows OMB_WEBHOOK_PORT rather than assuming the port above", async () => {
    const { code, err } = await start({
      OMB_PORT: "9100",
      OMB_WEBHOOK_PORT: "9500",
      OMB_COMPANION_PORT: "9500",
    });
    expect(code).toBe(1);
    expect(err).toContain("webhook receiver");

    // And the port it vacated is free. Asserted without booting the thing:
    // the companion port is checked before the control port, so putting the
    // vacated 9101 on the companion and the conflict on the control means a
    // message naming the *control* port proves 9101 got through.
    const moved = await start({
      OMB_PORT: "9100",
      OMB_WEBHOOK_PORT: "9500",
      OMB_COMPANION_PORT: "9101",
      OMB_CONTROL_PORT: "9500",
    });
    expect(moved.code).toBe(1);
    expect(moved.err).toContain("OMB_CONTROL_PORT");
    expect(moved.err).not.toContain("OMB_COMPANION_PORT");
  }, 40_000);
});
