// App settings → Skills: the shared skills library (features.skillsLibrary).
// One place to browse every skill on this machine, see which bots use each,
// assign and remove with one click, and import new skills as pasted text.
// Local browse only by design: no registry and no network fetch of any kind
// (the skills.sh question, #1782, is still open upstream), so an import is
// exactly the bytes pasted here.
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { Card, Switch } from "./SettingsPrimitives";
import type { SkillsLibrarySkillWire } from "../../shared/wire";

/** Pure browse filter: the query matches name, description and source;
 * the tag narrows to rows carrying it. Exported for the component test. */
export function filterLibrarySkills(
  skills: readonly SkillsLibrarySkillWire[],
  query: string,
  tag: string | null,
): SkillsLibrarySkillWire[] {
  const q = query.trim().toLowerCase();
  return skills.filter((skill) => {
    if (tag && !skill.tags.includes(tag)) return false;
    if (!q) return true;
    return [skill.name, skill.description, skill.source].some((part) => part.toLowerCase().includes(q));
  });
}

/** The chip row under a skill: source, version, import date, tags. Kept as a
 * pure exported piece so the test can render it without a store. */
export function LibrarySkillMeta({ skill }: { skill: SkillsLibrarySkillWire }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-secondary">
      <span className="truncate" title={skill.source}>Source: {skill.source}</span>
      <span>{skill.version ? t("skills.library.version", { version: skill.version }) : t("skills.library.noVersion")}</span>
      <span>{t("skills.library.importedAt", { date: new Date(skill.importedAt).toLocaleDateString() })}</span>
      {skill.tags.map((tag) => (
        <span key={tag} className="rounded bg-control px-1.5 py-0.5 font-mono">{tag}</span>
      ))}
    </div>
  );
}

