// The client side of saved burgers: save a run, undo it, list and remove saved ones. Every list on screen listens for
// one window event, so a save in the chat shows in the bot panel at once.
import { useCallback, useEffect, useState } from "react";

import { api } from "@/state/api";
import type { Workflow } from "../../shared/skill-burger/format";
import type { BurgerLayer } from "../../shared/skill-burger/layers";
import type { SavedWorkflow } from "../../shared/skill-burger/saved";

export type { SavedWorkflow };

const CHANGED = "omb:skill-burgers-changed";
/** A browser where someone switched the run list off starts each burger folded to its top bun. */
export const RUN_CARD_KEY = "omb-show-run-card";

export function burgerStartsFolded(): boolean {
  try {
    return globalThis.localStorage?.getItem(RUN_CARD_KEY) === "0";
  } catch {
    return false;
  }
}

function changed(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED));
}

export async function saveBurger(input: { botId: string; threadId: string; summary?: string; name?: string }): Promise<SavedWorkflow> {
  const { skill } = await api<{ skill: SavedWorkflow }>("/api/skill-burgers", { method: "POST", body: JSON.stringify(input) });
  changed();
  return skill;
}

const path = (name: string, query = "") => `/api/skill-burgers/${encodeURIComponent(name)}${query ? `?${query}` : ""}`;

/** Undo or remove: takes away the copy with this hash; one that changed since is refused. */
export async function removeBurger(skill: Pick<SavedWorkflow, "name" | "sha256">): Promise<void> {
  await api(path(skill.name, `sha256=${encodeURIComponent(skill.sha256)}`), { method: "DELETE" });
  changed();
}

export async function renameBurger(skill: Pick<SavedWorkflow, "name" | "sha256">, to: string): Promise<SavedWorkflow> {
  const { skill: renamed } = await api<{ skill: SavedWorkflow }>(path(skill.name), {
    method: "PATCH", body: JSON.stringify({ rename: to, sha256: skill.sha256 }),
  });
  changed();
  return renamed;
}

export function useSavedBurgers(): { skills: SavedWorkflow[] | null; error: boolean; refresh: () => void } {
  const [skills, setSkills] = useState<SavedWorkflow[] | null>(null);
  const [error, setError] = useState(false);
  const refresh = useCallback(() => {
    api<{ skills: SavedWorkflow[] }>("/api/skill-burgers")
      .then((result) => { setSkills(result.skills); setError(false); })
      .catch(() => setError(true));
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener(CHANGED, refresh);
    return () => window.removeEventListener(CHANGED, refresh);
  }, [refresh]);
  return { skills, error, refresh };
}

/** The saved workflow itself, read before a removal so its Undo can put it back. */
export async function readBurgerWorkflow(skill: Pick<SavedWorkflow, "name">): Promise<unknown> {
  const { workflow } = await api<{ workflow: unknown }>(path(skill.name));
  return workflow;
}

/** Puts a removed burger back under its name. */
export async function restoreBurger(skill: Pick<SavedWorkflow, "name" | "botId">, workflow: unknown): Promise<SavedWorkflow> {
  const { skill: restored } = await api<{ skill: SavedWorkflow }>("/api/skill-burgers", {
    method: "POST", body: JSON.stringify({ name: skill.name, workflow, ...(skill.botId ? { botId: skill.botId } : {}) }),
  });
  changed();
  return restored;
}

/** The run's name from the small model, and, for a run that handed work to teammates, the steps a save keeps (their
 * work brought in as this bot's own), which this chat alone doesn't show. */
export async function fetchBurgerSummary(botId: string, threadId: string): Promise<{ summary: string | null; layers?: BurgerLayer[] }> {
  try {
    const { summary, layers } = await api<{ summary: string | null; layers?: BurgerLayer[] }>("/api/skill-burger-summary", { method: "POST", body: JSON.stringify({ botId, threadId }) });
    return { summary: typeof summary === "string" && summary ? summary : null, ...(Array.isArray(layers) ? { layers } : {}) };
  } catch {
    return { summary: null };
  }
}

/** Runs saved in this window, by run: a card that comes back (another chat opened, then this one) shows the save. */
const savedRuns = new Map<string, SavedWorkflow>();
export const savedRun = (run: string) => savedRuns.get(run);
export function rememberSavedRun(run: string, skill: SavedWorkflow | null): void {
  if (skill) savedRuns.set(run, skill);
  else savedRuns.delete(run);
}

/** A Skill Burger as `botId` would run it by name. */
export async function fetchRunnable(name: string, botId: string): Promise<{ workflow: Workflow } | null> {
  try {
    return await api<{ workflow: Workflow }>(path(name, `runner=${encodeURIComponent(botId)}`));
  } catch {
    return null;
  }
}

/** What Run sends: the burger's own slash command, which the bot runs with its run_workflow tool. */
export const runCommand = (name: string) => `/${name}`;

/** One tap's "Add the path": the steps the bot did by judgement for a case nobody had saved become that case's steps. */
export async function addBurgerPath(input: { name: string; runBotId: string; threadId: string; run: string; decide: string; case: string }): Promise<{ skill: SavedWorkflow; undo: string }> {
  const { name, ...rest } = input;
  const result = await api<{ skill: SavedWorkflow; undo: string }>(`/api/skill-burgers/${encodeURIComponent(name)}/paths`, {
    method: "POST", body: JSON.stringify(rest),
  });
  changed();
  return result;
}

/** Undo of a change to a burger's steps. */
export async function undoBurgerEdit(input: { name: string; undo: string }): Promise<void> {
  await api(path(input.name), { method: "PATCH", body: JSON.stringify({ undo: input.undo }) });
  changed();
}

/** The burger `botId` runs by `name`, read again whenever a burger changes. */
export function useRunnable(name: string | null, botId: string): { workflow: Workflow } | null {
  const [found, setFound] = useState<{ key: string; value: { workflow: Workflow } | null } | null>(null);
  const key = name ? `${botId}:${name}` : "";
  useEffect(() => {
    if (!name) return;
    let current = true;
    const read = () => { void fetchRunnable(name, botId).then((value) => { if (current) setFound({ key: `${botId}:${name}`, value }); }); };
    read();
    window.addEventListener(CHANGED, read);
    return () => { current = false; window.removeEventListener(CHANGED, read); };
  }, [name, botId]);
  return found?.key === key ? found.value : null;
}

type RunDispatch = (action: { type: "select"; id: string } | { type: "send"; botId: string; text: string; threadId: string }) => void;

/** Run: opens the bot's chat and sends the burger's slash command there, as a person would type it. */
export function runBurgerIn(dispatch: RunDispatch, bot: { id: string; threadId: string }, name: string): void {
  dispatch({ type: "select", id: bot.id });
  dispatch({ type: "send", botId: bot.id, text: runCommand(name), threadId: bot.threadId });
}
