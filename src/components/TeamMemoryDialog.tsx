import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Brain, Check, Loader2, Pin, Plus, Trash2, X } from "lucide-react";


import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { cn } from "@/lib/cn";
import { Select } from "./Select";

type Kind = "person" | "place" | "decision" | "term";

interface Entry {
  id: string;
  kind: Kind;
  name: string;
  detail: string;
  aliases: string[];
  status: "accepted" | "proposed";
  source: { botId: string; botName: string; threadId: string; at: number; quote?: string; messageId?: string };
  updatedAt: number;
  revision: string;
  pinned?: boolean;
  key?: string;
  history?: Array<{ name: string; detail: string; at: number }>;
}

const KINDS: Array<{ kind: Kind; titleKey: LocaleKey; hintKey: LocaleKey }> = [
  { kind: "person", titleKey: "teamMemory.kind.people", hintKey: "teamMemory.kind.peopleHint" },
  { kind: "place", titleKey: "teamMemory.kind.places", hintKey: "teamMemory.kind.placesHint" },
  { kind: "decision", titleKey: "teamMemory.kind.decisions", hintKey: "teamMemory.kind.decisionsHint" },
  { kind: "term", titleKey: "teamMemory.kind.terms", hintKey: "teamMemory.kind.termsHint" },
];

