// Specialist sub-bots the Tier-3 brain designs on request. A bot is one JSON file:
// saved atomically, swapped on disk the moment it is edited, and answered on the
// specialist tier with the tools it was scoped to.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { redactSecretsInText } from "../redact.ts";

export const SUBBOTS_VERSION = 1;
export const INSTRUCTIONS_MAX_CHARS = 8000;
export const SUBBOT_NAME_MAX_CHARS = 60;
export const MAX_SUBBOT_TOOLS = 12;

export interface SubBot {
  id: string;
  name: string;
  purpose: string;
  instructions: string;
  tools: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** The orchestrating brain that designs a sub-bot; wraps the brain tier of the router. */
export type SubBotBrain = (messages: readonly { role: "system" | "user"; content: string }[], options?: { json?: boolean }) => Promise<string>;

export function subBotsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMB_SUBBOTS_DIR?.trim() || join(DATA_DIR, "subbots");
}

const cleanId = (id: string) => (id.match(/^[a-z0-9][a-z0-9-]{0,63}$/) ? id : "");
const cleanText = (text: string, max: number) => redactSecretsInText(text ?? "").slice(0, max).trim();

function botFile(dir: string, id: string): string | null {
  if (!cleanId(id)) return null;
  return join(dir, `${id}.json`);
}

export function loadSubBot(dir: string, id: string): SubBot | undefined {
  const file = botFile(dir, id);
  if (!file || !existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SubBot>;
    if (!parsed.id || typeof parsed.instructions !== "string") return undefined;
    return {
      id: parsed.id,
      name: parsed.name ?? parsed.id,
      purpose: parsed.purpose ?? "",
      instructions: parsed.instructions,
      tools: Array.isArray(parsed.tools) ? parsed.tools : [],
      enabled: parsed.enabled !== false,
      createdAt: parsed.createdAt ?? 0,
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch {
    return undefined;
  }
}

export function listSubBots(dir: string): SubBot[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => loadSubBot(dir, name.slice(0, -".json".length)))
    .filter((bot): bot is SubBot => Boolean(bot))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The save is atomic, so a running answer never reads a half-written persona. */
export function saveSubBot(dir: string, bot: SubBot): SubBot | undefined {
  const file = botFile(dir, bot.id);
  if (!file) return undefined;
  const clean: SubBot = {
    id: bot.id,
    name: cleanText(bot.name, SUBBOT_NAME_MAX_CHARS),
    purpose: cleanText(bot.purpose, 2000),
    instructions: cleanText(bot.instructions, INSTRUCTIONS_MAX_CHARS),
    tools: bot.tools.slice(0, MAX_SUBBOT_TOOLS).map((tool) => cleanText(tool, 80)),
    enabled: bot.enabled !== false,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
  };
  if (!clean.name || !clean.instructions) return undefined;
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}

export function deleteSubBot(dir: string, id: string): boolean {
  const file = botFile(dir, id);
  if (!file || !existsSync(file)) return false;
  rmSync(file);
  return true;
}

const SPAWN_SYSTEM =
  "You design specialist sub-bots for the owner's assistant. Write the bot's standing " +
  "instructions in second person, plain text, under 300 words: its specialty, its tone, " +
  "the tools it may use, what it must refuse, and that it escalates to the orchestrating " +
  "brain when a request needs deeper diagnostics than it can do. " +
  'Answer with JSON only: {"instructions": string, "tools": string[]}';

function parseSpawned(text: string): { instructions: string; tools: string[] } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The brain did not answer with a bot design.");
  const parsed = JSON.parse(text.slice(start, end + 1)) as { instructions?: string; tools?: string[] };
  if (typeof parsed.instructions !== "string" || !parsed.instructions.trim()) {
    throw new Error("The brain's design has no instructions.");
  }
  return { instructions: parsed.instructions, tools: Array.isArray(parsed.tools) ? parsed.tools : [] };
}

/** Ask the brain for a specialist's persona and save it. The name becomes the id. */
export async function spawnSubBot(
  deps: { dir: string; brain: SubBotBrain; name: string; purpose: string; tools?: readonly string[]; now?: () => number },
): Promise<SubBot> {
  const now = deps.now ?? Date.now;
  const id = deps.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!cleanId(id)) throw new Error("Give the bot a name of letters, digits or dashes.");
  const design = parseSpawned(
    await deps.brain(
      [
        { role: "system", content: SPAWN_SYSTEM },
        { role: "user", content: `Design a sub-bot named "${deps.name}". Purpose: ${deps.purpose}. Tools it may use: ${(deps.tools ?? []).join(", ") || "none"}.` },
      ],
      { json: true },
    ),
  );
  const existing = loadSubBot(deps.dir, id);
  const bot: SubBot = {
    id,
    name: deps.name,
    purpose: deps.purpose,
    instructions: design.instructions,
    tools: design.tools.length ? design.tools : [...(deps.tools ?? [])],
    enabled: true,
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  };
  const saved = saveSubBot(deps.dir, bot);
  if (!saved) throw new Error("The bot's design came back empty.");
  return saved;
}
