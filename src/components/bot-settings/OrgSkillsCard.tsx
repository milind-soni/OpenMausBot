import { Building2, Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import type { OfferedOrgSkill } from "@/lib/org-library";
import { useBotEditor } from "./BotEditorContext";

export function OrgSkillsCard({ bot, onAdded }: { bot: Bot; onAdded: () => void }) {
  const { request, draft } = useBotEditor();
  // The editor's transport may be a new function each render; the fetch must re-run only when the bot changes.
  const api = useRef(request);
  api.current = request;
  const [organization, setOrganization] = useState<string | null>(null);
  const [skills, setSkills] = useState<OfferedOrgSkill[]>([]);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async (cancelled?: () => boolean) => {
    try {
      const result = (await api.current(`/api/org-library/skills?botId=${encodeURIComponent(bot.id)}`)) as {
        organization: { name: string } | null;
        skills: OfferedOrgSkill[];
      };
      if (cancelled?.()) return;
      setOrganization(result.organization?.name ?? null);
      setSkills(result.skills ?? []);
    } catch {
      if (!cancelled?.()) setOrganization(null);
    }
  }, [bot.id]);

  useEffect(() => {
    if (draft) return;
    let cancelled = false;
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [draft, refresh]);

  if (draft || !organization || skills.length === 0) return null;

  const add = async (skill: OfferedOrgSkill) => {
    setWorking(`${skill.installId}:${skill.name}`);
    setError("");
    try {
      await api.current("/api/org-library/skills", {
        method: "POST",
        body: JSON.stringify({ botId: bot.id, installId: skill.installId, name: skill.name }),
      });
      await refresh();
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking("");
    }
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-center gap-2">
        <Building2 size={16} className="text-ink-secondary" />
        <div className="text-[15px] font-medium text-ink">{t("orgLibrary.tab", { name: organization })}</div>
      </div>
      <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("orgLibrary.skillsHint")}</div>
      <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
        {skills.map((skill) => (
          <div key={`${skill.installId}:${skill.name}`} className="flex items-center gap-2 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[13px] text-ink">{skill.name}</div>
              <div className="mt-0.5 line-clamp-2 text-[12px] text-ink-secondary">{skill.description}</div>
              <div className="mt-0.5 truncate text-[11px] text-ink-secondary">
                {t("orgLibrary.skillFrom", { package: skill.packageName, release: skill.release, publisher: skill.publisher })}
              </div>
            </div>
            {skill.added ? (
              <span className="flex shrink-0 items-center gap-1 text-[12px] text-ink-secondary">
                <Check size={13} className="text-success" />{t("orgLibrary.added")}
              </span>
            ) : (
              <button
                type="button"
                disabled={working !== ""}
                onClick={() => void add(skill)}
                aria-label={t("orgLibrary.skillAddAria", { name: skill.name })}
                className="shrink-0 rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {working === `${skill.installId}:${skill.name}` ? t("orgLibrary.adding") : t("orgLibrary.add")}
              </button>
            )}
          </div>
        ))}
      </div>
      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
