import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Search } from "lucide-react";
import { useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { scrollParent, scrollWithin } from "@/lib/scroll-within";
import { t } from "@/lib/i18n";
import { LmStudioServer, OtherOpenAiCompatServers } from "../OpenAiCompatServers";
import { KEY_CATALOG, KEY_SECTIONS, keyMatches, savedState, type KeyEntry, type KeyId, type KeySectionId } from "./key-catalog";
import { finishKeyFocus, useKeyFocus, type KeyFocusRequest } from "./key-focus";
import { AnthropicEveryClaudeBot, OpenAiCompatUrl, OpenCodeProviderKeys, VpsConnection } from "./KeyPanels";
import { KEY_ROW, KeyRow, MaskedKey, RowHeading, type KeyStatus } from "./KeyRow";

const CARD = "rounded-xl bg-card in-data-[settings-look=simple]:rounded-[12px] in-data-[settings-look=simple]:border-[0.5px] in-data-[settings-look=simple]:border-(--settings-edge) in-data-[settings-look=simple]:bg-menu";
const HIGHLIGHT_MS = 1600;

const PANELS: Partial<Record<KeyId, () => ReactNode>> = {
  opencodeProviders: () => <OpenCodeProviderKeys />,
  lmStudio: () => <LmStudioServer heading={false} />,
  vps: () => <VpsConnection />,
};

const EXTRAS: Partial<Record<KeyId, () => ReactNode>> = {
  anthropic: () => <AnthropicEveryClaudeBot />,
  openaiCompat: () => <><OpenAiCompatUrl /><OtherOpenAiCompatServers /></>,
};

function connected(entry: KeyEntry, config: ConfigStatus | null | undefined): boolean {
  if (entry.kind === "uses") return false;
  const saved = savedState(entry, config);
  return saved.configured || saved.included === true;
}

function PanelRow({ entry }: { entry: KeyEntry }) {
  const { state } = useStore();
  const titleId = useId();
  const saved = savedState(entry, state.config);
  const status: KeyStatus = saved.configured ? { tone: "ok", text: t("keys.connected") } : null;
  return (
    <div data-key-row={entry.id} role="group" aria-labelledby={titleId} className={KEY_ROW}>
      <RowHeading entry={entry} status={status} titleId={titleId} />
      <div className="flex flex-col gap-2 pl-8">{PANELS[entry.id]?.()}</div>
    </div>
  );
}

function ElsewhereRow({ entry }: { entry: KeyEntry }) {
  const { state, dispatch } = useStore();
  const titleId = useId();
  const opens = entry.opens;
  const saved = savedState(entry, state.config);
  const status: KeyStatus = saved.configured ? { tone: "ok", text: t("keys.connected") } : null;
  return (
    <div data-key-row={entry.id} role="group" aria-labelledby={titleId} className={KEY_ROW}>
      <RowHeading entry={entry} status={status} titleId={titleId} />
      <div className="flex flex-col gap-2 pl-8">
        {saved.configured && <div className="flex"><MaskedKey saved={saved} label={t(entry.labelKey)} /></div>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {entry.whereKey && <span className="min-w-0 flex-1 text-[12px] leading-4 text-ink-secondary">{t(entry.whereKey)}</span>}
          {opens && (
            <button type="button" data-key-open className="ui-button shrink-0" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: opens })}>
              {t("keys.row.open")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function KeyCatalogRow({ entry }: { entry: KeyEntry }) {
  if (entry.kind === "uses" && entry.uses) return <KeyRow id={entry.uses} row={entry.id} />;
  if (entry.kind === "panel") return <PanelRow entry={entry} />;
  if (entry.kind === "elsewhere") return <ElsewhereRow entry={entry} />;
  return <KeyRow id={entry.id}>{EXTRAS[entry.id]?.()}</KeyRow>;
}

function KeySection({ id, rows, open, onToggle }: { id: KeySectionId; rows: KeyEntry[]; open: boolean; onToggle: () => void }) {
  const { state } = useStore();
  const section = KEY_SECTIONS.find((candidate) => candidate.id === id)!;
  const headId = useId();
  const bodyId = useId();
  const count = rows.filter((entry) => connected(entry, state.config)).length;
  return (
    <section data-keys-section={id} aria-labelledby={headId} className={CARD}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-3 rounded-[inherit] px-4 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span id={headId} className="text-[14px] font-medium leading-5 text-ink">{t(section.titleKey)}</span>
          <span className="text-[13px] leading-[18px] text-ink-secondary">{t(section.purposeKey)}</span>
        </span>
        {count > 0 && <span className="shrink-0 text-[12px] leading-4 text-ink-secondary">{t("keys.section.connected", { count })}</span>}
        <ChevronRight size={14} aria-hidden="true" className={cn("shrink-0 text-ink-secondary transition-transform motion-reduce:transition-none", open && "rotate-90")} />
      </button>
      <div id={bodyId} hidden={!open} className="flex flex-col gap-0.5 border-t border-hairline/40 px-1 py-1.5 in-data-[settings-look=simple]:border-t-[0.5px] in-data-[settings-look=simple]:border-(--settings-edge)">
        {rows.map((entry) => <KeyCatalogRow key={entry.id} entry={entry} />)}
      </div>
    </section>
  );
}

function landOn(page: HTMLElement | null, request: KeyFocusRequest, section: KeySectionId): boolean {
  const row = request.row ? page?.querySelector<HTMLElement>(`[data-key-row="${request.row}"]`) : page?.querySelector<HTMLElement>(`[data-keys-section="${section}"]`);
  if (!row || row.closest("[hidden]")) return false;
  const scroller = scrollParent(row);
  if (scroller) scrollWithin(scroller, row, request.row ? "center" : "start", 16);
  if (!request.row) return true;
  row.querySelector<HTMLElement>("[data-key-input], [data-key-replace], [data-key-own], [data-key-open], input, button")?.focus({ preventScroll: true });
  row.setAttribute("data-key-highlight", "");
  window.setTimeout(() => row.removeAttribute("data-key-highlight"), HIGHLIGHT_MS);
  return true;
}

export function KeysPage() {
  const { state } = useStore();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<KeySectionId>>(() => new Set(
    KEY_SECTIONS.filter((section) => section.id === "ai" || KEY_CATALOG.some((entry) => entry.section === section.id && connected(entry, state.config)))
      .map((section) => section.id),
  ));
  const pageRef = useRef<HTMLDivElement>(null);
  const focus = useKeyFocus();
  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (!focus) return;
    const section = KEY_CATALOG.find((entry) => entry.id === focus.row)?.section ?? "ai";
    setQuery("");
    setOpen((current) => current.has(section) ? current : new Set([...current, section]));
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      if (landOn(pageRef.current, focus, section) || ++tries > 60) finishKeyFocus(focus);
      else frame = window.requestAnimationFrame(attempt);
    };
    frame = window.requestAnimationFrame(attempt);
    return () => window.cancelAnimationFrame(frame);
  }, [focus]);

  const rows = KEY_CATALOG.filter((entry) => keyMatches(entry, q));
  const sections = KEY_SECTIONS.flatMap((section) => {
    const own = rows.filter((entry) => entry.section === section.id);
    return own.length > 0 ? [{ id: section.id, rows: own }] : [];
  });

  return (
    <div ref={pageRef} data-keys-page className="flex flex-col gap-4">
      <p className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.connections.subtitle")}</p>
      <div className="flex h-8 items-center gap-2 rounded-lg bg-ink/[0.05] px-[9px] focus-within:ring-2 focus-within:ring-focus/60">
        <Search size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        <input
          data-keys-search
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !query) return;
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
          }}
          placeholder={t("keys.search.placeholder")}
          aria-label={t("keys.search.aria")}
          autoComplete="off"
          spellCheck={false}
          className="w-full min-w-0 bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
      </div>
      {sections.length === 0 ? (
        <p data-keys-empty className="px-1 text-[13px] leading-[18px] text-ink-secondary">{t("keys.search.none", { query: query.trim() })}</p>
      ) : sections.map(({ id, rows: sectionRows }) => (
        <KeySection
          key={id}
          id={id}
          rows={sectionRows}
          open={q !== "" || open.has(id)}
          onToggle={() => setOpen((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })}
        />
      ))}
    </div>
  );
}
