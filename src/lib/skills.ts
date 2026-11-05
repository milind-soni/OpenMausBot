import { useCallback, useEffect, useRef, useState } from "react";

import type { LocaleKey } from "@/locales";
import { api } from "@/state/api";
import { skillTitle, type AddSkillWire, type SkillDetailWire, type SkillFlag, type SkillFrom, type SkillWho, type SkillWire } from "../../shared/skill-catalog";
import type { SkillImportSummary } from "../../shared/skill-import";
import type { WrittenSkillProblem } from "../../shared/written-skill";
import { t } from "./i18n";

export { skillTitle, type SkillWire } from "../../shared/skill-catalog";

/** Search shows only once the list is longer than this. */
export const SKILLS_SEARCH_FROM = 8;

const path = (id: string) => `/api/skills/${encodeURIComponent(id)}`;

export function fromLabel(from: SkillFrom, botName: (id: string) => string | undefined): string {
  switch (from.kind) {
    case "builtin": return t("skills.from.builtin");
    case "github": return t("skills.from.github");
    case "link": return t("skills.from.link");
    case "written": return t("skills.from.written");
    case "team": return t("skills.from.team");
    case "project": return t("skills.from.project");
    case "tool": return t("skills.from.tool", { tool: from.tool === "codex" ? "Codex" : "Claude Code" });
    case "learned": {
      const bot = from.botId ? botName(from.botId) : undefined;
      return bot ? t("skills.from.learned", { bot }) : t("skills.from.learnedAny");
    }
  }
}

export function whoLabel(who: SkillWho, users: readonly string[], botName: (id: string) => string | undefined, team: boolean): string {
  if (who === "all") return t(team ? "skills.who.team" : "skills.who.all");
  if (who === "off" || users.length === 0) return t("skills.who.off");
  return users.length === 1 ? (botName(users[0]!) ?? t("skills.who.count", { count: 1 })) : t("skills.who.count", { count: users.length });
}

export const FLAG_KEY: Record<SkillFlag, LocaleKey> = {
  blob: "skills.flag.blob",
  pipe: "skills.flag.pipe",
  invisible: "skills.flag.invisible",
  changed: "skills.flag.changed",
  other: "skills.flag.other",
};

export const WRITE_PROBLEM_KEY: Record<WrittenSkillProblem, LocaleKey> = {
  name: "skills.write.problem.name",
  reserved: "skills.write.problem.reserved",
  taken: "skills.write.problem.taken",
  description: "skills.write.problem.description",
  instructions: "skills.write.problem.instructions",
};

export function matchesSkill(skill: SkillWire, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [skill.name, skillTitle(skill), skill.description].some((part) => part.toLowerCase().includes(q));
}

export const readSkill = (id: string) => api<SkillDetailWire>(path(id));

export const addSkill = (body: AddSkillWire) =>
  api<{ added: string[]; imported?: SkillImportSummary[] }>("/api/skills", { method: "POST", body: JSON.stringify(body) });

/** Every skill, and a bot's skills from its working folder when `botId` is given. Changes go one at a time. */
export function useSkills(botId?: string) {
  const [skills, setSkills] = useState<SkillWire[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const query = botId ? `?bot=${encodeURIComponent(botId)}` : "";

  const refresh = useCallback(async () => {
    try {
      const body = await api<{ skills: SkillWire[] }>(`/api/skills${query}`);
      setSkills(body.skills);
    } catch {
      setError(t("skills.loadFailed"));
      setSkills((current) => current ?? []);
    }
  }, [query]);

  useEffect(() => {
    setSkills(null);
    void refresh();
  }, [refresh]);

  const run = async (work: () => Promise<unknown>, failed: (cause: unknown) => string = () => t("skills.saveFailed")) => {
    if (working.current) return false;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      return true;
    } catch (cause) {
      setError(failed(cause));
      return false;
    } finally {
      await refresh();
      working.current = false;
      setBusy(false);
    }
  };
  const stays = (cause: unknown) =>
    (cause as { body?: { code?: string } })?.body?.code === "stays" ? t("skills.staysWithBot") : t("skills.saveFailed");

  return {
    skills, error, busy, refresh,
    setWho: (skill: SkillWire, who: SkillWho, bots: readonly string[] = []) =>
      run(() => api(`${path(skill.id)}/access`, { method: "PUT", body: JSON.stringify({ who, bots }) }), stays),
    setForBot: (skill: SkillWire, bot: string, on: boolean) =>
      run(() => api(`${path(skill.id)}/bots/${encodeURIComponent(bot)}`, { method: "PUT", body: JSON.stringify({ on }) }), stays),
    remove: (skill: SkillWire) => run(() => api(path(skill.id), { method: "DELETE" })),
  };
}