export function TeamMemoryDialog({ section, label, onClose }: { section: string; label: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [loadedIds, setLoadedIds] = useState<string[]>([]);
  const [unsaved, setUnsaved] = useState<Record<string, { name: string; text: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ kind: Kind; name: string; detail: string }>({ kind: "term", name: "", detail: "" });
  const query = `section=${encodeURIComponent(section)}`;

  const load = useCallback(async () => {
    const requestGeneration = ++generation.current;
    try {
      const result: { entries: Entry[]; loadedIds: string[] } = await api(`/api/team-memory?${query}`);
      if (generation.current !== requestGeneration) return;
      setEntries(result.entries);
      setLoadedIds(result.loadedIds);
      setError(null);
    } catch (cause) {
      if (generation.current !== requestGeneration) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [query]);

  useEffect(() => {
    setEntries(null);
    setError(null);
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>("button:enabled, input:enabled, select:enabled");
        if (!controls?.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [onClose]);

  const run = async (id: string | null, request: () => Promise<{ entries: Entry[]; loadedIds?: string[] }>) => {
    if (busy.current) return false;
    busy.current = true;
    const requestGeneration = ++generation.current;
    setBusyId(id ?? "new");
    setError(null);
    try {
      const result = await request();
      if (generation.current !== requestGeneration) return false;
      setEntries(result.entries);
      setBusyId(null);
      if (result.loadedIds) setLoadedIds(result.loadedIds); else void load();
      return true;
    } catch (cause) {
      if (generation.current === requestGeneration) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      busy.current = false;
      if (generation.current === requestGeneration) setBusyId(null);
    }
  };

  const accept = (entry: Entry) =>
    run(entry.id, () => api(`/api/team-memory/${entry.id}?${query}`, { method: "PATCH", body: JSON.stringify({ accept: true, expectedRevision: entry.revision }) }));
  const remove = (entry: Entry) => run(entry.id, () => api(`/api/team-memory/${entry.id}?${query}&revision=${entry.revision}`, { method: "DELETE" }));
  const editDetail = (entry: Entry, detail: string, name?: string) => {
    if (detail.trim() === entry.detail && (name === undefined || name === entry.name)) return;
    void run(entry.id, () => api(`/api/team-memory/${entry.id}?${query}`, { method: "PATCH", body: JSON.stringify({ detail, ...(name === undefined ? {} : { name }), expectedRevision: entry.revision }) })).then(saved => setUnsaved(current => {
      const next = { ...current };
      if (saved) delete next[entry.id]; else next[entry.id] = { name: name ?? entry.name, text: detail };
      return next;
    }));
  };
  const add = () => {
    if (!draft.name.trim() || !draft.detail.trim()) return;
    void run(null, () => api(`/api/team-memory?${query}`, { method: "POST", body: JSON.stringify(draft) })).then((saved) => {
      if (!saved) return;
      setDraft({ kind: draft.kind, name: "", detail: "" });
      setAdding(false);
    });
  };

  const proposed = (entries ?? []).filter((entry) => entry.status === "proposed");

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-memory-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-[720px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-hairline/40 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div>
            <div className="flex items-center gap-2">
              <Brain size={19} className="text-accent" />
              <h2 id="team-memory-title" className="text-[20px] font-semibold tracking-[-0.01em] text-ink">
                {t("teamMemory.title", { name: label })}
              </h2>
            </div>
            <p className="mt-1.5 max-w-[560px] text-[13px] leading-relaxed text-ink-secondary">
              {t("teamMemory.description")}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label={t("teamMemory.close")}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={19} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-8">
          {entries === null && !error && (
            <div className="flex min-h-[200px] items-center justify-center text-ink-secondary">
              <Loader2 size={20} className="animate-spin" aria-label={t("teamMemory.loading")} />
            </div>
          )}
          {entries && <p className="mb-3 text-[12px] text-ink-secondary">{t("teamMemory.loadedSummary", { loaded: loadedIds.length, total: entries.filter(entry => entry.status === "accepted").length })}</p>}
          {error && <div role="alert" className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error} <button onClick={() => void load()} className="underline">{t("teamMemory.reload")}</button></div>}
          {Object.entries(unsaved).map(([id, draft]) => <p key={id} className="mb-3 text-[12px] text-ink-secondary"><strong>{draft.name}</strong> · {t("teamMemory.unsaved", { text: draft.text })}</p>)}

          {proposed.length > 0 && (
            <section className="mb-5 rounded-xl border border-accent/30 bg-accent/5 p-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">{t("teamMemory.waiting")}</h3>
              <ul className="mt-2 space-y-2">
                {proposed.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-3 text-[13px]">
                    <span className="min-w-0 flex-1">
                      <span className="text-ink-secondary">{t(`teamMemory.kind.${entry.kind}`)}: </span>
                      <span className="font-medium text-ink">{entry.name}</span>
                      {entry.aliases.length > 0 && <span className="text-ink-secondary"> ({t("teamMemory.also")} {entry.aliases.join(", ")})</span>}
                      <span className="text-ink"> — {entry.detail}</span>
                      <span className="block text-[11px] text-ink-secondary">{t("teamMemory.source", { name: entry.source.botName })}{entry.source.quote && ` · ${t("teamMemory.sourceQuote", { quote: entry.source.quote })}`}</span>
                    </span>
                    <button
                      onClick={() => void accept(entry)}
                      disabled={busyId !== null}
                      className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
                    >
                      <Check size={12} /> {t("teamMemory.remember")}
                    </button>
                    <button
                      onClick={() => void remove(entry)}
                      disabled={busyId !== null}
                      className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-50"
                    >
                      {t("teamMemory.skip")}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {entries !== null && entries.filter((entry) => entry.status === "accepted").length === 0 && proposed.length === 0 && (
            <div className="rounded-xl bg-inset px-4 py-6 text-center text-[13px] text-ink-secondary">
              {t("teamMemory.empty")}
            </div>
          )}

          {KINDS.map(({ kind, titleKey, hintKey }) => {
            const rows = (entries ?? []).filter((entry) => entry.status === "accepted" && entry.kind === kind);
            if (rows.length === 0) return null;
            return (
              <section key={kind} className="mb-5">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary" title={t(hintKey)}>
                  {t(titleKey)}
                </h3>
                <ul className="mt-2 divide-y divide-hairline/20 rounded-xl bg-inset">
                  {rows.map((entry) => (
                    <li key={entry.id} className="flex items-start gap-3 px-3 py-2 text-[13px]">
                      <span className="min-w-0 flex-1">
                        <span className="font-medium text-ink">{entry.name}</span>
                        {entry.aliases.length > 0 && <span className="text-ink-secondary"> ({t("teamMemory.also")} {entry.aliases.join(", ")})</span>}
                        <input
                          key={entry.revision}
                          defaultValue={entry.detail}
                          disabled={busyId !== null}
                          onBlur={(event) => editDetail(entry, event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                          }}
                          aria-label={`${entry.name} detail`}
                          className="mt-0.5 block w-full rounded bg-transparent px-1 py-0.5 text-[13px] text-ink outline-none hover:bg-card focus:bg-card"
                        />
                        <span className="block px-1 text-[11px] text-ink-secondary">
                          {entry.source.botName || t("teamMemory.you")} · {new Date(entry.updatedAt).toLocaleDateString()} · {loadedIds.includes(entry.id) ? t("teamMemory.loaded") : t("teamMemory.searchable")}
                        </span>
                        {!!entry.history?.length && <details className="mt-1 text-[11px] text-ink-secondary"><summary>{t("teamMemory.history")}</summary>{entry.history.map((version, index) => <div key={index} className="mt-1">{new Date(version.at).toLocaleDateString()}: {version.name} — {version.detail} <button disabled={busyId !== null} onClick={() => editDetail(entry, version.detail, version.name)} className="underline">{t("teamMemory.restore")}</button></div>)}</details>}
                      </span>
                      <button aria-label={t(entry.pinned ? "teamMemory.unpin" : "teamMemory.pin", { name: entry.name })} aria-pressed={entry.pinned ?? false} disabled={busyId !== null} className="p-1 text-ink-secondary hover:text-accent" onClick={() => void run(entry.id, () => api(`/api/team-memory/${entry.id}?${query}`, { method: "PATCH", body: JSON.stringify({ pinned: !entry.pinned, expectedRevision: entry.revision }) }))}><Pin size={13} /></button>
                      <button
                        onClick={() => void remove(entry)}
                        disabled={busyId !== null}
                        aria-label={t("teamMemory.remove", { name: entry.name })}
                        className="shrink-0 rounded-md p-1 text-ink-secondary hover:text-danger disabled:opacity-50"
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          {adding ? (
            <div className="rounded-xl border border-hairline/40 bg-card p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Select size="sm"
                  value={draft.kind}
                  onChange={(event) => setDraft({ ...draft, kind: event.target.value as Kind })}
                  aria-label={t("teamMemory.kindLabel")}
                >
                  {KINDS.map(({ kind }) => (
                    <option key={kind} value={kind}>
                      {t(`teamMemory.kind.${kind}`)}
                    </option>
                  ))}
                </Select>
                <input
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder={t("teamMemory.namePlaceholder")}
                  aria-label={t("teamMemory.nameLabel")}
                  className="min-w-[140px] flex-1 rounded-lg border border-hairline/40 bg-inset px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
                />
              </div>
              <input
                value={draft.detail}
                onChange={(event) => setDraft({ ...draft, detail: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") add();
                }}
                placeholder={t("teamMemory.detailPlaceholder")}
                aria-label={t("teamMemory.detailLabel")}
                className="mt-2 w-full rounded-lg border border-hairline/40 bg-inset px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={add}
                  disabled={busyId !== null || !draft.name.trim() || !draft.detail.trim()}
                  className="rounded-lg bg-accent px-3 py-1 text-[13px] font-medium text-white disabled:opacity-50"
                >
                  {busyId === "new" ? t("teamMemory.adding") : t("teamMemory.add")}
                </button>
                <button onClick={() => setAdding(false)} className="text-[13px] text-ink-secondary hover:text-ink">
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setAdding(true)}
              className={cn("flex items-center gap-1.5 text-[13px] text-ink-secondary hover:text-ink", entries === null && "hidden")}
            >
              <Plus size={13} /> {t("teamMemory.addEntry")}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
