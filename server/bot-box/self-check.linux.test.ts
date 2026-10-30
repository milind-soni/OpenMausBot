// The real box, where it can run: Linux with an unprivileged bubblewrap (a Cloud home, the Fly test machine). Elsewhere
// the suite says so and skips; the Fly acceptance run (`node dist-server/bot-box/box-check.js`) is where this is proved
// for the image (see _plans/team-mode-2026-10-21/T0-BUILD.md).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { BOX_BRIDGE_SCRIPT, writeSeccompFile } from "./box.ts";
import { detectBox } from "./detect.ts";
import { runBoxSelfCheck } from "./self-check.ts";

const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const available = detection.box === "bwrap" && detection.tools !== null;
const root = mkdtempSync(join(tmpdir(), "omb-box-real-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!available)(`the real box (${detection.box === "bwrap" ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  const options = () => ({
    bwrap: detection.tools!.bwrap, bridge: { socat: detection.tools!.socat, bridgeScript: BOX_BRIDGE_SCRIPT, node: process.execPath },
    root, denyEnv: new Set(["COMPOSIO_API_KEY"]), publicTarget: null, timeoutMs: 90_000, seccompFile: writeSeccompFile(root),
  });

  it("passes every check inside a real box", async () => {
    const result = await runBoxSelfCheck(options());
    expect(result.error).toBeUndefined();
    expect(result.failed).toEqual([]);
    expect(result.total).toBe(process.arch === "x64" ? 31 : 30);
    expect(result.results.map((check) => check.id)).toEqual(expect.arrayContaining(["engine-runs", "engine-read-only", "no-provider-key-in-env", "broker-call-works", "broker-wrong-token-refused", "broker-other-grant-refused", "broker-key-not-on-disk", "base-url-is-broker"]));
  }, 120_000);

  it("each mutation fails the checks it guards, and only those", async () => {
    const expected: Record<string, string[]> = {
      "bind-data": ["messages-db-hidden", "config-hidden", "data-dir-empty", "other-bot-folder-hidden", "other-task-folder-hidden", "secret-not-on-disk"],
      "share-pid": ["other-pid-hidden", "server-pid-hidden"],
      "share-net": ["host-loopback-unreachable", "no-direct-internet"],
      "env-all": ["secret-not-in-env"],
      "tmp-shared": ["tmp-private"],
      "engines-rw": ["engine-read-only"],
      ...(process.arch === "x64" ? { "no-seccomp": ["keyring-denied"] } : {}),
    };
    for (const [mutation, checks] of Object.entries(expected)) {
      const result = await runBoxSelfCheck({ ...options(), mutate: new Set([mutation as never]) });
      expect(result.error, mutation).toBeUndefined();
      for (const id of checks) expect(result.failed, `${mutation} should fail ${id}`).toContain(id);
      // share-net drops the two isolated-network checks instead of failing them; everything else holds.
      const other = result.failed.filter((id) => !checks.includes(id));
      expect(other, `${mutation} broke more than it should`).toEqual([]);
    }
  }, 300_000);
});
