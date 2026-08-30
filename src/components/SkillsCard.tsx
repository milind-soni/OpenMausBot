// Imported Agent Skills, per bot — the review gate over server/skills.ts.
//
// The server imports skills DISABLED and records provenance plus scan
// warnings; this card is where a person reads the exact SKILL.md text and
// those warnings, then enables. Two rules the layout enforces:
//   - imported content renders as PLAIN TEXT, never markdown. A skill is
//     untrusted input, and a markdown renderer is exactly the surface a
//     malicious import would style itself for — what you read here is
//     byte-for-byte what the bot will read.
//   - enabling is a button a person presses with the text on screen.
//     Nothing enables as a side effect of importing.
import { AlertTriangle, ChevronDown, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";

/** Mirror of the server's SkillListing (server/skills.ts). */
export interface BotSkill {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  sha256: string;
  importedAt: string;
  license?: string;
  compatibility?: string;
  warnings: string[];
  skippedFiles: string[];
}

/** One line answering "where did this come from": the source as imported plus
 * enough of the content hash to compare against a fresh fetch. */
export function provenanceLine(skill: Pick<BotSkill, "source" | "sha256">): string {
  return `${skill.source} · ${skill.sha256.slice(0, 8)}`;
}

export function warningBadgeLabel(count: number): string {
  return count === 1 ? "1 warning" : `${count} warnings`;
}

/** Fold a POST's installed skills into the list the GET produced: replace by
 * name (a re-import must show its new scan results, not the stale row) and
 * keep the server's name sort so rows never jump on the next refresh. */
export function mergeInstalled(existing: BotSkill[], installed: BotSkill[]): BotSkill[] {
  const byName = new Map(existing.map((skill) => [skill.name, skill] as const));
  for (const skill of installed) byName.set(skill.name, skill);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function removeSkillConfirmation(name: string): string {
  return `Remove the imported skill “${name}”? Its files are deleted from this bot's workspace.`;
}

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

interface Review {
  name: string;
  /** null while the SKILL.md fetch is in flight */
  text: string | null;
}

/** The Skills card in a bot's settings. Fetched on expand, like MemoryCard:
 * settings opens for every bot and most visits never look at skills. */
export function SkillsCard({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<BotSkill[]>([]);
  const [source, setSource] = useState("");
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  /** name of the skill an enable/disable/remove call is in flight for */
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setReview(null);
    try {
      const result: { skills: BotSkill[] } = await api(`/api/bots/${bot.id}/skills`);
      setSkills(result.skills);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const openReview = async (name: string) => {
    if (review?.name === name) {
      setReview(null);
      return;
    }
    setError(null);
    setReview({ name, text: null });
    try {
      const result: { text: string } = await api(`/api/bots/${bot.id}/skills/${name}`);
      setReview((current) => (current?.name === name ? { name, text: result.text } : current));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReview((current) => (current?.name === name ? null : current));
    }
  };

  const importSkills = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = source.trim();
    if (!trimmed || importing) return;
    setImporting(true);
    setError(null);
    setImportErrors([]);
    try {
      const result: { installed: BotSkill[]; errors: string[] } = await api(`/api/bots/${bot.id}/skills`, {
        method: "POST",
        body: JSON.stringify({ source: trimmed }),
      });
      setSkills((current) => mergeInstalled(current, result.installed));
      setImportErrors(result.errors);
      setSource("");
      // the review gate is the point: put the first import's SKILL.md and
      // warnings on screen right away, with Enable at the end of the read
      const first = result.installed[0];
      if (first) void openReview(first.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const setEnabled = async (name: string, enabled: boolean) => {
    setBusy(name);
    setError(null);
    try {
      const result: { skill: BotSkill } = await api(`/api/bots/${bot.id}/skills/${name}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      setSkills((current) => current.map((skill) => (skill.name === name ? result.skill : skill)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(removeSkillConfirmation(name))) return;
    setBusy(name);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}/skills/${name}`, { method: "DELETE" });
      setSkills((current) => current.filter((skill) => skill.name !== name));
      setReview((current) => (current?.name === name ? null : current));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <button
        className="flex w-full items-center justify-between gap-4 text-left"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
      >
        <div>
          <div className="text-[15px] font-medium text-ink">Skills</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Imported Agent Skills — each stays off until you review and enable it.
          </div>
        </div>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>

      {open && loading && <div className="mt-3 text-[13px] text-ink-secondary">Loading…</div>}

      {open && !loading && (
        <div className="mt-3">
          {skills.length === 0 ? (
            <div className="text-[13px] text-ink-secondary">
              No skills imported yet — paste a GitHub repo that holds a SKILL.md to teach this bot something new.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-hairline/40">
              {skills.map((skill) => {
                const reviewing = review !== null && review.name === skill.name ? review : null;
                return (
                  <div key={skill.name} className="border-b border-hairline/40 last:border-b-0">
                    <div className="flex items-start gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-[13px] font-medium text-ink">{skill.name}</span>
                          {skill.warnings.length > 0 && (
                            <span className="flex shrink-0 items-center gap-1 rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                              <AlertTriangle size={11} />
                              {warningBadgeLabel(skill.warnings.length)}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-secondary">{skill.description}</div>
                        <div className="mt-1 flex items-center gap-2.5">
                          <span
                            className="min-w-0 truncate font-mono text-[11px] text-ink-secondary"
                            title={`${skill.source} — sha256 ${skill.sha256}`}
                          >
                            {provenanceLine(skill)}
                          </span>
                          <button
                            onClick={() => void openReview(skill.name)}
                            aria-expanded={reviewing !== null}
                            className="shrink-0 text-[11.5px] font-medium text-accent hover:underline"
                          >
                            {reviewing ? "Close review" : "Review"}
                          </button>
                        </div>
                      </div>
                      <button
                        role="switch"
                        aria-checked={skill.enabled}
                        aria-label={`Enable skill ${skill.name}`}
                        disabled={busy === skill.name}
                        onClick={() => void setEnabled(skill.name, !skill.enabled)}
                        className={cn(
                          "relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                          skill.enabled ? "bg-accent" : "bg-control",
                        )}
                      >
                        <span
                          className={cn(
                            "absolute top-[3px] size-4 rounded-full bg-white transition-all",
                            skill.enabled ? "left-[19px]" : "left-[3px]",
                          )}
                        />
                      </button>
                      <button
                        onClick={() => void remove(skill.name)}
                        disabled={busy === skill.name}
                        aria-label={`Remove skill ${skill.name}`}
                        title="Remove this skill"
                        className="mt-0.5 shrink-0 rounded-md p-1 text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {reviewing && (
                      <div className="border-t border-hairline/40 px-3 py-3">
                        {skill.warnings.length > 0 && (
                          <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
                            <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-warning">
                              <AlertTriangle size={13} /> Read these before enabling
                            </div>
                            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12.5px] leading-relaxed text-warning">
                              {skill.warnings.map((warning) => (
                                <li key={warning}>{warning}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {skill.skippedFiles.length > 0 && (
                          <div className={cn("text-[12px] text-ink-secondary", skill.warnings.length > 0 && "mt-2")}>
                            Skipped at import (markdown only):{" "}
                            <span className="font-mono">{skill.skippedFiles.join(", ")}</span>
                          </div>
                        )}
                        {(skill.license || skill.compatibility) && (
                          <div className="mt-2 text-[12px] text-ink-secondary">
                            {[
                              skill.license && `License: ${skill.license}`,
                              skill.compatibility && `Compatibility: ${skill.compatibility}`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        )}
                        {/* Plain <pre>, never markdown: see the header comment. */}
                        <pre className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink">
                          {reviewing.text ?? "Loading…"}
                        </pre>
                        {!skill.enabled && (
                          <button
                            onClick={() => void setEnabled(skill.name, true)}
                            disabled={busy === skill.name || reviewing.text === null}
                            className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                          >
                            Enable this skill
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <form className="mt-3 flex items-center gap-2" onSubmit={(e) => void importSkills(e)}>
            <input
              className={cn(inputCls, "font-mono text-[12.5px]")}
              placeholder="owner/repo or GitHub URL with a SKILL.md"
              aria-label="Skill source"
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
          {importErrors.length > 0 && (
            <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
              {importErrors.map((message) => (
                <div key={message}>{message}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
