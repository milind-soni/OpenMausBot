// Grok's readiness wait for the tool selection's MCP catalog: it ends on Grok's own confirmation, pacing on the
// shared budget, not on a wall clock shorter than a server's own start.
import { describe, expect, it, vi } from "vitest";

import type { SendTurnInput } from "../../contracts.ts";
import { GROK_SUPPORT } from "./grok.ts";

// Grok's readiness loop paces on timers/promises, which fake timers cannot reach: tie it to the faked global clock.
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: (ms: number, value?: unknown) => new Promise((resolve) => { globalThis.setTimeout(() => resolve(value), ms); }),
}));

describe("Grok confirms its selected MCP catalog", () => {
  it("keeps waiting while Grok reports progress past the old cap, and accepts the catalog when it resolves", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const request = async (method: string) => {
        if (method !== "_x.ai/mcp/list") return {};
        polls += 1;
        const resolved = polls > 220;
        return { result: { servers: [{ name: "notes", session: { enabled: true, status: resolved ? "ready" : "starting" } }], sessionMcpResolved: resolved } };
      };
      const turn = { toolScope: { allow: ["mcp:notes:*"] }, integrations: { custom: { notes: { command: "notes" } } } } as unknown as SendTurnInput;
      const run = GROK_SUPPORT.configureSession!({ request, sessionId: "s", turn, sessionModels: [], currentModelId: undefined, configOptions: [], effortApplied: () => {} } as unknown as Parameters<NonNullable<typeof GROK_SUPPORT.configureSession>>[0]);
      let outcome: string | undefined;
      void run.then(() => { outcome = "confirmed"; }, (error: Error) => { outcome = error.message; });
      for (let step = 0; step < 400 && outcome === undefined; step += 1) await vi.advanceTimersByTimeAsync(100);
      expect(polls, "it was still resolving when the old ten-second cap had passed").toBeGreaterThan(220);
      expect(outcome).toBe("confirmed");
    } finally { vi.useRealTimers(); }
  });

  it("ends the turn when the confirmation never comes, even past a catalog that answers", async () => {
    vi.useFakeTimers();
    try {
      const request = async () => ({ result: { servers: [], sessionMcpResolved: false } });
      const turn = { toolScope: { allow: ["mcp:notes:*"] }, integrations: { custom: { notes: { command: "notes" } } } } as unknown as SendTurnInput;
      const run = GROK_SUPPORT.configureSession!({ request, sessionId: "s", turn, sessionModels: [], currentModelId: undefined, configOptions: [], effortApplied: () => {} } as unknown as Parameters<NonNullable<typeof GROK_SUPPORT.configureSession>>[0]);
      let outcome: string | undefined;
      void run.then(() => { outcome = "confirmed"; }, (error: Error) => { outcome = error.message; });
      for (let step = 0; step < 700 && outcome === undefined; step += 1) await vi.advanceTimersByTimeAsync(100);
      expect(outcome).toBe("Grok did not confirm its selected MCP catalog in time. No prompt was sent.");
    } finally { vi.useRealTimers(); }
  });
});
