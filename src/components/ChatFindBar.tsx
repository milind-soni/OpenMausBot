import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { landOnSearchHit } from "@/lib/focus-message";
import type { SearchHit } from "@/lib/search-hit";
import { api, useStore } from "@/state/store";

export function ChatFindBar({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    const request = ++requestRef.current;
    if (!trimmed) {
      setHits([]);
      setIndex(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void api(`/api/search?q=${encodeURIComponent(trimmed)}&limit=100&threadId=${encodeURIComponent(threadId)}`)
        .then((body) => {
          if (request !== requestRef.current) return;
          setHits(Array.isArray(body?.hits) ? body.hits : []);
          setIndex(0);
        })
        .catch((error) => {
          if (request !== requestRef.current) return;
          setHits([]);
          dispatch({ type: "error", message: error instanceof Error ? error.message : "Search failed" });
        })
        .finally(() => {
          if (request === requestRef.current) setLoading(false);
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [dispatch, query, threadId]);

  const land = (next: number) => {
    const hit = hits[next];
    if (!hit) return;
    setIndex(next);
    void landOnSearchHit(hit, state, dispatch).catch((error) =>
      dispatch({ type: "error", message: error instanceof Error ? error.message : "That message is unavailable" }),
    );
  };
  const move = (delta: number) => {
    if (!hits.length) return;
    land((index + delta + hits.length) % hits.length);
  };

  // Jump to the first match as soon as a new result set arrives.
  useEffect(() => {
    if (hits[0]) land(0);
    // `land` intentionally reads the state that produced this result set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits]);

  return (
    <div className="mx-auto w-full max-w-[900px] px-5 pb-2">
      <div className="flex items-center gap-1.5 rounded-xl border border-hairline/50 bg-panel px-2 py-1.5 shadow-sm">
        <Search size={15} className="shrink-0 text-ink-secondary" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "Enter") {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
          }}
          placeholder="Find in this conversation"
          aria-label="Find in this conversation"
          className="min-w-0 flex-1 bg-transparent px-1 text-[13px] text-ink outline-none placeholder:text-ink-secondary/70"
        />
        <span className="min-w-[58px] text-right text-[11.5px] tabular-nums text-ink-secondary">
          {loading ? "Searching…" : query.trim() ? (hits.length ? `${index + 1} of ${hits.length}` : "No results") : ""}
        </span>
        <button
          type="button"
          onClick={() => move(-1)}
          disabled={!hits.length}
          aria-label="Previous result"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-30"
        >
          <ChevronUp size={15} />
        </button>
        <button
          type="button"
          onClick={() => move(1)}
          disabled={!hits.length}
          aria-label="Next result"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-30"
        >
          <ChevronDown size={15} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close find"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
