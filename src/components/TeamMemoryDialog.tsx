// Team memory: the people, places, decisions and terms every bot in a
// section shares. Bots propose them from conversations (places and terms
// land at once, people and decisions wait for a tap); this is where the
// person sees the whole of it, answers what is waiting, and fixes or
// removes anything. Sits beside the section's shared context, which only
// the person writes.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Brain, Check, Loader2, Plus, Trash2, X } from "lucide-react";

import { api } from "@/state/store";
import { cn } from "@/lib/cn";

type Kind = "person" | "place" | "decision" | "term";

interface Entry {
  id: string;
  kind: Kind;
  name: string;
  detail: string;
  aliases: string[];
  status: "accepted" | "proposed";
  source: { botId: string; botName: string; threadId: string; at: number };
  updatedAt: number;
}

const KINDS: Array<{ kind: Kind; title: string; hint: string }> = [
  { kind: "person", title: "People", hint: "Who someone is and the names they go by" },
  { kind: "place", title: "Places", hint: "Where a document or a thing lives" },
  { kind: "decision", title: "Decisions", hint: "What was decided, and where" },
  { kind: "term", title: "Terms", hint: "What an abbreviation or a nickname means" },
];

export function TeamMemoryDialog({ section, label, onClose }: { section: string; label: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ kind: Kind; name: string; detail: string }>({ kind: "term", name: "", detail: "" });
  const query = `section=${encodeURIComponent(section)}`;

  const load = useCallback(async () => {
    try {
      const result: { entries: Entry[] } = await api(`/api/team-memory?${query}`);
      setEntries(result.entries);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [onClose]);

  const run = async (id: string | null, request: () => Promise<{ entries: Entry[] }>) => {
    setBusyId(id ?? "new");
    setError(null);
    try {
      const result = await request();
      setEntries(result.entries);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const accept = (entry: Entry) =>
    run(entry.id, () => api(`/api/team-memory/${entry.id}?${query}`, { method: "PATCH", body: JSON.stringify({ accept: true }) }));
  const remove = (entry: Entry) => run(entry.id, () => api(`/api/team-memory/${entry.id}?${query}`, { method: "DELETE" }));
  const editDetail = (entry: Entry, detail: string) => {
    if (detail.trim() === entry.detail) return;
    void run(entry.id, () => api(`/api/team-memory/${entry.id}?${query}`, { method: "PATCH", body: JSON.stringify({ detail }) }));
  };
  const add = () => {
    if (!draft.name.trim() || !draft.detail.trim()) return;
    void run(null, () => api(`/api/team-memory?${query}`, { method: "POST", body: JSON.stringify(draft) })).then(() => {
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
        className="animate-pop-in flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-[720px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-hairline/40 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div>
            <div className="flex items-center gap-2">
              <Brain size={19} className="text-accent" />
              <h2 id="team-memory-title" className="text-[20px] font-semibold tracking-[-0.01em] text-ink">
                {label} team memory
              </h2>
            </div>
            <p className="mt-1.5 max-w-[560px] text-[12.5px] leading-relaxed text-ink-secondary">
              People, places, decisions and terms every bot in this section shares. Bots add what they learn: places and
              terms land at once, people and decisions wait for you. Edit or remove anything.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close team memory"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={19} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-8">
          {entries === null && !error && (
            <div className="flex min-h-[200px] items-center justify-center text-ink-secondary">
              <Loader2 size={20} className="animate-spin" aria-label="Loading team memory" />
            </div>
          )}
          {error && <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

          {proposed.length > 0 && (
            <section className="mb-5 rounded-xl border border-accent/30 bg-accent/5 p-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">Waiting for you</h3>
              <ul className="mt-2 space-y-2">
                {proposed.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-3 text-[13px]">
                    <span className="min-w-0 flex-1">
                      <span className="text-ink-secondary">{entry.kind}: </span>
                      <span className="font-medium text-ink">{entry.name}</span>
                      {entry.aliases.length > 0 && <span className="text-ink-secondary"> (also {entry.aliases.join(", ")})</span>}
                      <span className="text-ink"> — {entry.detail}</span>
                      <span className="block text-[11px] text-ink-secondary">from {entry.source.botName}</span>
                    </span>
                    <button
                      onClick={() => void accept(entry)}
                      disabled={busyId === entry.id}
                      className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
                    >
                      <Check size={12} /> Remember
                    </button>
                    <button
                      onClick={() => void remove(entry)}
                      disabled={busyId === entry.id}
                      className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-50"
                    >
                      Skip
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {entries !== null && entries.filter((entry) => entry.status === "accepted").length === 0 && proposed.length === 0 && (
            <div className="rounded-xl bg-inset px-4 py-6 text-center text-[13px] text-ink-secondary">
              Nothing shared yet. Bots add entries as they learn who is who and where things live, or add one yourself below.
            </div>
          )}

          {KINDS.map(({ kind, title, hint }) => {
            const rows = (entries ?? []).filter((entry) => entry.status === "accepted" && entry.kind === kind);
            if (rows.length === 0) return null;
            return (
              <section key={kind} className="mb-5">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary" title={hint}>
                  {title}
                </h3>
                <ul className="mt-2 divide-y divide-hairline/20 rounded-xl bg-inset">
                  {rows.map((entry) => (
                    <li key={entry.id} className="flex items-start gap-3 px-3 py-2 text-[13px]">
                      <span className="min-w-0 flex-1">
                        <span className="font-medium text-ink">{entry.name}</span>
                        {entry.aliases.length > 0 && <span className="text-ink-secondary"> (also {entry.aliases.join(", ")})</span>}
                        <input
                          defaultValue={entry.detail}
                          onBlur={(event) => editDetail(entry, event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                          }}
                          aria-label={`${entry.name} detail`}
                          className="mt-0.5 block w-full rounded bg-transparent px-1 py-0.5 text-[12.5px] text-ink outline-none hover:bg-card focus:bg-card"
                        />
                        <span className="block px-1 text-[11px] text-ink-secondary">
                          {entry.source.botName || "you"} · {new Date(entry.updatedAt).toLocaleDateString()}
                        </span>
                      </span>
                      <button
                        onClick={() => void remove(entry)}
                        disabled={busyId === entry.id}
                        aria-label={`Remove ${entry.name}`}
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
                <select
                  value={draft.kind}
                  onChange={(event) => setDraft({ ...draft, kind: event.target.value as Kind })}
                  aria-label="Kind"
                  className="rounded-lg border border-hairline/40 bg-inset px-2 py-1 text-[13px] text-ink"
                >
                  {KINDS.map(({ kind, title }) => (
                    <option key={kind} value={kind}>
                      {title.replace(/s$/, "")}
                    </option>
                  ))}
                </select>
                <input
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="Name"
                  aria-label="Name"
                  className="min-w-[140px] flex-1 rounded-lg border border-hairline/40 bg-inset px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
                />
              </div>
              <input
                value={draft.detail}
                onChange={(event) => setDraft({ ...draft, detail: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") add();
                }}
                placeholder="What every bot should know about it"
                aria-label="Detail"
                className="mt-2 w-full rounded-lg border border-hairline/40 bg-inset px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={add}
                  disabled={busyId === "new" || !draft.name.trim() || !draft.detail.trim()}
                  className="rounded-lg bg-accent px-3 py-1 text-[12.5px] font-medium text-white disabled:opacity-50"
                >
                  {busyId === "new" ? "Adding…" : "Add"}
                </button>
                <button onClick={() => setAdding(false)} className="text-[12.5px] text-ink-secondary hover:text-ink">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setAdding(true)}
              className={cn("flex items-center gap-1.5 text-[12.5px] text-ink-secondary hover:text-ink", entries === null && "hidden")}
            >
              <Plus size={13} /> Add an entry
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
