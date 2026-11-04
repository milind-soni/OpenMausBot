import { useMemo, useState } from "react";
import { Brain, Check, Copy, Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { applyMemoryImport, askMausBotToSetUp, mausBotOf, saveImportNote, type MemoryImportDone } from "@/lib/memory-import";
import { useStore } from "@/state/store";
import { MEMORY_IMPORT_SOURCES, MemoryImportError, memoryImportNote, memoryImportPrompt, parseMemoryImport, type MemoryImport } from "../../shared/memory-import";

const OTHER = "other";
const button = "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-40";
const quiet = "inline-flex items-center gap-1.5 rounded-lg border border-hairline/50 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40";

const today = () => new Date().toLocaleDateString("en-CA");

/** Settings → Import: a prompt to paste into another assistant (Grok, Instant, Muse…), and its answer pasted back into
 * About you and a note for MausBot. */
export function MemoryImportSection() {
  const { state, dispatch } = useStore();
  const [choice, setChoice] = useState<string>(MEMORY_IMPORT_SOURCES[0]);
  const [otherName, setOtherName] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [answer, setAnswer] = useState("");
  const [addFacts, setAddFacts] = useState(true);
  const [keepNote, setKeepNote] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<MemoryImportDone | null>(null);
  const [asked, setAsked] = useState(false);
  const [asking, setAsking] = useState(false);
  const source = choice === OTHER ? otherName.trim() : choice;
  const prompt = memoryImportPrompt(source || t("settings.import.memory.otherFallback"));
  const mausBot = mausBotOf(state.bots);

  const parsed = useMemo((): { imported: MemoryImport } | { problem: string } | null => {
    if (!answer.trim()) return null;
    try {
      return { imported: parseMemoryImport(answer) };
    } catch (cause) {
      return { problem: cause instanceof MemoryImportError ? cause.message : String(cause) };
    }
  }, [answer]);
  const imported = parsed && "imported" in parsed ? parsed.imported : null;
  const clipped = useMemo(() => (imported ? memoryImportNote(imported, source || "x", today()).clipped : false), [imported, source]);

  const copy = async () => {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopyError(t("settings.import.memory.copyFailed"));
    }
  };

  const save = async () => {
    if (!imported || working) return;
    setWorking(true);
    setError("");
    try {
      const result = await applyMemoryImport({
        imported, source: source || t("settings.import.memory.otherFallback"),
        team: Boolean(state.config?.team), addFacts, noteFor: keepNote && mausBot ? mausBot.id : null, today: today(),
      });
      if (result.aboutMe !== null) dispatch({ type: "profileSaved", profile: { aboutMe: result.aboutMe } });
      setDone(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const ask = async () => {
    if (!imported || !mausBot || asking) return;
    setAsking(true);
    setError("");
    try {
      await askMausBotToSetUp(mausBot, source, imported);
      setAsked(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAsking(false);
    }
  };

  const retryNote = async () => {
    if (!imported || !mausBot || !done || working) return;
    setWorking(true);
    try {
      const note = await saveImportNote(mausBot.id, { imported, source, today: today() });
      setDone({ ...done, note, noteError: null });
    } catch (cause) {
      setDone({ ...done, noteError: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setWorking(false);
    }
  };

  return (
    <section data-import-section="memory" className="rounded-xl bg-card p-4">
      <div className="flex items-center gap-2 text-[15px] font-medium text-ink"><Brain size={16} />{t("settings.import.memory.title")}</div>
      <div className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">{t("settings.import.memory.subtitle")}</div>

      {done && imported ? (
        <div role="status" className="mt-4 flex flex-col gap-2" data-memory-import-done>
          <p className="flex items-center gap-2 text-[14px] font-medium text-ink"><Check size={15} className="text-success" />{t("settings.import.memory.done", { source })}</p>
          {done.factsAdded > 0 && <p className="text-[13px] text-ink-secondary">{t("settings.import.memory.factsAdded", { count: done.factsAdded })}</p>}
          {done.factsKnown > 0 && <p className="text-[13px] text-ink-secondary">{t("settings.import.memory.factsKnown", { count: done.factsKnown })}</p>}
          {done.factsLeftOut > 0 && <p className="text-[13px] text-ink-secondary">{t(done.note ? "settings.import.memory.factsLeftOut" : "settings.import.memory.factsLeftOutNoNote", { count: done.factsLeftOut })}</p>}
          {done.note && mausBot && <p className="text-[13px] text-ink-secondary">{t("settings.import.memory.noteSaved", { bot: mausBot.name })}</p>}
          {done.noteError && (
            <div role="alert" className="text-[13px] text-danger" data-memory-note-error>
              {t("settings.import.memory.noteFailed", { error: done.noteError })}
              <button type="button" className={cn(quiet, "ms-2")} disabled={working} onClick={() => void retryNote()}>{t("settings.import.memory.retryNote")}</button>
            </div>
          )}
          {done.note && mausBot && imported.setup.length > 0 && (
            asked
              ? <p className="text-[13px] text-ink-secondary">{t("settings.import.memory.asked", { bot: mausBot.name })}</p>
              : <button type="button" className={cn(button, "self-start")} disabled={asking} onClick={() => void ask()}>
                {asking && <Loader2 size={14} className="animate-spin" />}{t("settings.import.memory.ask", { bot: mausBot.name })}
              </button>
          )}
          {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        </div>
      ) : (
        <ol className="mt-4 flex flex-col gap-4">
          <li>
            <div className="text-[13px] font-medium text-ink">{t("settings.import.memory.step1")}</div>
            <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("settings.import.memory.from")}>
              {[...MEMORY_IMPORT_SOURCES, OTHER].map((name) => (
                <button key={name} type="button" role="radio" aria-checked={choice === name} data-memory-source={name} onClick={() => setChoice(name)}
                  className={cn("rounded-full px-3 py-1 text-[13px]", choice === name ? "bg-accent text-accent-ink" : "bg-raised text-ink-secondary hover:text-ink")}>
                  {name === OTHER ? t("settings.import.memory.other") : name}
                </button>
              ))}
            </div>
            {choice === OTHER && (
              <input value={otherName} maxLength={60} onChange={(event) => setOtherName(event.target.value)} aria-label={t("settings.import.memory.otherName")}
                placeholder={t("settings.import.memory.otherName")}
                className="mt-2 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:border-focus focus:outline-none" />
            )}
          </li>
          <li>
            <div className="text-[13px] font-medium text-ink">{t("settings.import.memory.step2", { source: source || t("settings.import.memory.otherFallback") })}</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("settings.import.memory.step2Hint")}</p>
            <div className="mt-2 flex items-center gap-2">
              <button type="button" className={quiet} onClick={() => void copy()} data-memory-copy>
                {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                {copied ? t("settings.import.memory.copied") : t("settings.import.memory.copy")}
              </button>
            </div>
            {copyError && <p role="alert" className="mt-1 text-[12px] text-danger" data-memory-copy-error>{copyError}</p>}
            {choice === "Grok" && <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary" data-memory-grok-bot>{t("settings.import.memory.grokBot")}</p>}
            <details className="mt-2">
              <summary className="cursor-pointer text-[12px] text-ink-secondary">{t("settings.import.memory.showPrompt")}</summary>
              <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-inset p-3 text-[12px] leading-relaxed text-ink" data-memory-prompt>{prompt}</pre>
            </details>
          </li>
          <li>
            <div className="text-[13px] font-medium text-ink">{t("settings.import.memory.step3")}</div>
            <textarea value={answer} onChange={(event) => { setAnswer(event.target.value); setError(""); }} rows={6} aria-label={t("settings.import.memory.paste")}
              placeholder={t("settings.import.memory.paste")} data-memory-answer
              className="mt-2 w-full resize-y rounded-lg border border-hairline/50 bg-inset px-3 py-2 font-mono text-[12px] text-ink placeholder:font-sans placeholder:text-ink-secondary focus:border-focus focus:outline-none" />
            {parsed && "problem" in parsed && <p role="alert" className="mt-1 text-[12px] text-danger">{parsed.problem}</p>}
          </li>
          {imported && (
            <li data-memory-preview>
              <div className="text-[13px] font-medium text-ink">{t("settings.import.memory.step4")}</div>
              <p className="mt-1 text-[13px] text-ink-secondary">
                {t("settings.import.memory.found", { facts: imported.facts.length, setup: imported.setup.length })}
                {imported.context ? ` ${t("settings.import.memory.foundContext")}` : ""}
              </p>
              {clipped && <p role="alert" className="mt-1 text-[12px] text-warning" data-memory-clipped>{t("settings.import.memory.clipped")}</p>}
              {imported.setup.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {imported.setup.map((item) => <li key={item.name} className="rounded-full bg-raised px-2.5 py-0.5 text-[12px] text-ink">{item.name}</li>)}
                </ul>
              )}
              <label className="mt-3 flex items-start gap-2 text-[13px] text-ink">
                <input type="checkbox" className="mt-0.5" checked={addFacts} disabled={!imported.facts.length} onChange={(event) => setAddFacts(event.target.checked)} />
                <span>{t("settings.import.memory.addFacts")}<span className="block text-[12px] text-ink-secondary">{t("settings.import.memory.addFactsHint")}</span></span>
              </label>
              <label className="mt-2 flex items-start gap-2 text-[13px] text-ink">
                <input type="checkbox" className="mt-0.5" checked={keepNote && Boolean(mausBot)} disabled={!mausBot} onChange={(event) => setKeepNote(event.target.checked)} />
                <span>{t("settings.import.memory.keepNote", { bot: mausBot?.name ?? "MausBot" })}<span className="block text-[12px] text-ink-secondary">{t("settings.import.memory.keepNoteHint")}</span></span>
              </label>
              <button type="button" className={cn(button, "mt-3")} disabled={working || !source || !(addFacts && imported.facts.length || keepNote && mausBot)} onClick={() => void save()} data-memory-save>
                {working && <Loader2 size={14} className="animate-spin" />}{t("settings.import.memory.save")}
              </button>
              {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
            </li>
          )}
        </ol>
      )}
    </section>
  );
}
