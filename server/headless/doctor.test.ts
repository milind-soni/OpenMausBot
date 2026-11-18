import { describe, expect, it, vi } from "vitest";

import type { HeadlessIo } from "./output.ts";
import { runHeadless } from "./main.ts";

const refused = (status: number) => Object.assign(new Error(`OpenMausBot API error (${status}): {"error":"forbidden"}`), { status });

/** `openmausbot doctor` on a server whose local callers without a session get the service routes only: a shared server,
 * or one in the hardened profile, as in the server's container, where deploy/update.sh runs it. */
function sharedServer(engines: number | "old server") {
  const callTool = vi.fn(async (name: string) => {
    if (name === "get_system_health") return { status: "connected", app: "openmausbot", packaged: true };
    if (name === "list_available_models") throw refused(403);
    throw new Error(`unexpected tool ${name}`);
  });
  const request = vi.fn(async (path: string) => {
    if (path === "/api/health/engines") {
      if (engines === "old server") throw refused(403);
      return { app: "openmausbot", engines };
    }
    if (path === "/.well-known/openmausbot/environment") return { version: "0.1.160", label: "maus.example.com", capabilities: { jobs: true } };
    if (path === "/api/auth/session") return { kind: "loopback", scopes: ["client"], trust: "service" };
    throw refused(403);
  });
  const out: string[] = [];
  const io: HeadlessIo = { out: (text) => out.push(text), err: () => {}, readStdin: async () => "" };
  return async (argv: string[]) => {
    const code = await runHeadless(argv, { env: { OPENMAUSBOT_URL: "http://127.0.0.1:19999" }, io, callTool: callTool as any, request: request as any });
    return { code, out };
  };
}

describe("doctor on a shared server, without a session", () => {
  it("is ready when the server counts an engine that can start a bot, without naming it", async () => {
    const { code, out } = await sharedServer(1)(["doctor", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ ok: true, availableEngines: [], availableEngineCount: 1, problems: [] });
    const human = await sharedServer(2)(["doctor"]);
    expect(human.code).toBe(0);
    expect(human.out.join("\n")).toContain("Engines available: 2 (which ones needs a session)");
    expect(human.out.join("\n")).toContain("as a local service, not the owner");
  });

  it("is not ready when none can, and says so", async () => {
    const { code, out } = await sharedServer(0)(["doctor", "--json"]);
    expect(code).not.toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ ok: false, availableEngineCount: 0, problems: [expect.stringContaining("no engine is available")] });
  });

  it("keeps the server's refusal when the server is too old to count", async () => {
    const { code } = await sharedServer("old server")(["doctor", "--json"]);
    expect(code).not.toBe(0);
  });
});

describe("doctor --data", () => {
  async function local(argv: string[], dataDir?: string) {
    const out: string[] = [], err: string[] = [];
    const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
    const callTool = vi.fn(async () => { throw new Error("doctor --data must not reach a server"); });
    const code = await runHeadless(argv, { env: dataDir ? { OMB_DATA_DIR: dataDir } : {}, io, callTool: callTool as any });
    return { code, out, err, callTool };
  }

  it("checks this computer's data folder without a server, and --fix alone means --data", async () => {
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const data = mkdtempSync(join(tmpdir(), "omb-doctor-cli-"));
    try {
      for (const name of ["events", "native"]) mkdirSync(join(data, name));
      const stray = join(data, "config.json.999999.0b4d8f7a-3c2e-4f1a-9b6d-5e7c8a9f0d1e.tmp");
      writeFileSync(stray, "{}");
      const looked = await local(["doctor", "--data", "--json"], data);
      expect(looked.code).toBe(8);
      expect(JSON.parse(looked.out.at(-1)!)).toMatchObject({ ok: false, dataDir: data, fix: { asked: false } });
      expect(existsSync(stray)).toBe(true);
      const fixed = await local(["doctor", "--fix", "--data-dir", data]);
      expect(fixed.code).toBe(0);
      expect(fixed.out.at(-1)).toBe("All fine now: 1 fixed.");
      expect(existsSync(stray)).toBe(false);
      expect(looked.callTool).not.toHaveBeenCalled();
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it("refuses options that are about a server, and mixing it with --host", async () => {
    expect((await local(["doctor", "--data", "--url", "http://127.0.0.1:1"])).code).toBe(2);
    expect((await local(["doctor", "--fix", "--wait", "1m"])).code).toBe(2);
    expect((await local(["doctor", "--host", "--data"])).code).toBe(2);
  });
});
