import { useCallback, useEffect, useState } from "react";
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

export function useSlashSkills(botId: string | undefined, threadId: string, active: boolean): {
  skills: SlashSkill[];
  status: "idle" | "loading" | "ready" | "error";
  retry: () => void;
} {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const [result, setResult] = useState<{ botId: string; threadId: string; skills: SlashSkill[]; status: "ready" | "error" } | null>(null);
  useEffect(() => {
    if (!botId || !active) return;
    let cancelled = false;
    api(`/api/bots/${botId}/slash-skills?threadId=${encodeURIComponent(threadId)}`)
      .then(body => {
        if (!cancelled) setResult({ botId, threadId, skills: enabledSlashSkills(body as SkillsResponse), status: "ready" });
      })
      .catch(() => {
        if (!cancelled) setResult({ botId, threadId, skills: [], status: "error" });
      });
    return () => { cancelled = true; setResult(null); };
  }, [botId, threadId, active, attempt]);
  if (!botId || !active) return { skills: [], status: "idle", retry };
  if (!result || result.botId !== botId || result.threadId !== threadId) return { skills: [], status: "loading", retry };
  return { skills: result.skills, status: result.status, retry };
}
