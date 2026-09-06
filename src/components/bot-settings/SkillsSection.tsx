// Skills: durable behavior the bot learned or imported, so the user needs a
// normal way to inspect, disable, and remove it after the one-time approval
// card is gone. Moved from SettingsPanel.tsx's LearnedSkillsCard (79-295),
// its nested review dialog raised from z-[80] to z-[90] to float above this
// dialog's own z-50, plus: an Import from GitHub row, a static "when it's
// used" line on every row (learned skills have no triggers to show), and a
// read-only click-through view of a skill's full text.
import { BookOpen, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, useStore, type Bot } from "@/state/store";
import { skillRecorderEnabled } from "@/lib/feature-flags";
import { Switch } from "../SettingsPrimitives";
import { inputCls } from "./field";

interface ManagedSkill {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  warnings: string[];
}

interface StagedSkillSummary {
  id: string;
  name: string;
  gist: string;
}

export function SkillsSection({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const featureEnabled = skillRecorderEnabled(state.config);
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [staged, setStaged] = useState<StagedSkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState<{ skill: ManagedSkill; text: string } | null>(null);
  const [viewing, setViewing] = useState<{ name: string; text: string } | null>(null);
  const [source, setSource] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const skillDialogRef = useRef<HTMLDivElement>(null);
  const skillDialogOpen = Boolean(viewing || reviewing);

  useEffect(() => {
    if (!skillDialogOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = skillDialogRef.current;
    const parentDialog = dialog?.parentElement?.closest<HTMLElement>('[role="dialog"]');
    dialog?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!working) {
          setViewing(null);
          setReviewing(null);
        }
      }
      if (event.key !== "Tab" || !dialog) return;
      const controls = dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]');
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previousFocus && previousFocus !== document.body && previousFocus.isConnected) previousFocus.focus();
      else parentDialog?.focus();
    };
  }, [skillDialogOpen, working]);

  const refresh = async (cancelled?: () => boolean) => {
    try {
      const result = (await api(`/api/bots/${bot.id}/skills`)) as {
        skills?: ManagedSkill[];
        staged?: StagedSkillSummary[];
      };
      if (cancelled?.()) return;
      setSkills(result.skills ?? []);
      setStaged(result.staged ?? []);
      setError("");
    } catch (cause) {
      if (!cancelled?.()) setError(cause instanceof Error ? cause.message : "Could not load learned skills.");
    } finally {
      if (!cancelled?.()) setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReviewing(null);
    setViewing(null);
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [bot.id]);

  const toggle = async (skill: ManagedSkill) => {
    setWorking(skill.name);
    setError("");
    try {
      if (!skill.enabled) {
        // A disabled import has not necessarily been reviewed. Fetch the
        // integrity-checked bytes and require one explicit review step before
        // they can reach the bot's prompt or native skill discovery.
        const result = (await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`)) as { text?: string };
        if (!result.text) throw new Error("The skill contents are unavailable; remove and import or learn it again.");
        setReviewing({ skill, text: result.text });
        return;
      }
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this skill.");
    } finally {
      setWorking("");
    }
  };

  const enableReviewed = async () => {
    if (!reviewing) return;
    const { skill } = reviewing;
    setWorking(skill.name);
    setError("");
    try {
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      });
      setReviewing(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not enable this skill.");
    } finally {
      setWorking("");
    }
  };

  const remove = async (skill: ManagedSkill) => {
    if (!window.confirm(`Remove the learned skill “${skill.name}”?`)) return;
    setWorking(skill.name);
    setError("");
    try {
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove this skill.");
    } finally {
      setWorking("");
    }
  };

  const view = async (skill: ManagedSkill) => {
    setError("");
    try {
      const result = (await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`)) as { text?: string };
      setViewing({ name: skill.name, text: result.text ?? "" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this skill.");
    }
  };

  const importSkill = async () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    setImporting(true);
    setError("");
    setImportMessage("");
    try {
      const result = (await api(`/api/bots/${bot.id}/skills`, {
        method: "POST",
        body: JSON.stringify({ source: trimmed }),
      })) as { installed?: unknown[] };
      const count = (result.installed ?? []).length;
      setImportMessage(`Imported ${count} skill${count === 1 ? "" : "s"} — review and enable below.`);
      setSource("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import that skill.");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4">
        <div className="flex items-center gap-2">
          <BookOpen size={16} className="text-ink-secondary" />
          <div className="text-[15px] font-medium text-ink">Learned skills</div>
        </div>
        <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {featureEnabled
            ? "Use /learn to create a skill, or /learn update <name> to revise one. Every change waits for your review."
            : "Skill authoring is off, but skills you already enabled stay under your control here."}
        </div>

        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void importSkill();
          }}
        >
          <input
            className={inputCls}
            placeholder="owner/repo or https://github.com/…/SKILL.md"
            aria-label="Import a skill from GitHub"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <button
            type="submit"
            disabled={importing || !source.trim()}
            className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {importing ? "Importing…" : "Import"}
          </button>
        </form>
        {importMessage && <div className="mt-1 text-[12px] text-ink-secondary">{importMessage}</div>}

        {loading ? (
          <div className="mt-3 text-[12px] text-ink-secondary">Loading…</div>
        ) : skills.length === 0 ? (
          <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">No installed skills yet.</div>
        ) : (
          <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
            {skills.map((skill) => (
              <div key={skill.name} className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void view(skill)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate font-mono text-[12.5px] text-ink">{skill.name}</div>
                    <div className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-secondary">{skill.description}</div>
                    <div className="mt-0.5 text-[10.5px] text-ink-secondary">Used when the bot decides it's relevant</div>
                  </button>
                  <Switch
                    checked={skill.enabled}
                    aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                    disabled={working === skill.name}
                    onClick={() => void toggle(skill)}
                  />
                  <button
                    aria-label={`Remove ${skill.name}`}
                    title="Remove skill"
                    disabled={working === skill.name}
                    onClick={() => void remove(skill)}
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <div className="mt-1 truncate text-[10.5px] text-ink-secondary" title={skill.source}>Source: {skill.source}</div>
                {skill.warnings.length > 0 && (
                  <div className="mt-1 text-[10.5px] text-warning">{skill.warnings.join(" · ")}</div>
                )}
              </div>
            ))}
          </div>
        )}
        {staged.length > 0 && (
          <div className="mt-2 text-[11.5px] text-warning">
            {staged.length} proposal{staged.length === 1 ? " is" : "s are"} waiting for a decision in chat.
          </div>
        )}
        {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
      </div>

      {reviewing && (
        <div
          ref={skillDialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="skill-review-title"
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-6"
        >
          <div className="flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col rounded-2xl bg-card p-5 shadow-2xl">
            <div id="skill-review-title" className="text-[16px] font-semibold text-ink">
              Review {reviewing.skill.name} before enabling
            </div>
            <div className="mt-1 break-all text-[11.5px] text-ink-secondary">
              Source: {reviewing.skill.source}
            </div>
            {reviewing.skill.warnings.length > 0 && (
              <div className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] text-warning">
                {reviewing.skill.warnings.join(" · ")}
              </div>
            )}
            <pre
              tabIndex={0}
              aria-label={`Full SKILL.md for ${reviewing.skill.name}`}
              className="mt-3 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink"
            >
              {reviewing.text}
            </pre>
            {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={working === reviewing.skill.name}
                onClick={() => setReviewing(null)}
                className="rounded-lg px-4 py-2 text-[13px] font-medium text-ink-secondary hover:bg-raised disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={working === reviewing.skill.name}
                onClick={() => void enableReviewed()}
                className="rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                Enable reviewed skill
              </button>
            </div>
          </div>
        </div>
      )}

      {viewing && (
        <div
          ref={skillDialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="skill-view-title"
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-6"
        >
          <div className="flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col rounded-2xl bg-card p-5 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div id="skill-view-title" className="text-[16px] font-semibold text-ink">{viewing.name}</div>
              <button
                type="button"
                onClick={() => setViewing(null)}
                className="rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
              >
                Close
              </button>
            </div>
            <pre
              tabIndex={0}
              aria-label={`Full SKILL.md for ${viewing.name}`}
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