export function SkillsSection() {
  const { state } = useStore();
  const [skills, setSkills] = useState<SkillsLibrarySkillWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ name: string; text: string } | null>(null);
  const [working, setWorking] = useState("");
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [assignBot, setAssignBot] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  const bots = state.bots.filter((bot) => !bot.hidden);
  const tags = useMemo(
    () => [...new Set(skills.flatMap((skill) => skill.tags))].sort((a, b) => a.localeCompare(b)),
    [skills],
  );
  const visible = filterLibrarySkills(skills, query, activeTag);

  const refresh = async (cancelled?: () => boolean) => {
    try {
      const response = await fetch("/api/skills-library");
      const body = (await response.json()) as { skills?: SkillsLibrarySkillWire[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? t("skills.library.loadError"));
      if (cancelled?.()) return;
      setSkills(body.skills ?? []);
      setError("");
    } catch (cause) {
      if (!cancelled?.()) setError(cause instanceof Error ? cause.message : t("skills.library.loadError"));
    } finally {
      if (!cancelled?.()) setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!viewing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setViewing(null);
      }
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  /** A bot's assignment list, rebuilt from the browse rows. Assignments can
   * only name library entries, so this is the full list, not a subset. */
  const assignmentsFor = (botId: string) =>
    skills.filter((skill) => skill.assignedBots.some((bot) => bot.id === botId)).map((skill) => skill.name);

  const putAssignments = async (botId: string, next: string[], label: string) => {
    setWorking(label);
    setError("");
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/skills-library`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skills: next }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not update assignments.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update assignments.");
    } finally {
      setWorking("");
    }
  };

  const assign = async (skill: SkillsLibrarySkillWire) => {
    if (!assignBot) return;
    await putAssignments(assignBot, [...new Set([...assignmentsFor(assignBot), skill.name])], `${skill.name}:${assignBot}`);
  };

  const unassign = async (skill: SkillsLibrarySkillWire, botId: string) => {
    await putAssignments(botId, assignmentsFor(botId).filter((name) => name !== skill.name), `${skill.name}:${botId}`);
  };

  const toggle = async (skill: SkillsLibrarySkillWire) => {
    setWorking(skill.name);
    setError("");
    try {
      const response = await fetch(`/api/skills-library/${encodeURIComponent(skill.name)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !skill.enabled }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not update this skill.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this skill.");
    } finally {
      setWorking("");
    }
  };

  const view = async (skill: SkillsLibrarySkillWire) => {
    setError("");
    try {
      const response = await fetch(`/api/skills-library/${encodeURIComponent(skill.name)}`);
      const body = (await response.json()) as { text?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load this skill.");
      setViewing({ name: skill.name, text: body.text ?? "" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this skill.");
    }
  };

  const importSkill = async () => {
    const text = importText.trim();
    if (!text) return;
    setImporting(true);
    setError("");
    setImportMessage("");
    try {
      const response = await fetch("/api/skills-library", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = (await response.json()) as { skill?: { name: string }; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not import that skill.");
      setImportMessage(t("skills.library.imported", { name: body.skill?.name ?? "" }));
      setImportText("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import that skill.");
    } finally {
      setImporting(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  return (
    <div className="flex flex-col gap-4">
      <Card title={t("skills.library.title")} subtitle={t("skills.library.subtitle")}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Search size={15} className="shrink-0 text-ink-secondary" />
            <input
              className={inputClass}
              placeholder={t("skills.library.searchPlaceholder")}
              aria-label={t("skills.library.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setActiveTag(null)}
                className={
                  activeTag === null
                    ? "rounded-full bg-control px-2.5 py-1 text-[11.5px] font-medium text-ink"
                    : "rounded-full px-2.5 py-1 text-[11.5px] text-ink-secondary hover:bg-control/50 hover:text-ink"
                }
              >
                {t("skills.library.allTags")}
              </button>
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                  className={
                    activeTag === tag
                      ? "rounded-full bg-control px-2.5 py-1 font-mono text-[11.5px] font-medium text-ink"
                      : "rounded-full px-2.5 py-1 font-mono text-[11.5px] text-ink-secondary hover:bg-control/50 hover:text-ink"
                  }
                >
                  {tag}
                </button>
              ))}
            </div>
          )}

          {loading ? (
            <div className="text-[12px] text-ink-secondary">{t("skills.library.loading")}</div>
          ) : visible.length === 0 ? (
            <div className="rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">
              {skills.length === 0 ? t("skills.library.empty") : t("skills.library.noMatches")}
            </div>
          ) : (
            <div className="divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
              {visible.map((skill) => (
                <div key={skill.name} className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => void view(skill)} className="min-w-0 flex-1 text-left" aria-label={t("skills.library.view", { skill: skill.name })}>
                      <div className="truncate font-mono text-[12.5px] text-ink">{skill.name}</div>
                      <div className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-secondary">{skill.description}</div>
                    </button>
                    <Switch
                      checked={skill.enabled}
                      aria-label={skill.enabled ? t("skills.library.disable", { skill: skill.name }) : t("skills.library.enable", { skill: skill.name })}
                      disabled={working === skill.name}
                      onClick={() => void toggle(skill)}
                    />
                  </div>
                  <LibrarySkillMeta skill={skill} />
                  {skill.warnings.length > 0 && (
                    <div className="mt-1 text-[10.5px] text-warning">{skill.warnings.join(" · ")}</div>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-secondary">
                    {skill.assignedBots.length === 0 ? (
                      <span>{t("skills.library.notAssigned")}</span>
                    ) : (
                      skill.assignedBots.map((bot) => (
                        <span key={bot.id} className="flex items-center gap-1 rounded-full bg-control px-2 py-0.5">
                          <span className="max-w-40 truncate">{bot.name}</span>
                          <button
                            type="button"
                            aria-label={t("skills.library.removeAssignment", { bot: bot.name })}
                            title={t("skills.library.removeAssignment", { bot: bot.name })}
                            disabled={working === `${skill.name}:${bot.id}`}
                            onClick={() => void unassign(skill, bot.id)}
                            className="flex size-4 items-center justify-center rounded-full text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ))
                    )}
                  </div>
                  {bots.length > 0 && (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <select
                        aria-label={t("skills.library.assignLabel")}
                        value={assignBot}
                        onChange={(e) => setAssignBot(e.target.value)}
                        className="max-w-45 truncate rounded-lg border border-hairline/40 bg-inset px-2 py-1 text-[11.5px] text-ink"
                      >
                        <option value="">{t("skills.library.assignPickBot")}</option>
                        {bots.map((bot) => (
                          <option key={bot.id} value={bot.id}>{bot.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={!assignBot || working === `${skill.name}:${assignBot}`}
                        onClick={() => void assign(skill)}
                        className="rounded-lg bg-control px-2.5 py-1 text-[11.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
                      >
                        {t("skills.library.assign")}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
        </div>
      </Card>

      <Card title={t("skills.library.importTitle")} subtitle={t("skills.library.importHint")}>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void importSkill();
          }}
        >
          <textarea
            className={`${inputClass} min-h-32 font-mono text-[12px]`}
            placeholder={t("skills.library.importPlaceholder")}
            aria-label={t("skills.library.importTitle")}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            {importMessage ? <div className="text-[12px] text-ink-secondary">{importMessage}</div> : <span />}
            <button
              type="submit"
              disabled={importing || !importText.trim()}
              className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {importing ? t("skills.library.importing") : t("skills.library.importButton")}
            </button>
          </div>
        </form>
      </Card>

      {viewing && (
        <div
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="skills-library-view-title"
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-6"
        >
          <div className="flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col rounded-2xl bg-card p-5 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div id="skills-library-view-title" className="text-[16px] font-semibold text-ink">{viewing.name}</div>
              <button
                type="button"
                onClick={() => setViewing(null)}
                className="rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
              >
                {t("skills.library.close")}
              </button>
            </div>
            <pre
              tabIndex={0}
              aria-label={`${t("skills.library.view", { skill: viewing.name })}`}
              className="mt-3 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink"
            >
              {viewing.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
