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
