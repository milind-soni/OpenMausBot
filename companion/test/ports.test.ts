import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "src", "index.ts");

/** Never reaches `listen`. HOME/USERPROFILE and OMB_COMPANION_DIR must travel:
 * DeviceRegistry reads its file at module scope, before the port check, and
 * would otherwise read the developer's real paired fleet. */
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
    expect(err).not.toContain("already in use");
  }, 20_000);

  it("follows OMB_WEBHOOK_PORT rather than assuming the port above", async () => {
    const { code, err } = await start({
      OMB_PORT: "9100",
      OMB_WEBHOOK_PORT: "9500",
      OMB_COMPANION_PORT: "9500",
    });
    expect(code).toBe(1);
    expect(err).toContain("webhook receiver");

    // The companion port is checked before the control port, so an error
    // naming the control port proves the vacated 9101 got through.
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
