import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, Search } from "lucide-react";

import { BOT_TASK_STATUSES, type BotTaskSummary } from "../../../shared/bot-tasks";
import {
  botTasksStatus, filterBotTasks, isBotTaskStatus, loadBotTasks, NO_FILTERS, readBotTasksLayout, repoChoices, saveBotTasksLayout, STATUS_LABEL,
  type BotTaskFilters, type BotTasksLayout, type BotTasksStatus,
} from "@/lib/bot-tasks";
import { cn } from "@/lib/cn";
import { onBotTaskChanged } from "@/lib/bot-task-events";
import { t } from "@/lib/i18n";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { Select } from "../Select";
import { Segmented } from "../SettingsPrimitives";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageHeader } from "../ToolPageShell";
import { BotTaskBoard, type BoardBot } from "./BotTaskBoard";
import { BotTaskDetail } from "./BotTaskDetail";
import { GithubRefChip, StatusChip, When } from "./parts";

const SEARCH_WAIT_MS = 250;

export function BotTaskFilterBar({ filters, onChange, bots, repos, layout, onLayout }: {
  filters: BotTaskFilters;
  onChange: (next: BotTaskFilters) => void;
  bots: ReadonlyArray<{ id: string; name: string }>;
  repos: readonly string[];
  layout?: BotTasksLayout;
  onLayout?: (next: BotTasksLayout) => void;
}) {
  return (
    <div role="search" data-bot-task-filters="" className="flex flex-wrap items-center gap-2">
      <label className="relative flex min-w-[min(100%,14rem)] flex-1 items-center">
        <Search size={14} aria-hidden="true" className="pointer-events-none absolute start-2.5 text-ink-tertiary" />
        <input type="search" dir="auto" value={filters.q} aria-label={t("botTasks.filter.search")} placeholder={t("botTasks.filter.search")}
          onChange={(event) => onChange({ ...filters, q: event.target.value })}
          className="h-8 w-full rounded-lg border border-hairline/40 bg-inset ps-8 pe-2 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-tertiary focus-visible:border-focus" />
      </label>
      <Select size="sm" aria-label={t("botTasks.filter.status")} value={filters.status} className="w-40"
        onChange={(event) => onChange({ ...filters, status: isBotTaskStatus(event.target.value) ? event.target.value : "" })}>
        <option value="">{t("botTasks.filter.anyStatus")}</option>
        {BOT_TASK_STATUSES.map((status) => <option key={status} value={status}>{t(STATUS_LABEL[status])}</option>)}
      </Select>
      <Select size="sm" aria-label={t("botTasks.filter.bot")} value={filters.bot} className="w-40" onChange={(event) => onChange({ ...filters, bot: event.target.value })}>
        <option value="">{t("botTasks.filter.anyBot")}</option>
        {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
      </Select>
      <Select size="sm" aria-label={t("botTasks.filter.repo")} value={filters.repo} className="w-48" onChange={(event) => onChange({ ...filters, repo: event.target.value })}>
        <option value="">{t("botTasks.filter.anyRepo")}</option>
        {repos.map((repo) => <option key={repo} value={repo}>{repo}</option>)}
      </Select>
      {layout && onLayout && (
        <div className="ms-auto">
          <Segmented<BotTasksLayout> label={t("botTasks.view.label")} value={layout} onChange={onLayout}
            options={[{ value: "board", label: t("botTasks.view.board") }, { value: "list", label: t("botTasks.view.list") }]} />
        </div>
      )}
    </div>
  );
}

export function BotTaskRow({ task, onOpen }: { task: BotTaskSummary; onOpen: () => void }) {
  return (
    <li data-bot-task-row={task.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-3 py-2.5 transition-colors hover:bg-ink/[0.06] motion-reduce:transition-none">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        <span dir="auto" title={task.title} className="w-full truncate text-[13px] font-medium leading-[18px] text-ink">{task.title}</span>
        <span className="flex w-full min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-secondary">
          <span className="min-w-0 truncate">{task.ownerName}</span>
          <span aria-hidden="true" className="text-ink-tertiary">·</span>
          <When at={task.updatedAt} />
        </span>
      </button>
      {task.github && <span className="order-last flex min-w-0 basis-full sm:order-none sm:max-w-[40%] sm:basis-auto"><GithubRefChip githubRef={task.github} /></span>}
      <StatusChip status={task.status} />
    </li>
  );
}

function Centered({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return <section role={alert ? "alert" : undefined} className="flex flex-col items-center gap-4 px-6 py-16 text-center">{children}</section>;
}

/** The person's view of the tasks their bots keep: a filtered list, and one task's whole story. */
export function BotTasksView({ settings, bots, onOpenSettings, openId, onOpen }: {
  settings: BotTasksStatus;
  bots: ReadonlyArray<BoardBot>;
  onOpenSettings: () => void;
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  const [filters, setFilters] = useState<BotTaskFilters>(NO_FILTERS);
  const [query, setQuery] = useState<BotTaskFilters>(NO_FILTERS);
  const [tasks, setTasks] = useState<BotTaskSummary[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [failed, setFailed] = useState(false);
  const [slow, setSlow] = useState(false);
  const [layout, setLayout] = useState<BotTasksLayout>(readBotTasksLayout);
  const loading = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(filters), filters.q === query.q ? 0 : SEARCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [filters, query.q]);

  const load = useCallback(async (wanted: BotTaskFilters) => {
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    setFailed(false);
    try {
      const answer = await loadBotTasks(wanted, controller.signal);
      if (controller.signal.aborted) return;
      setTasks(answer.tasks);
      setEnabled(answer.enabled);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    }
  }, []);
  useEffect(() => { void load(query); return () => loading.current?.abort(); }, [load, query]);
  // Live: any task changing reloads the list with the filters it shows, so a new or moved task appears without a refresh.
  useEffect(() => onBotTaskChanged(() => void load(query)), [load, query]);
  useEffect(() => {
    if (tasks || failed) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(timer);
  }, [tasks, failed]);

  const shown = useMemo(() => (tasks ? filterBotTasks(tasks, filters) : null), [tasks, filters]);
  const ownerChoices = useMemo(() => {
    const known = new Map(bots.map((bot) => [bot.id, bot.name]));
    for (const task of tasks ?? []) if (!known.has(task.ownerBotId)) known.set(task.ownerBotId, task.ownerName);
    return [...known].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [bots, tasks]);
  const repos = useMemo(() => repoChoices(settings.repos, tasks ?? []), [settings.repos, tasks]);
  const botName = useCallback((id: string) => ownerChoices.find((bot) => bot.id === id)?.name ?? id, [ownerChoices]);
  const filtered = filters.status !== "" || filters.bot !== "" || filters.repo !== "" || filters.q.trim() !== "";

  const chooseLayout = (next: BotTasksLayout) => { setLayout(next); saveBotTasksLayout(next); };
  const wide = !openId && layout === "board";
  const frame = (content: ReactNode) => <div className={cn("mx-auto w-full", wide ? "max-w-[110rem]" : "max-w-4xl")}>{content}</div>;

  if (openId) {
    return frame(<BotTaskDetail key={openId} id={openId} settings={settings} botName={botName} onChanged={() => void load(query)} />);
  }
  if (!enabled || !settings.enabled) {
    return frame(
      <Centered>
        <p className="text-[13px] text-ink-secondary">{t("botTasks.off")}</p>
        <button type="button" className="ui-button ui-button-md rounded-full" onClick={onOpenSettings}>{t("botTasks.openSettings")}</button>
      </Centered>,
    );
  }
  return frame(
    <div className="flex flex-col gap-4">
      <BotTaskFilterBar filters={filters} onChange={setFilters} bots={ownerChoices} repos={repos} layout={layout} onLayout={chooseLayout} />
      {failed && !tasks ? (
        <Centered alert>
          <p className="text-[13px] text-ink-secondary">{t("botTasks.loadFailed")}</p>
          <button type="button" className="ui-button ui-button-md rounded-full" onClick={() => void load(query)}>{t("common.tryAgain")}</button>
        </Centered>
      ) : !shown ? (
        <div className="flex min-h-40 items-center justify-center" aria-busy="true">
          {slow && <span role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={16} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />{t("botTasks.loading")}</span>}
        </div>
      ) : shown.length === 0 ? (
        <Centered>
          <p className="text-[13px] text-ink-secondary">{filtered ? t("botTasks.emptyFiltered") : t("botTasks.empty")}</p>
          {filtered && <button type="button" className="ui-button ui-button-md rounded-full" onClick={() => setFilters(NO_FILTERS)}>{t("botTasks.filter.clear")}</button>}
        </Centered>
      ) : (
        <>
          {failed && <p role="alert" className="text-[12px] leading-4 text-danger">{t("botTasks.refreshFailed")}</p>}
          {layout === "board" ? (
            <BotTaskBoard tasks={shown} settings={settings} bots={bots} onOpen={onOpen} onChanged={() => void load(query)} />
          ) : (
            <ul aria-label={t("botTasks.title")} data-bot-tasks={shown.length} className="-mx-3 flex flex-col">
              {shown.map((task) => <BotTaskRow key={task.id} task={task} onOpen={() => onOpen(task.id)} />)}
            </ul>
          )}
        </>
      )}
    </div>,
  );
}

export function BotTasksPage() {
  const config = useStoreSelector((state) => state.config);
  const allBots = useStoreSelector((state) => state.bots);
  const dispatch = useStoreDispatch();
  const settings = useMemo(() => botTasksStatus(config), [config]);
  const bots = useMemo(() => allBots.filter((bot) => !bot.hidden).map((bot) => ({ id: bot.id, name: bot.name, avatar: bot })), [allBots]);
  const [openId, setOpenId] = useState<string | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  return (
    <ToolPage label={t("botTasks.title")}>
      <ToolPageHeader backLabel={t("automations.back")} backRef={back}
        onBack={() => { if (openId) setOpenId(null); else dispatch({ type: "showChat" }); }}>
        <h1 className={TOOL_PAGE_TITLE}>{t("botTasks.title")}</h1>
      </ToolPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-bot-tasks-page={openId ? "detail" : "list"}>
        <div className="p-4 sm:p-6">
          <BotTasksView settings={settings} bots={bots} openId={openId} onOpen={setOpenId}
            onOpenSettings={() => dispatch({ type: "toggleAppSettings", open: true, section: "bot-tasks" })} />
        </div>
      </div>
    </ToolPage>
  );
}
