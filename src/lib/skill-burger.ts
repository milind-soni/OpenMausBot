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

/** Undo or remove. `sha256` is the copy to take away: one that changed since is refused. */
export async function removeBurger(name: string, sha256?: string): Promise<void> {
  const query = sha256 ? `?sha256=${encodeURIComponent(sha256)}` : "";
  await api(`/api/skill-burgers/${encodeURIComponent(name)}${query}`, { method: "DELETE" });
  changed();
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
export async function readBurgerWorkflow(name: string): Promise<unknown> {
  const { workflow } = await api<{ workflow: unknown }>(`/api/skill-burgers/${encodeURIComponent(name)}`);
  return workflow;
}

export async function restoreBurger(name: string, workflow: unknown): Promise<SavedWorkflow> {
  const { skill } = await api<{ skill: SavedWorkflow }>("/api/skill-burgers", { method: "POST", body: JSON.stringify({ name, workflow }) });
  changed();
  return skill;
}
