import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { fetchThreadNotes, saveThreadNotes, type MemoryDoc, type TextSaveResult, type ThreadNotesDoc } from "@/lib/memory";
import type { Bot } from "@/state/store";

export const AUTOSAVE_MS = 700;
const SAVED_SHOWN_MS = 1_200;

type Status = "idle" | "saving" | "saved" | "error";

/** One notes file as plain text, saved as the person types. A save carries the hash it was read at; when the file
 * changed underneath (the bot wrote meanwhile), what is on disk wins and replaces the text here. */
export function MemoryText({ label, doc, placeholder, save, attr }: {
  label: string;
  doc: MemoryDoc;
  placeholder: string;
  save: (text: string, expectedHash: string) => Promise<TextSaveResult<MemoryDoc>>;
  attr: string;
}) {
  const [text, setText] = useState(doc.text);
  const [status, setStatus] = useState<Status>("idle");
  const latest = useRef(doc.text);
  const onDisk = useRef({ text: doc.text, hash: doc.hash });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);
  useEffect(() => {
    if (status !== "saved") return;
    const fade = setTimeout(() => setStatus((current) => (current === "saved" ? "idle" : current)), SAVED_SHOWN_MS);
    return () => clearTimeout(fade);
  }, [status]);

  useEffect(() => {
    if (latest.current !== onDisk.current.text || running.current) return;
    latest.current = doc.text;
    onDisk.current = { text: doc.text, hash: doc.hash };
    setText(doc.text);
  }, [doc.text, doc.hash]);

  const persist = async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (running.current) await running.current;
    const draft = latest.current;
    if (draft === onDisk.current.text) return;
    setStatus("saving");
    const run = (async () => {
      try {
        const result = await saveRef.current(draft, onDisk.current.hash);
        const kept = result.ok ? result.doc.text : result.current;
        onDisk.current = { text: kept, hash: result.ok ? result.doc.hash : result.currentHash };
        if (!result.ok || latest.current === draft) {
          latest.current = kept;
          setText(kept);
        }
        setStatus(result.ok ? "saved" : "idle");
      } catch {
        setStatus("error");
      }
    })();
    running.current = run;
    await run;
    running.current = null;
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => () => void persistRef.current(), []);

  const hint = status === "saving" ? t("common.saving") : status === "saved" ? t("common.saved") : status === "error" ? t("botPanel.library.memoryError") : "";
  return (
    <section data-memory-scope={attr} className="group/memory flex flex-col gap-1">
      <div className="flex min-h-4 items-baseline gap-2 px-3.5">
        <h3 id={`memory-${attr}`} className="text-[12px] font-medium leading-4 text-ink-tertiary transition-colors duration-[120ms] group-focus-within/memory:text-ink-secondary motion-reduce:transition-none">{label}</h3>
        <span role="status" aria-live="polite" className={cn("text-[12px] leading-4 transition-opacity duration-[120ms] motion-reduce:transition-none", status === "error" ? "text-warning" : "text-ink-tertiary", hint ? "opacity-100" : "opacity-0")}>{hint}</span>
      </div>
      <textarea
        ref={field}
        dir="auto"
        rows={1}
        spellCheck
        aria-labelledby={`memory-${attr}`}
        className="chat-text block w-full resize-none overflow-hidden rounded-[8px] bg-transparent px-3.5 py-1.5 text-[15px] font-normal text-ink caret-accent outline-none [overflow-wrap:anywhere] whitespace-pre-wrap placeholder:text-ink-tertiary hover:bg-ink/[0.02] focus:bg-ink/[0.03] transition-colors duration-[120ms] motion-reduce:transition-none"
        value={text}
        placeholder={placeholder}
        onChange={(event) => {
          latest.current = event.target.value;
          setText(event.target.value);
          setStatus("idle");
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => void persistRef.current(), AUTOSAVE_MS);
        }}
        onBlur={() => void persistRef.current()}
      />
    </section>
  );
}

/** Advanced mode's Memory section: the open conversation's own notes above the bot's memory files, when it keeps them. */
export function ThreadMemoryCard({ bot }: { bot: Pick<Bot, "id" | "threadId" | "busy" | "memoryEnabled"> }) {
  const [loaded, setLoaded] = useState<{ threadId: string; doc: ThreadNotesDoc } | null>(null);
  useEffect(() => {
    let live = true;
    fetchThreadNotes(bot.id, bot.threadId).then((doc) => { if (live) setLoaded({ threadId: bot.threadId, doc }); }).catch(() => {});
    return () => { live = false; };
  }, [bot.id, bot.threadId, bot.busy]);
  const doc = loaded && loaded.threadId === bot.threadId && typeof loaded.doc?.text === "string" ? loaded.doc : null;
  if (bot.memoryEnabled === false || !doc || !(doc.scoped || doc.text.trim())) return null;
  return (
    <div data-memory-thread-card="" className="rounded-xl bg-card px-0.5 py-3">
      <MemoryText key={`${bot.id}:${bot.threadId}`} attr="thread" label={t("memoryPage.thisThread")} doc={doc} placeholder={t("memoryPage.empty")}
        save={(text, hash) => saveThreadNotes(bot.id, bot.threadId, text, hash)} />
    </div>
  );
}
