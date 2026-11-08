import { closeSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BoxRunner } from "./box.ts";
import { openCredentialBroker, type CredentialBroker } from "./broker.ts";

function descriptorsFor(file: string): number[] {
  return readdirSync("/proc/self/fd").flatMap((fd) => {
    try { return readlinkSync(`/proc/self/fd/${fd}`) === file ? [Number(fd)] : []; } catch { return []; }
  });
}

describe.skipIf(process.platform !== "linux")("BoxRunner refusal cleanup", () => {
  it.each(["explicit", "argv"] as const)("releases seccomp descriptors and broker grants on %s read-only refusal", async (source) => {
    const root = mkdtempSync(join(tmpdir(), "omb-wrap-cleanup-"));
    const home = join(root, "home"), dataDir = join(root, "data");
    const file = join(dataDir, "mcp.json"), filter = join(root, "seccomp.bpf");
    let broker: CredentialBroker | undefined;
    try {
      mkdirSync(home);
      mkdirSync(dataDir);
      writeFileSync(file, "fixture");
      writeFileSync(filter, "filter");
      broker = await openCredentialBroker({ socketPath: join(root, "b.sock") });
      const runner = new BoxRunner({
        bwrap: "/usr/bin/bwrap",
        bridge: { socat: "/usr/bin/socat", bridgeScript: "/fixture/bridge", node: process.execPath },
        setup: { home, dataDir, codeRoots: [], engineRoots: [], bridges: [] },
        denyEnv: new Set(), seccompFile: filter,
        broker: { port: 18080, mintForProcess: broker.mintForProcess, revoke: broker.revoke },
      });
      const request = {
        command: "/bin/sh", args: source === "argv" ? ["--mcp-config", file] : [],
        env: { ANTHROPIC_API_KEY: "synthetic" }, ...(source === "explicit" ? { ro: [file] } : {}),
      };
      const wrapped = runner.wrap(request);
      try {
        expect(descriptorsFor(filter)).toHaveLength(1);
        expect(broker.stats().tokens).toBe(1);
      } finally {
        for (const fd of wrapped.extraFds) closeSync(fd);
        wrapped.release();
      }
      linkSync(file, join(home, "alias"));
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(() => runner.wrap(request)).toThrow(/multiply-linked read-only file/);
      }
      expect({ seccompFds: descriptorsFor(filter).length, grants: broker.stats().tokens }).toEqual({ seccompFds: 0, grants: 0 });
    } finally {
      for (const fd of descriptorsFor(filter)) closeSync(fd);
      await broker?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
