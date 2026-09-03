import { AlertTriangle, BookOpen, Download, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { searchSkills, skillOriginLabel } from "@/lib/skills";
import { api, useStore, type SkillCatalogEntry } from "@/state/store";

export function SkillsSection() {
  const { state, dispatch } = useStore();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const skills = useMemo(() => searchSkills(state.skills, query), [query, state.skills]);

  const importSkill = async () => {
    if (!source.trim() || importing) return;
    setImporting(true);
    setMessage(null);
    try {
      const result: { skills: SkillCatalogEntry[]; results: Array<{ imported?: boolean; name?: string; error?: string }> } = await api("/api/skills/import", {
        method: "POST",
        body: JSON.stringify({ source: source.trim() }),
      });
      dispatch({ type: "skillsHydrated", skills: result.skills });
      const imported = result.results.filter((entry) => entry.imported).length;
      setMessage({ kind: "success", text: imported ? `Imported ${imported} skill${imported === 1 ? "" : "s"}.` : "This skill is already in the library." });
      setSource("");
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not import the skill." });
    } finally {
      setImporting(false);
    }
  };

  const removeSkill = async (skill: SkillCatalogEntry) => {
    if (skill.origin !== "imported") return;
    if (!window.confirm(`Remove imported skill “${skill.name}” from the shared library?`)) return;
    setMessage(null);
    try {
      const result = await api(`/api/skills/${encodeURIComponent(skill.id)}`, { method: "DELETE" });
      dispatch({ type: "skillsHydrated", skills: result.skills ?? state.skills.filter((entry) => entry.id !== skill.id) });
      setMessage({ kind: "success", text: `Removed ${skill.name}.` });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not remove the skill." });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-hairline/40 bg-card p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-secondary"><Download size={16} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-ink">Import from GitHub</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">Paste a GitHub URL or use <code>npx skills add owner/repo --skill name</code>. The command is parsed safely, never executed. Scripts are skipped; review warnings before using it.</p>
            <div className="mt-3 flex gap-2">
              <input value={source} onChange={(event) => setSource(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void importSkill()} placeholder="GitHub URL or npx skills add owner/repo --skill name" aria-label="GitHub URL or safe skills import command" className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none" />
              <button type="button" disabled={!source.trim() || importing} onClick={() => void importSkill()} className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40">{importing ? "Importing…" : "Import"}</button>
            </div>
            {message ? <p role={message.kind === "error" ? "alert" : "status"} className={`mt-2 text-[12px] ${message.kind === "error" ? "text-danger" : "text-success"}`}>{message.text}</p> : null}
          </div>
        </div>
      </div>

      <label className="flex items-center gap-2 rounded-xl bg-control/70 px-3 py-2">
        <Search size={15} className="text-ink-secondary" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search skill library" placeholder="Search the skill library" className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none" />
      </label>

      <div className="space-y-2">
        {skills.map((skill) => (
          <details key={skill.id} className="rounded-xl border border-hairline/40 bg-card px-4 py-3">
            <summary className="cursor-pointer list-none">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-secondary"><BookOpen size={15} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="text-[14px] font-medium text-ink">{skill.name}</span><span className="rounded-full bg-raised px-2 py-0.5 text-[10.5px] text-ink-secondary">{skillOriginLabel(skill.origin)}</span>{skill.origin === "imported" ? <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void removeSkill(skill); }} aria-label={`Remove imported skill ${skill.name}`} title="Remove imported skill" className="ml-auto rounded-md p-1 text-ink-secondary hover:bg-control hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><Trash2 size={14} /></button> : null}</div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{skill.description}</p>
                </div>
              </div>
            </summary>
            <div className="ml-11 mt-3 space-y-2 border-t border-hairline/30 pt-3 text-[11.5px] text-ink-secondary">
              {skill.source ? <p className="break-all"><span className="text-ink">Source:</span> {skill.source}</p> : null}
              <p><span className="text-ink">Capabilities:</span> {skill.requiredCapabilities.length ? skill.requiredCapabilities.join(", ") : "Provider neutral"}</p>
              <p><span className="text-ink">Declared tools:</span> {skill.tools.length ? skill.tools.join(", ") : "None"}</p>
              {skill.warnings.length ? <div className="rounded-lg border border-warning/30 bg-warning/10 p-2 text-warning"><div className="flex items-center gap-1.5 font-medium"><AlertTriangle size={13} />Review warnings</div><ul className="mt-1 list-disc space-y-1 pl-4">{skill.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}
              {skill.skippedFiles.length ? <p><span className="text-ink">Skipped files:</span> {skill.skippedFiles.join(", ")}</p> : null}
            </div>
          </details>
        ))}
        {!skills.length ? <div className="rounded-xl border border-dashed border-hairline/50 px-4 py-10 text-center text-[13px] text-ink-secondary">No skills match “{query.trim()}”.</div> : null}
      </div>
    </div>
  );
}
