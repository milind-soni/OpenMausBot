import { useEffect, useState } from "react";
import { api } from "@/state/store";
import type { SlashSkill } from "./composer-commands";

interface SkillsResponse {
  skills?: Array<{ name?: unknown; description?: unknown; enabled?: unknown }>;
}

export function enabledSlashSkills(body: SkillsResponse | null | undefined): SlashSkill[] {
  return (body?.skills ?? []).flatMap((skill) =>
    skill.enabled === true && typeof skill.name === "string"
      ? [{ name: skill.name, description: typeof skill.description === "string" ? skill.description : "" }]
      : []);
}

export function useSlashSkills(botId: string | undefined, threadId: string, active: boolean): SlashSkill[] {
  const [skills, setSkills] = useState<{ botId: string; list: SlashSkill[] } | null>(null);
  useEffect(() => {
    if (!botId || !active) return;
    let cancelled = false;
    api(`/api/bots/${botId}/skills?threadId=${encodeURIComponent(threadId)}`)
      .then((body) => { if (!cancelled) setSkills({ botId, list: enabledSlashSkills(body as SkillsResponse) }); })
      .catch(() => { if (!cancelled) setSkills({ botId, list: [] }); });
    return () => {
      cancelled = true;
      setSkills(null);
    };
  }, [botId, threadId, active]);
  return active && skills && skills.botId === botId ? skills.list : [];
}
