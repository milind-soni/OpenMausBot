// The client side of saved burgers: save a run, undo it, list and remove saved ones. Every list on screen listens for
// one window event, so a save in the chat shows in the bot panel at once.
import { useCallback, useEffect, useState } from "react";

import { api } from "@/state/api";
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

/** Where a saved burger is, as the API takes it: a bot's own burger by its bot, one used in every chat by name alone. */
const placeQuery = (skill: Pick<SavedWorkflow, "everyChat" | "botId">) => (skill.everyChat || !skill.botId ? "" : `botId=${encodeURIComponent(skill.botId)}`);
const path = (skill: Pick<SavedWorkflow, "name" | "everyChat" | "botId">, extra = "") => {
  const query = [placeQuery(skill), extra].filter(Boolean).join("&");
  return `/api/skill-burgers/${encodeURIComponent(skill.name)}${query ? `?${query}` : ""}`;
};

/** Undo or remove: takes away the copy with this hash; one that changed since is refused. */
export async function removeBurger(skill: Pick<SavedWorkflow, "name" | "sha256" | "everyChat" | "botId">): Promise<void> {
  await api(path(skill, `sha256=${encodeURIComponent(skill.sha256)}`), { method: "DELETE" });
  changed();
}

/** "Use in every chat": on moves the burger into the shared library for every bot, off moves it back to its bot. */
export async function setBurgerEveryChat(skill: Pick<SavedWorkflow, "name" | "sha256" | "everyChat" | "botId">, everyChat: boolean): Promise<SavedWorkflow> {
  const { skill: moved } = await api<{ skill: SavedWorkflow }>(`/api/skill-burgers/${encodeURIComponent(skill.name)}`, {
    method: "PATCH", body: JSON.stringify({ everyChat, sha256: skill.sha256, ...(skill.everyChat || !skill.botId ? {} : { botId: skill.botId }) }),
  });
  changed();
  return moved;
}

export async function renameBurger(skill: Pick<SavedWorkflow, "name" | "sha256" | "everyChat" | "botId">, to: string): Promise<SavedWorkflow> {
  const { skill: renamed } = await api<{ skill: SavedWorkflow }>(`/api/skill-burgers/${encodeURIComponent(skill.name)}`, {
    method: "PATCH", body: JSON.stringify({ rename: to, sha256: skill.sha256, ...(skill.everyChat || !skill.botId ? {} : { botId: skill.botId }) }),
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
export async function readBurgerWorkflow(skill: Pick<SavedWorkflow, "name" | "everyChat" | "botId">): Promise<unknown> {
  const { workflow } = await api<{ workflow: unknown }>(path(skill));
  return workflow;
}

/** Puts a removed burger back where it was. */
export async function restoreBurger(skill: Pick<SavedWorkflow, "name" | "everyChat" | "botId">, workflow: unknown): Promise<SavedWorkflow> {
  const { skill: restored } = await api<{ skill: SavedWorkflow }>("/api/skill-burgers", {
    method: "POST", body: JSON.stringify({ name: skill.name, workflow, ...(skill.botId ? { botId: skill.botId } : {}), ...(skill.everyChat ? { everyChat: true } : {}) }),
  });
  changed();
  return restored;
}

/** The top bun's one line for a finished run, from the bot's small text model; null when there is none. */
export async function fetchBurgerSummary(botId: string, threadId: string): Promise<string | null> {
  try {
    const { summary } = await api<{ summary: string | null }>("/api/skill-burger-summary", { method: "POST", body: JSON.stringify({ botId, threadId }) });
    return typeof summary === "string" && summary ? summary : null;
  } catch {
    return null;
  }
}

/** Runs saved in this window, by run: a card that comes back (another chat opened, then this one) shows the save. */
const savedRuns = new Map<string, SavedWorkflow>();
export const savedRun = (run: string) => savedRuns.get(run);
export function rememberSavedRun(run: string, skill: SavedWorkflow | null): void {
  if (skill) savedRuns.set(run, skill);
  else savedRuns.delete(run);
}
