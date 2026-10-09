import { useEffect, useMemo, useRef, useState } from "react";
import { Database, Loader2 } from "lucide-react";
import type { DataCard as DataCardModel } from "../../../shared/data-surface";
import { useStore, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { useColorScheme } from "@/lib/color-scheme";
import { SourcesStrip } from "./SourcesStrip";
import { DataCard, SourceView } from "./DataCard";
import { ColumnExplorer } from "./ColumnExplorer";
import { SqlEditor } from "./SqlEditor";
import { cardsOldestFirst, sqlNamespace } from "./data-format";

/** The Data tab: the bot's loaded tables along the top, the stream of cards
 * (newest at the bottom) with the column explorer beside it, and the
 * person's own SQL underneath. The sheet comes from the store (one GET on
 * first open, then every `data` frame); rows never do, the grid pages them. */
export function DataPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const sheet = state.dataSheets[bot.id];
  const theme = useColorScheme();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [openSource, setOpenSource] = useState<string | null>(null);
  const [explorer, setExplorer] = useState<{ table: string; title: string } | null>(null);
  const [editing, setEditing] = useState<{ cardId: string; title: string; sql: string } | null>(null);
  const stream = useRef<HTMLDivElement>(null);
  const requested = useRef<string | null>(null);

  // One GET per bot per mount; the frame stream keeps it current after that.
  useEffect(() => {
    if (sheet || requested.current === bot.id) return;
    requested.current = bot.id;
    setLoadError(null);
    dispatch({ type: "loadDataSheet", botId: bot.id, onError: setLoadError });
  }, [bot.id, sheet, dispatch]);

  const cards = useMemo(() => cardsOldestFirst(sheet?.cards ?? []), [sheet?.cards]);
  const schema = useMemo(() => sqlNamespace(sheet), [sheet]);
  const source = sheet?.sources.find((candidate) => candidate.name === openSource) ?? null;
  const running = cards.find((card) => card.status === "running" && card.by === "person") ?? null;
  // The card being edited may vanish (removed by the bot or the person).
  useEffect(() => { if (editing && !cards.some((card) => card.id === editing.cardId)) setEditing(null); }, [cards, editing]);
  // Newest at the bottom: a new card scrolls into view.
  const cardCount = cards.length;
  useEffect(() => { stream.current?.scrollTo({ top: stream.current.scrollHeight }); }, [cardCount]);

  const openSourceTable = (name: string) => {
    setOpenSource(name);
    setExplorer({ table: name, title: name });
    stream.current?.scrollTo({ top: 0 });
  };
  const edit = (card: DataCardModel) => { if (card.sql) setEditing({ cardId: card.id, title: card.title, sql: card.sql }); };
  const run = (sql: string) => {
    setRunError(null);
    dispatch({ type: "runDataSql", botId: bot.id, request: { sql, ...(editing ? { cardId: editing.cardId } : {}) }, onError: setRunError });
  };
  const cancel = () => { if (running) dispatch({ type: "cancelDataCard", botId: bot.id, cardId: running.id }); };
  const empty = sheet && cards.length === 0 && sheet.sources.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-hairline/40 bg-card text-ink" data-testid="data-panel">
      <SourcesStrip sources={sheet?.sources ?? []} selected={openSource} onOpen={openSourceTable} />
      <div className="flex min-h-0 flex-1">
        <div ref={stream} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto bg-inset/40 p-3">
          {!sheet && !loadError && (
            <p className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-ink-secondary" role="status">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("data.loading")}
            </p>
          )}
          {loadError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{t("data.loadFailed", { reason: loadError })}</p>}
          {empty && (
            <div className="flex flex-col items-center gap-3 py-12 text-center" data-testid="data-empty">
              <Database size={22} className="text-ink-secondary" aria-hidden="true" />
              <p className="text-[13px] text-ink-secondary">{t("data.empty")}</p>
            </div>
          )}
          {source && <SourceView bot={bot} name={source.name} columns={source.columns} rowCount={source.rowCount} onClose={() => setOpenSource(null)} />}
          {cards.map((card) => (
            <DataCard key={card.id} bot={bot} card={card} theme={theme} onEdit={edit}
              onExplore={(table, title) => setExplorer({ table, title })} />
          ))}
          {runError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{t("data.card.runFailed", { reason: runError })}</p>}
        </div>
        {explorer && <ColumnExplorer key={explorer.table} botId={bot.id} table={explorer.table} title={explorer.title} onClose={() => setExplorer(null)} />}
      </div>
      <SqlEditor schema={schema} editing={editing} running={running !== null} theme={theme}
        onRun={run} onCancel={cancel} onStopEditing={() => setEditing(null)} />
    </div>
  );
}
