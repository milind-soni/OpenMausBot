import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  controlResultSucceeded,
  launchVerificationServer,
  runControlOmb,
} from "../scripts/control-omb.ts";

describe("control-omb command mapping", () => {
  it("treats unhealthy doctor and non-settled waits as command failures", () => {
    expect(controlResultSucceeded("doctor", { ok: true })).toBe(true);
    expect(controlResultSucceeded("doctor", { ok: false })).toBe(false);
    expect(controlResultSucceeded("wait", { status: "settled" })).toBe(true);
    for (const status of ["failed", "stalled", "timed-out", "needs-user"]) {
      expect(controlResultSucceeded("wait", { status })).toBe(false);
    }
  });

  it("runs directly under Node's strip-only TypeScript loader", () => {
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      join(process.cwd(), "scripts", "control-omb.ts"),
      "help",
    ], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("control-omb");
  });

  it("composes doctor from the shared health and model tools", async () => {
    const callTool = vi.fn(async (name: string) => name === "get_system_health"
      ? { status: "connected", app: "openmausbot" }
      : {
          instances: [
            { instanceId: "ready", snapshot: { state: "available" } },
            { instanceId: "missing", snapshot: { state: "unavailable" } },
          ],
        });
    const result = await runControlOmb(["doctor", "--url", "http://127.0.0.1:19999"], {
      callTool: callTool as any,
    }) as any;
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(["get_system_health", "list_available_models"]);
    expect(result).toMatchObject({
      ok: true,
      health: { endpoint: "http://127.0.0.1:19999" },
      availableEngines: ["ready"],
    });
  });

  it("rejects an available engine when the endpoint is not OpenMausBot", async () => {
    const callTool = vi.fn(async (name: string) => name === "get_system_health"
      ? { status: "connected", app: "another-app" }
      : { instances: [{ instanceId: "ready", snapshot: { state: "available" } }] });

    const result = await runControlOmb(["doctor", "--url", "http://127.0.0.1:19999"], {
      callTool: callTool as any,
    }) as any;

    expect(result.ok).toBe(false);
  });

  it("refuses to mutate a silently discovered live app", async () => {
    await expect(runControlOmb(["new-bot", "--name", "Probe"], {
      callTool: vi.fn() as any,
      env: {},
    })).rejects.toMatchObject({
      message: "mutating commands require an explicit OpenMausBot instance",
    });
  });

  it("maps bounded reads and dry-run actions without reimplementing them", async () => {
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({ name, args }));
    const env = { OPENMAUSBOT_URL: "http://127.0.0.1:19999" };
    await expect(runControlOmb(["messages", "--channel", "room-1", "--limit", "20"], {
      callTool: callTool as any,
      env,
    })).resolves.toEqual({ name: "get_channel_messages", args: { channel_id: "room-1", limit: 20 } });

    await expect(runControlOmb(["send", "--bot", "bot-1", "--text", "hello", "--dry-run"], {
      callTool: callTool as any,
      env: {},
    })).resolves.toMatchObject({
      dryRun: true,
      tool: "send_bot_message",
      arguments: { bot_id: "bot-1", text: "hello" },
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid bounds before the shared tool is called", async () => {
    const callTool = vi.fn();
    await expect(runControlOmb(["wait", "--bot", "bot-1", "--timeout", "0"], {
      callTool: callTool as any,
      env: {},
    })).rejects.toThrow("--timeout must be an integer from 1 to 120");
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe("control-omb isolated verification loop", () => {
  it("launches, drives a real fake-engine turn, and removes only its test data", async () => {
    const session = await launchVerificationServer({
      ...process.env,
      COMPOSIO_API_KEY: "must-not-reach-the-fixture",
      OMB_SKILLS_DIR: "/must/not/reach/the/fixture",
      XAI_API_KEY: "must-not-reach-the-fixture",
    });
    const env = { OPENMAUSBOT_URL: session.info.url };
    try {
      const doctor = await runControlOmb(["doctor"], { env }) as any;
      expect(doctor.ok).toBe(true);
      expect(doctor.availableEngines).toEqual(["claude"]);

      const created = await runControlOmb(["new-bot", "--name", "Verification Probe"], { env }) as any;
      const botId = created.bot.id as string;
      await runControlOmb(["send", "--bot", botId, "--text", "hello from the verification test"], { env });
      const settled = await runControlOmb(["wait", "--bot", botId, "--timeout", "20"], { env }) as any;
      expect(settled.status).toBe("settled");
      const transcript = await runControlOmb(["messages", "--bot", botId, "--limit", "10"], { env }) as any;
      expect(transcript.messages.some((message: { role?: string }) => message.role === "bot")).toBe(true);
      const fixtureEnv = JSON.parse(readFileSync(session.fixtureDumpPath, "utf8")).env as Record<string, string>;
      expect(fixtureEnv).not.toHaveProperty("COMPOSIO_API_KEY");
      expect(fixtureEnv).not.toHaveProperty("OMB_SKILLS_DIR");
      expect(fixtureEnv).not.toHaveProperty("XAI_API_KEY");
      expect(JSON.stringify(fixtureEnv)).not.toContain("must-not-reach-the-fixture");
    } finally {
      await session.close();
    }
    expect(existsSync(session.info.dataDir)).toBe(false);
    expect(existsSync(session.info.logPath)).toBe(true);
  }, 30_000);
});
