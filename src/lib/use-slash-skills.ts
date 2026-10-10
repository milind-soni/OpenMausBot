import { useEffect, useState } from "react";
import { api } from "@/state/store";
import type { SlashSkill } from "./composer-commands";

interface SkillsResponse {
  skills?: Array<{ name?: unknown; description?: unknown; enabled?: unknown }>;
}

/** Enabled skills from a `GET /api/bots/:id/skills` body, as menu rows. */
export function enabledSlashSkills(body: SkillsResponse | null | undefined): SlashSkill[] {
  return (body?.skills ?? []).flatMap((skill) =>
    skill.enabled === true && typeof skill.name === "string"
      ? [{ name: skill.name, description: typeof skill.description === "string" ? skill.description : "" }]
      : []);
}

/** A bot's enabled skills for the slash menu. Loaded when the menu opens
 * (`active`), and again each time it reopens, so a skill switched on or off
 * in settings shows the right way without a reload. Closing the menu drops
 * the list, so a stale one never shows while the next load runs. A failed
 * load just lists none. */
export function useSlashSkills(botId: string | undefined, active: boolean): SlashSkill[] {
  const [skills, setSkills] = useState<{ botId: string; list: SlashSkill[] } | null>(null);
  useEffect(() => {
    if (!botId || !active) return;
    let cancelled = false;
    api(`/api/bots/${botId}/skills`)
      .then((body) => { if (!cancelled) setSkills({ botId, list: enabledSlashSkills(body as SkillsResponse) }); })
      .catch(() => { if (!cancelled) setSkills({ botId, list: [] }); });
    return () => {
      cancelled = true;
      setSkills(null);
    };
  }, [botId, active]);
  return active && skills && skills.botId === botId ? skills.list : [];
}
