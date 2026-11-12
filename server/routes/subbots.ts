// Sub-bots in the app: list them, ask the brain for a new one, hot-swap a persona's
// instructions, and put a question to a specialist. A spawn or an answer only reaches
// OpenRouter, never a person, so these stay behind the app's auth without extra gates.
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";
import { chatCompletion, openRouterKey, type ChatMessage } from "../llm/openrouter.ts";
import { deleteSubBot, listSubBots, loadSubBot, saveSubBot, spawnSubBot, subBotsDir, type SubBotBrain } from "../llm/subbots.ts";
import { telephonyWiring } from "./telephony.ts";

export interface SubBotRouteDeps {
  dir?: string;
  /** The Tier-3 brain that designs bots. */
  brain?: SubBotBrain;
  /** A specialist-tier answer under a bot's instructions. */
  chat?: (messages: readonly ChatMessage[]) => Promise<string>;
  now?: () => number;
}

const NO_KEY = "OpenRouter is not configured. Set OPENROUTER_API_KEY or OMB_OPENROUTER_API_KEY in .env.";

export function createSubBotRoutes(deps: SubBotRouteDeps): RouteHandler {
  const dir = () => deps.dir ?? subBotsDir();
  const now = deps.now ?? Date.now;
  const brain: SubBotBrain =
    deps.brain ??
    (async (messages, options) => {
      const key = openRouterKey();
      if (!key) throw new Error(NO_KEY);
      return (await chatCompletion("brain", { messages, json: options?.json }, { key })).text;
    });
  const chat =
    deps.chat ??
    (async (messages) => {
      const key = openRouterKey();
      if (!key) throw new Error(NO_KEY);
      return (await chatCompletion("specialist", { messages }, { key })).text;
    });

  return async ({ req, res, path, method, json, readBody }: RouteContext) => {
    const segments = path.split("/").filter(Boolean);
    if (segments[0] !== "api" || segments[1] !== "subbots") return PASS;
    const id = segments[2] ?? "";

    if (method === "GET" && !id) return json(res, 200, { bots: listSubBots(dir()) });

    if (method === "GET" && id) {
      const bot = loadSubBot(dir(), id);
      return bot ? json(res, 200, { bot }) : json(res, 404, { error: "No such sub-bot." });
    }

    if (method === "POST" && !id) {
      const body = (await readBody(req)) as { name?: string; purpose?: string; tools?: string[] };
      if (!body?.name?.trim() || !body?.purpose?.trim()) {
        return json(res, 400, { error: "Missing required fields: name, purpose" });
      }
      try {
        const bot = await spawnSubBot({
          dir: dir(),
          brain,
          name: body.name,
          purpose: body.purpose,
          tools: Array.isArray(body.tools) ? body.tools : [],
          now,
        });
        return json(res, 200, { bot });
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "PATCH" && id) {
      const bot = loadSubBot(dir(), id);
      if (!bot) return json(res, 404, { error: "No such sub-bot." });
      const body = (await readBody(req)) as Partial<Pick<SubBotEdit, "name" | "purpose" | "instructions" | "tools" | "enabled">>;
      const saved = saveSubBot(dir(), { ...bot, ...body, updatedAt: now() });
      return saved ? json(res, 200, { bot: saved }) : json(res, 400, { error: "That edit leaves the bot empty." });
    }

    if (method === "DELETE" && id) {
      return deleteSubBot(dir(), id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "No such sub-bot." });
    }

    if (method === "POST" && id && segments[3] === "ask") {
      const bot = loadSubBot(dir(), id);
      if (!bot) return json(res, 404, { error: "No such sub-bot." });
      if (!bot.enabled) return json(res, 409, { error: `${bot.name} is switched off.` });
      const body = (await readBody(req)) as { question?: string };
      if (!body?.question?.trim()) return json(res, 400, { error: "Missing required field: question" });
      const context = telephonyWiring().store.recentContext(20);
      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            bot.instructions +
            (bot.tools.length ? `\nTools you may use: ${bot.tools.join(", ")}.` : "") +
            (context.length ? `\nWhat the owner already said across calls, texts and notes:\n${context.join("\n")}` : ""),
        },
        { role: "user", content: body.question },
      ];
      try {
        return json(res, 200, { bot: bot.name, answer: await chat(messages) });
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    return PASS;
  };
}

interface SubBotEdit {
  name?: string;
  purpose?: string;
  instructions?: string;
  tools?: string[];
  enabled?: boolean;
}

/** The wiring index.ts routes, with the brain and specialist tiers of the OpenRouter router. */
export const subBotRoutes: RouteHandler = createSubBotRoutes({});
