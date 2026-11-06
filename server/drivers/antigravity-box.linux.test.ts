// Antigravity's Google sign-in in a real bot box, where one can run: Linux with an unprivileged bubblewrap (a Cloud home,
// the Fly test machine). The runtime's OAuth callback listener is on the box's own loopback, so a redirect pasted from
// another computer reaches it only through the box's relay. Elsewhere the suite says so and skips.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { botBox } from "../bot-box/box.ts";
import { detectBox } from "../bot-box/detect.ts";
import { AntigravityAuthController, antigravityProfileAuthenticated, forwardAntigravityCallback, prepareAntigravityProfile } from "./antigravity-acp.ts";
import { resolveAntigravityRuntime } from "./antigravity-runtime.ts";

const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const available = detection.box === "bwrap" && detection.tools !== null;
const FAKE_SIGNIN = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-antigravity-signin.ts");

describe.skipIf(!available)(`Antigravity's Google sign-in in a real box (${available ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  const root = mkdtempSync(join(tmpdir(), "omb-ag-box-"));
  const home = join(root, "home"), dataDir = join(home, ".openmausbot"), runtimeDir = join(home, "runtime");
  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    for (const name of ["fake-antigravity.ts", "localharness_external"]) {
      writeFileSync(join(runtimeDir, name), readFileSync(FAKE_SIGNIN));
      chmodSync(join(runtimeDir, name), 0o755);
    }
    await botBox.start({ dataDir, home, port: 18799, denyEnv: new Set(), env: { ...process.env, OMB_BOT_BOX: "1" }, log: () => {} });
  });
  afterAll(async () => {
    await botBox.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("delivers a redirect pasted from another computer to the listener inside the box, which the server's own loopback cannot reach", async () => {
    expect(botBox.enabled()).toBe(true);
    const runtime = await resolveAntigravityRuntime(join(runtimeDir, "fake-antigravity.ts"));
    const profile = await prepareAntigravityProfile({ instanceId: "boxed-signin", runtime, baseDir: dataDir });
    const controller = new AntigravityAuthController();
    try {
      const flow = await controller.start(runtime, profile);
      const redirect = new URL(flow.authorizationUrl!).searchParams.get("redirect_uri")!;
      const callback = `${redirect}?state=fixture&code=pasted`;
      // What the server's own loopback answers on that port: nothing listens there.
      await expect(forwardAntigravityCallback(new URL(callback))).rejects.toMatchObject({ code: "ECONNREFUSED" });
      await controller.complete(flow.flowId!, callback);
      expect(await antigravityProfileAuthenticated(profile)).toBe(true);
    } finally {
      controller.cancel();
    }
  }, 60_000);
});
