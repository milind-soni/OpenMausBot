// Bots the person paused: one bot, every bot in a department, or every bot there is takes no new work until it is
// resumed. <data>/paused-bots.json keeps which bots and departments are paused and whether all are; a bot is paused when
// it is named, its department is, or all are. Every way work starts asks here, beside the Starter plan's own pause (starter-caps.ts): a person's
// message, the bot API, a routine or webhook run, a hand-off from another bot, and its turn in a room.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { sectionKey } from "../store.ts";

export interface PausedState {
  bots: string[];
  departments: string[];
  /** Every bot is paused, whatever else is. Ending it leaves the bots and departments above paused. */
  all?: true;
}

export type PauseKind = "bot" | "department" | "all";

export interface BotHolds {
  /** The bot takes no new work: it, its department, or every bot is paused. */
  held(botId: string): boolean;
  /** Every paused bot, by itself, with its department or with all. */
  heldBots(): string[];
  state(): PausedState;
  /** The words a paused bot's turn is refused with, in this language; null when it is not paused. */
  text(botId: string, language?: string): string | null;
  /** What a bot that tried to hand it work is told; null when it is not paused. */
  handoff(botId: string): string | null;
  /** Pauses or resumes one bot, one department, or all bots (`id` is then unused); the bots that became paused, so their running work can be stopped. */
  set(kind: PauseKind, id: string, paused: boolean): { state: PausedState; newlyHeld: string[] };
  /** A bot or department that is gone stops being remembered. */
  forget(kind: "bot" | "department", id: string): void;
  /** A paused department that is renamed stays paused under its new name. */
  rename(from: string, to: string): void;
}

export function createBotHolds(deps: {
  dataDir: string;
  bots(): ReadonlyArray<{ id: string; name: string; section?: string }>;
  /** serverLine(language, key, params) */
  line(language: string | undefined, key: "server.botHeld" | "server.botHeldDepartment" | "server.botHeldAll", params: Record<string, string>): string;
  changed(): void;
}): BotHolds {
  const file = join(deps.dataDir, "paused-bots.json");
  let state: PausedState = load();

  function load(): PausedState {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PausedState>;
      const list = (value: unknown) => (Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200))] : []);
      return { bots: list(raw.bots), departments: list(raw.departments), ...(raw.all === true ? { all: true } : {}) };
    } catch {
      return { bots: [], departments: [] };
    }
  }

  const save = () => {
    writeFileAtomic(file, `${JSON.stringify({ v: 1, ...state }, null, 2)}\n`, { mode: 0o600 });
    deps.changed();
  };
  const bot = (botId: string) => deps.bots().find((candidate) => candidate.id === botId);
  /** The department that pauses this bot, if one does. */
  const department = (found: { section?: string } | undefined) => {
    const key = sectionKey(found?.section);
    return key && state.departments.includes(key) ? key : null;
  };
  const held = (botId: string) => state.all === true || state.bots.includes(botId) || department(bot(botId)) !== null;

  return {
    held,
    heldBots: () => deps.bots().filter((candidate) => held(candidate.id)).map((candidate) => candidate.id),
    state: () => ({ bots: [...state.bots], departments: [...state.departments], ...(state.all ? { all: true as const } : {}) }),
    text(botId, language) {
      const found = bot(botId);
      if (!found || !held(botId)) return null;
      if (state.all) return deps.line(language, "server.botHeldAll", { bot: found.name });
      const by = state.bots.includes(botId) ? null : department(found);
      return by ? deps.line(language, "server.botHeldDepartment", { bot: found.name, department: by }) : deps.line(language, "server.botHeld", { bot: found.name });
    },
    handoff(botId) {
      const found = bot(botId);
      if (!found || !held(botId)) return null;
      if (state.all) return `@${found.name} is paused by the person (every bot is paused), so nothing was handed to it. `
        + "Tell the person in one line that they can resume every bot from any bot's menu in the sidebar. Do not retry, and do not hand this to another bot to work around the pause.";
      return `@${found.name} is paused by the person${state.bots.includes(botId) ? "" : ` (its ${department(found)} department is paused)`}, so nothing was handed to it. `
        + "Tell the person in one line that they can resume it from its menu in the sidebar. Do not retry, and do not hand this to another bot to work around the pause.";
    },
    set(kind, id, paused) {
      const before = new Set(this.heldBots());
      if (kind === "all") state = { bots: state.bots, departments: state.departments, ...(paused ? { all: true as const } : {}) };
      else {
        const key = kind === "department" ? sectionKey(id) : id;
        const list = kind === "bot" ? state.bots : state.departments;
        const next = paused ? [...new Set([...list, key])] : list.filter((item) => item !== key);
        state = kind === "bot" ? { ...state, bots: next } : { ...state, departments: next };
      }
      save();
      return { state: this.state(), newlyHeld: this.heldBots().filter((botId) => !before.has(botId)) };
    },
    forget(kind, id) {
      const list = kind === "bot" ? state.bots : state.departments;
      const key = kind === "department" ? sectionKey(id) : id;
      if (!list.includes(key)) return;
      state = kind === "bot" ? { ...state, bots: list.filter((item) => item !== key) } : { ...state, departments: list.filter((item) => item !== key) };
      save();
    },
    rename(from, to) {
      const key = sectionKey(from);
      if (!state.departments.includes(key)) return;
      state = { ...state, departments: [...new Set(state.departments.map((item) => (item === key ? sectionKey(to) : item)))] };
      save();
    },
  };
}
