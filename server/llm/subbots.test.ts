import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RouteContext } from "../routes/table.ts";
import type { ChatMessage } from "./openrouter.ts";
import { createSubBotRoutes } from "../routes/subbots.ts";
import { deleteSubBot, listSubBots, loadSubBot, saveSubBot, spawnSubBot, subBotsDir, type SubBot } from "./subbots.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-subbots-"));
  dirs.push(dir);
  return dir;
};

const bot = (over: Partial<SubBot> = {}): SubBot =>
  ({
    id: "auto-mechanic",
    name: "Auto Mechanic",
    purpose: "car diagnostics",
    instructions: "You diagnose the owner's car. Ask for make, model and year. Escalate to the orchestrating brain for electrical faults.",
    tools: ["vehicle-lookup"],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as SubBot;

describe("the sub-bot store", () => {
  it("defaults into the data dir and honors the env override", () => {
    expect(subBotsDir({})).toMatch(/[\\/]subbots$/);
    expect(subBotsDir({ OMB_SUBBOTS_DIR: "/tmp/custom-bots" })).toBe("/tmp/custom-bots");
  });

  it("saves, reloads and hot-swaps one bot per file", () => {
    const dir = fixture();
    expect(saveSubBot(dir, bot())).toBeDefined();
    expect(loadSubBot(dir, "auto-mechanic")!.instructions).toContain("diagnose");
    const swapped = saveSubBot(dir, bot({ instructions: "You now also handle EVs.", updatedAt: 2 }));
    expect(swapped!.updatedAt).toBe(2);
    expect(loadSubBot(dir, "auto-mechanic")!.instructions).toContain("EVs");
    expect(listSubBots(dir).map((b) => b.id)).toEqual(["auto-mechanic"]);
    expect(deleteSubBot(dir, "auto-mechanic")).toBe(true);
    expect(loadSubBot(dir, "auto-mechanic")).toBeUndefined();
  });

  it("refuses ids and fields that do not belong on disk", () => {
    const dir = fixture();
    expect(saveSubBot(dir, bot({ id: "../escape" }))).toBeUndefined();
    const dirty = saveSubBot(dir, bot({ id: "leaky", instructions: "call key sk-ant-1234567890abcdef" }));
    expect(dirty).toBeDefined();
    expect(loadSubBot(dir, "leaky")!.instructions).not.toContain("sk-ant-1234567890abcdef");
  });
});

describe("the spawner", () => {
  it("asks the brain for a persona and saves it under the name", async () => {
    const dir = fixture();
    const asked: string[] = [];
    const botSpawned = await spawnSubBot({
      dir,
      name: "Auto Mechanic",
      purpose: "car diagnostics over the phone",
      tools: ["vehicle-lookup"],
      brain: async (messages, options) => {
        asked.push(`${messages[0]!.role}:${messages[1]!.content}`);
        expect(options?.json).toBe(true);
        return JSON.stringify({ instructions: "You are the mechanic. Keep it under 300 words.", tools: ["vehicle-lookup"] });
      },
      now: () => 7,
    });
    expect(botSpawned.id).toBe("auto-mechanic");
    expect(botSpawned.createdAt).toBe(7);
    expect(asked[0]).toContain("Auto Mechanic");
    expect(loadSubBot(dir, "auto-mechanic")!.instructions).toContain("mechanic");
  });

  it("refuses a brain answer without a design", async () => {
    const dir = fixture();
    await expect(
      spawnSubBot({ dir, name: "Chef", purpose: "cooking", brain: async () => "I cannot help with that." }),
    ).rejects.toThrow();
    expect(listSubBots(dir)).toHaveLength(0);
  });
});

describe("sub-bot routes", () => {
  const makeCtx = (method: string, path: string, body?: unknown) => {
    let code = 0;
    let sent: Record<string, unknown> = {};
    const ctx = {
      req: {},
      res: {},
      url: new URL(`http://127.0.0.1:1${path}`),
      path,
      method,
      auth: { everything: true },
      json: (_res: unknown, status: number, payload: Record<string, unknown>) => {
        code = status;
        sent = payload;
      },
      readBody: async () => body ?? {},
    } as unknown as RouteContext;
    return { ctx, status: () => code, body: () => sent };
  };

  it("spawns, lists, hot-swaps, asks and deletes through the API", async () => {
    const dir = fixture();
    const questions: string[] = [];
    const routes = createSubBotRoutes({
      dir,
      brain: async () => JSON.stringify({ instructions: "You are the mechanic.", tools: [] }),
      chat: async (messages: readonly ChatMessage[]) => {
        questions.push(messages[messages.length - 1]!.content);
        return "Check the alternator first.";
      },
      now: () => 9,
    });

    const spawn = makeCtx("POST", "/api/subbots", { name: "Auto Mechanic", purpose: "car diagnostics" });
    await routes(spawn.ctx);
    expect(spawn.status()).toBe(200);

    const list = makeCtx("GET", "/api/subbots");
    await routes(list.ctx);
    expect((list.body().bots as SubBot[])[0]!.id).toBe("auto-mechanic");

    const patch = makeCtx("PATCH", "/api/subbots/auto-mechanic", { instructions: "You now handle EVs too." });
    await routes(patch.ctx);
    expect(patch.status()).toBe(200);
    expect(loadSubBot(dir, "auto-mechanic")!.instructions).toContain("EVs");

    const ask = makeCtx("POST", "/api/subbots/auto-mechanic/ask", { question: "my battery keeps dying" });
    await routes(ask.ctx);
    expect(ask.status()).toBe(200);
    expect(ask.body().answer).toBe("Check the alternator first.");
    expect(questions[0]).toBe("my battery keeps dying");

    const gone = makeCtx("DELETE", "/api/subbots/auto-mechanic");
    await routes(gone.ctx);
    expect(gone.status()).toBe(200);
    expect(listSubBots(dir)).toHaveLength(0);
  });

  it("refuses an ask for a bot that is switched off", async () => {
    const dir = fixture();
    saveSubBot(dir, bot({ enabled: false }));
    const routes = createSubBotRoutes({ dir, brain: async () => "x", chat: async () => "should not answer", now: () => 1 });
    const ask = makeCtx("POST", "/api/subbots/auto-mechanic/ask", { question: "hello" });
    await routes(ask.ctx);
    expect(ask.status()).toBe(409);
  });
});
