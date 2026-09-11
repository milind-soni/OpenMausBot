import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Hand, Layers, Network, RefreshCw, Send, X } from "lucide-react";
import { api, openThread, useStore } from "@/state/store";
import type { StudioHandoff, StudioSnapshot, StudioTarget } from "../../../shared/live-team";
import { stationState, studioPage } from "@/lib/live-team";
import { studioMotions, type StudioMotion, type StudioMotionState } from "@/lib/live-team-motion";
import { readStudioPreferences, saveStudioPreferences, type StudioPreferences } from "@/lib/live-team-preferences";
import { activeLocale, t } from "@/lib/i18n";
import { TeamMapPage } from "../TeamMapPage";
import { StudioTransfers } from "./StudioTransfers";
import { StudioHandoffDetail } from "./StudioHandoffDetail";
import { StudioStation } from "./StudioStation";
import "./live-team.css";

const freshPreferences: StudioPreferences = { presentation: "map", room: "", calm: false };
function storage(): Storage | undefined { try { return window.localStorage; } catch { return undefined; } }
function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (offset: number) => void }) {
  if (total <= 50) return null;
  return <nav className="studio-pagination" aria-label={t("studio.historyPages")}>
    <button disabled={!offset} onClick={() => onChange(Math.max(0, offset - 50))} aria-label={t("studio.previous")}><ArrowLeft size={16} /></button>
    <span>{Math.min(offset + 1, total)}–{Math.min(offset + 50, total)} / {total}</span>
    <button disabled={offset + 50 >= total} onClick={() => onChange(offset + 50)} aria-label={t("studio.next")}><ArrowRight size={16} /></button>
  </nav>;
}

/** Kept mounted by Shell to preserve drafts and return focus. Polls only while visible. */
export function LiveTeamStudio({ active, onNavigate }: { active: boolean; onNavigate: (computerBotId?: string) => void }) {
  const { state, dispatch } = useStore();
  const [snapshot, setSnapshot] = useState<StudioSnapshot | null>(null);
  const [preferences, setPreferences] = useState(freshPreferences);
  const preferencesRef = useRef(preferences);
  const workspace = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const attentionAnnouncement = useRef<{ scope: string; count: number } | null>(null);
  const [handoffDetail, setHandoffDetail] = useState<StudioHandoff | null>(null);
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<{ kind: "tasks" | "attention"; botId: string } | null>(null);
  const [offsets, setOffsets] = useState({ attentionOffset: 0, resultsOffset: 0, handoffsOffset: 0 });
  const [taskOffset, setTaskOffset] = useState(0);
  const attentionBotId = detail?.kind === "attention" ? detail.botId : "";
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState<{ botId: string; threadId: string; sendId: string } | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState(false);
  const [motion, setMotion] = useState<{ items: StudioMotion[]; overflow: number }>({ items: [], overflow: 0 });
  const motionState = useRef<StudioMotionState | null>(null);
  const reconnect = useRef(true);
  const root = useRef<HTMLElement>(null);
  const focusOnReturn = useRef(false);
  const updatePreferences = (patch: Partial<StudioPreferences>) => {
    if (patch.presentation || patch.room !== undefined) reconnect.current = true;
    const next = { ...preferencesRef.current, ...patch };
    preferencesRef.current = next;
    setPreferences(next);
    if (workspace.current) saveStudioPreferences(workspace.current, next, storage());
  };
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === "visible");
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduce = () => setReducedMotion(media.matches);
    document.addEventListener("visibilitychange", change);
    media.addEventListener("change", reduce);
    return () => { document.removeEventListener("visibilitychange", change); media.removeEventListener("change", reduce); };
  }, []);
  const calm = preferences.calm || reducedMotion || !visible || !active;
  const room = preferences.room;
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (!active || !visible) { reconnect.current = true; return; }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const params = new URLSearchParams({ room: preferencesRef.current.room, ...Object.fromEntries(Object.entries(offsets).map(([key, value]) => [key, String(value)])) });
        if (attentionBotId) params.set("attentionBotId", attentionBotId);
        const next: StudioSnapshot = await api(`/api/team-map/studio?${params}`, { signal: controller.signal });
        if (stopped) return;
        if (workspace.current !== next.workspaceId) {
          workspace.current = next.workspaceId;
          const restored = readStudioPreferences(next.workspaceId, storage());
          preferencesRef.current = restored;
          setPreferences(restored);
          motionState.current = null;
          setDraft(""); setTarget(null); setSelected(""); setDetail(null);
          if (restored.room !== next.room) { setRefreshKey((key) => key + 1); return; }
        }
        const transition = studioMotions(motionState.current, next, reconnect.current);
        motionState.current = transition.state;
        reconnect.current = false;
        setMotion({ items: transition.motions, overflow: transition.overflow });
        setSnapshot((previous) => previous?.revision === next.revision ? previous : next);
        setError(null);
      } catch (failure) {
        if (stopped) return;
        reconnect.current = true;
        setMotion({ items: [], overflow: 0 });
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (!stopped && preferencesRef.current.presentation === "studio") timer = setTimeout(refresh, 3000);
      }
    };
    void refresh();
    return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [active, visible, room, offsets, preferences.presentation, refreshKey, attentionBotId]);
  useEffect(() => {
    if (!active) { focusOnReturn.current = true; return; }
    if (!focusOnReturn.current || !selected) return;
    focusOnReturn.current = false;
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-station="${CSS.escape(selected)}"] button`)?.focus());
  }, [active, selected]);
  useEffect(() => {
    if (!motion.items.length && !motion.overflow) return;
    const timeout = setTimeout(() => setMotion({ items: [], overflow: 0 }), 1600);
    return () => clearTimeout(timeout);
  }, [motion]);
  useEffect(() => {
    const visible = new Set(state.bots.filter((bot) => !bot.hidden).map((bot) => bot.id));
    if (handoffDetail && (!visible.has(handoffDetail.sourceBotId) || !visible.has(handoffDetail.targetBotId))) setHandoffDetail(null);
    if (detail && !visible.has(detail.botId)) { setDetail(null); setOffsets((value) => ({ ...value, attentionOffset: 0 })); }
  }, [state.bots, handoffDetail, detail]);
  useEffect(() => {
    if (!snapshot) return;
    const scope = `${snapshot.workspaceId}:${snapshot.room}`;
    const count = snapshot.rooms.find((room) => room.id === snapshot.room)?.attentionCount ?? 0;
    const previous = attentionAnnouncement.current;
    attentionAnnouncement.current = { scope, count };
    if (active && preferences.presentation === "studio" && previous?.scope === scope && count > previous.count) {
      setNotice(t("studio.attentionNotice", { count, room: snapshot.room || t("studio.general") }));
    }
  }, [snapshot, active, preferences.presentation]);
  useEffect(() => {
    if (!detail) return;
    // On narrow layouts the inspector sits below the desks. Reveal and focus
    // it once when opened, without stealing focus on metadata refreshes.
    const frame = requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".studio-detail")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [detail?.kind, detail?.botId]);
  const closeDetails = () => {
    setDetail(null);
    setOffsets((value) => ({ ...value, attentionOffset: 0 }));
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-station="${CSS.escape(selected)}"] button`)?.focus());
  };
  const latest = useRef({ state, onNavigate, snapshot });
  latest.current = { state, onNavigate, snapshot };
  const open = useCallback((target: StudioTarget, computer = false) => {
    const { state, onNavigate } = latest.current;
    const bot = state.bots.find((bot) => bot.id === target.botId && !bot.hidden);
    const own = bot && (bot.threadId === target.threadId || bot.tasks?.some((task) => task.threadId === target.threadId));
    const group = state.groups.find((group) => (group.threadId === target.threadId || group.tasks?.some((task) => task.threadId === target.threadId)) && group.memberIds.includes(target.botId));
    if (!bot || (!own && !group)) { setNotice(t("studio.targetGone")); return; }
    setSelected(target.botId);
    onNavigate(computer ? target.botId : undefined);
    if (computer) dispatch({ type: "select", id: bot.id });
    else openThread(dispatch, target, state);
    if (target.messageId && !computer) dispatch({ type: "focusMessage", threadId: target.threadId, messageId: target.messageId });
    if (computer) dispatch({ type: "toggleComputer", open: true });
  }, [dispatch]);
  const openBot = useCallback((id: string) => { const bot = latest.current.state.bots.find((bot) => bot.id === id); if (bot) open({ botId: id, threadId: bot.threadId }); }, [open]);
  const openComputer = useCallback((id: string) => { const bot = latest.current.state.bots.find((bot) => bot.id === id); if (bot) open({ botId: id, threadId: bot.threadId }, true); }, [open]);
  const stage = useCallback((botId: string) => {
    if (sendingRef.current) return;
    setSelected(botId); setTarget({ botId, threadId: "", sendId: crypto.randomUUID() }); setSendError(false);
  }, []);
  const selectStation = useCallback((botId: string) => setSelected(botId), []);
  const tasks = useCallback((botId: string) => { setSelected(botId); setTaskOffset(0); setDetail({ kind: "tasks", botId }); setOffsets((value) => ({ ...value, attentionOffset: 0 })); }, []);
  const attention = useCallback((botId: string) => {
    setSelected(botId);
    const current = latest.current.snapshot;
    const requests = current?.attention.items.filter((item) => item.botId === botId) ?? [];
    if (current?.stations.find((station) => station.botId === botId)?.attentionCount === 1) {
      if (requests.length === 1) { open(requests[0], requests[0].kind === "computer"); return; }
      void api(`/api/team-map/studio?${new URLSearchParams({ room: current.room, attentionBotId: botId })}`).then((next: StudioSnapshot) => {
        if (next.attention.items.length === 1) open(next.attention.items[0], next.attention.items[0].kind === "computer");
        else { setNotice(t("studio.requestChanged")); setRefreshKey((key) => key + 1); }
      }).catch(() => setNotice(t("studio.requestUnavailable")));
      return;
    }
    setDetail({ kind: "attention", botId }); setOffsets((value) => ({ ...value, attentionOffset: 0 }));
  }, [open]);
  const submit = () => {
    if (!target || !draft.trim() || sendingRef.current || !state.connected) return;
    const bot = state.bots.find((bot) => bot.id === target.botId && !bot.hidden);
    if (!bot) { setSendError(true); return; }
    const pinned = { ...target };
    const text = draft.trim();
    sendingRef.current = true; setSending(true); setSendError(false);
    const fail = () => { sendingRef.current = false; setSending(false); setSendError(true); };
    const send = (threadId: string) => {
      setTarget({ ...pinned, threadId });
      dispatch({ type: "send", botId: pinned.botId, threadId, text, sendId: pinned.sendId, onError: fail,
        onSent: () => { sendingRef.current = false; setSending(false); setTarget(null); setDraft(""); setNotice(t("studio.sent", { name: bot.name })); setRefreshKey((key) => key + 1); } });
    };
    if (pinned.threadId) send(pinned.threadId);
    else dispatch({ type: "newTask", botId: pinned.botId, background: true, onCreated: send, onError: fail });
  };
  if (!active) return null;
  if (preferences.presentation === "map") return <TeamMapPage onStudio={() => updatePreferences({ presentation: "studio" })} />;
  const bots = state.bots.filter((bot) => !bot.hidden && snapshot?.rooms.find((room) => room.id === snapshot.room)?.botIds.includes(bot.id));
  const desks = studioPage(bots, query, page, (bot) => bot.name);
  const name = (id: string) => state.bots.find((bot) => bot.id === id && !bot.hidden)?.name ?? t("studio.missingBot");
  const targetBot = state.bots.find((bot) => bot.id === target?.botId && !bot.hidden);
  const detailBot = state.bots.find((bot) => bot.id === detail?.botId && !bot.hidden);
  const details = detailBot ? [...new Map([...(snapshot?.stations.find((station) => station.botId === detailBot.id)?.threads ?? []), ...(detailBot.tasks ?? [])].map((task) => [task.threadId, task])).values()] : [];
  const stale = Boolean(error) || !state.connected;
  return <main ref={root} className="live-team" data-calm={calm || stale} aria-label={t("studio.title")}>
    <header className="studio-header">
      <div><span className="studio-eyebrow">{t("studio.eyebrow")}</span><h1>{t("studio.title")}</h1></div>
      <div className="studio-header-actions">
        <button onClick={() => updatePreferences({ presentation: "map" })}><Network size={16} />{t("studio.map")}</button>
        <button aria-pressed={preferences.calm || reducedMotion} disabled={reducedMotion} onClick={() => updatePreferences({ calm: !preferences.calm })}>{(preferences.calm || reducedMotion) && <Check size={15} />}{t("studio.calm")}</button>
        <button aria-label={t("studio.refresh")} onClick={() => setRefreshKey((key) => key + 1)}><RefreshCw size={16} /></button>
      </div>
    </header>
    <div className="studio-toolbar">
      <label>{t("studio.room")}<select disabled={!snapshot?.rooms.length} value={snapshot?.room ?? room} onChange={(event) => { updatePreferences({ room: event.target.value }); setPage(0); setQuery(""); setDetail(null); setOffsets({ attentionOffset: 0, resultsOffset: 0, handoffsOffset: 0 }); reconnect.current = true; }}>
        {!snapshot?.rooms.length && <option value="">{t("studio.general")}</option>}
        {snapshot?.rooms.map((room) => <option key={room.id} value={room.id}>{room.id || t("studio.general")}{room.attentionCount ? ` · ${room.attentionCount} ${t("studio.waiting")}` : ""}</option>)}
      </select></label>
      <label className="studio-search"><span>{t("studio.findBot")}</span><input type="search" value={query} placeholder={t("studio.findBot")} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></label>
      <span className="studio-connection" data-stale={stale}>{stale ? t("studio.stale") : t("studio.live")}</span>
    </div>
    {stale && <p className="studio-warning" role="status">{t("studio.staleHelp")}{error && <span> {error}</span>}</p>}
    <div className="studio-announcement" role="status" aria-live="polite">{notice}</div>
    <div className="studio-body">
      <section className="studio-floor" aria-label={t("studio.workstations")}>
        <div className="studio-room-sign"><span>{snapshot?.room || t("studio.general")}</span><small>{t("studio.roomHint")}</small></div>
        {!snapshot ? <p className="studio-empty">{t("studio.loading")}</p> : !desks.items.length ? <div className="studio-empty"><Layers size={28} /><h2>{query ? t("studio.noMatch") : t("studio.empty")}</h2><p>{t("studio.emptyHint")}</p>{!query && <button onClick={() => dispatch({ type: "toggleNewBot", open: true })}>{t("studio.addBot")}</button>}</div> :
          <div className="studio-desks" data-count={desks.items.length}>{desks.items.map((bot) => {
            const station = snapshot.stations.find((station) => station.botId === bot.id);
            return <StudioStation key={bot.id} locale={activeLocale()} bot={bot} station={station} status={stationState(bot, station, snapshot, state.instances, stale)} calm={calm || stale} selected={selected === bot.id}
              onOpen={openBot} onComputer={openComputer}
              onAssign={stage} onTasks={tasks} onAttention={attention} onSelect={selectStation} />;
          })}</div>}
        {desks.pages > 1 && <nav className="studio-pagination" aria-label={t("studio.stationPages")}><button disabled={!desks.page} onClick={() => setPage(desks.page - 1)} aria-label={t("studio.previous")}><ArrowLeft size={16} /></button><span>{desks.page + 1} / {desks.pages}</span><button disabled={desks.page + 1 >= desks.pages} onClick={() => setPage(desks.page + 1)} aria-label={t("studio.next")}><ArrowRight size={16} /></button></nav>}

        {motion.overflow > 0 && <p className="studio-overflow">{t("studio.moreTransfers", { count: motion.overflow })}</p>}
      </section>
      <aside className="studio-side" aria-label={t("studio.teamActivity")}>
        <section className="studio-attention"><h2><Hand size={17} />{t("studio.attention")}<span>{snapshot?.attention.total ?? 0}</span></h2>
          {detail && <div className="studio-detail" tabIndex={-1} role="region" aria-label={detailBot?.name ?? t("studio.missingBot")}><div className="studio-section-heading"><h3>{detailBot?.name ?? t("studio.missingBot")}</h3><button aria-label={t("studio.closeDetails")} onClick={closeDetails}><X size={16} /></button></div>
            {detail.kind === "tasks" ? <>{details.slice(taskOffset, taskOffset + 50).map((task) => <button className="studio-list-item" key={task.threadId} onClick={() => open({ botId: detail.botId, threadId: task.threadId })}>{task.title || t("studio.conversation")}{task.busy && <span>{t("studio.state.working")}</span>}</button>)}{!details.length && <p>{t("studio.noTasks")}</p>}<Pagination offset={taskOffset} total={details.length} onChange={setTaskOffset} /></> : <p>{t("studio.attentionHint")}</p>}
          </div>}
          {!snapshot?.attention.total && <p className="studio-section-empty">{t("studio.noAttention")}</p>}
          {snapshot?.attention.items.filter((item) => !attentionBotId || item.botId === attentionBotId).map((item) => <button key={item.id} className="studio-list-item" onClick={() => open(item, item.kind === "computer")}><strong>{name(item.botId)}</strong><span>{t(`studio.request.${item.kind}`)}<ArrowRight size={14} /></span></button>)}
          {snapshot && <Pagination {...snapshot.attention} onChange={(attentionOffset) => setOffsets((value) => ({ ...value, attentionOffset }))} />}
        </section>
        <section className="studio-handoffs"><h2>{t("studio.handoffs")}<span>{snapshot?.handoffs.total ?? 0}</span></h2>
          {!snapshot?.handoffs.total && <p className="studio-section-empty">{t("studio.noHandoffs")}</p>}
          {snapshot?.handoffs.items.map((item) => <button key={item.id} className="studio-handoff" data-handoff={item.id} onClick={() => setHandoffDetail(item)}><span>{name(item.sourceBotId)} <ArrowRight size={13} /> {name(item.targetBotId)}</span><small>{t(`studio.handoff.${item.state}`)}</small></button>)}
          {snapshot && <Pagination {...snapshot.handoffs} onChange={(handoffsOffset) => setOffsets((value) => ({ ...value, handoffsOffset }))} />}
        </section>
      </aside>
      <section className="studio-results" aria-label={t("studio.results")}><div className="studio-section-heading"><div><span className="studio-eyebrow">{t("studio.resultsEyebrow")}</span><h2>{t("studio.results")}</h2></div><span>{snapshot?.results.total ?? 0}</span></div>
        {!snapshot?.results.total && <p className="studio-section-empty">{t("studio.noResults")}</p>}
        <div className="studio-result-slips">{snapshot?.results.items.map((item) => <button key={item.id} className="studio-result" data-result={item.id} data-outcome={item.status} onClick={() => open(item)}><span>{name(item.botId)} · {t(`studio.handoff.${item.status}`)}</span><strong>{item.title || t("studio.conversation")}</strong><small>{new Date(item.finishedAt).toLocaleString()}<ArrowRight size={16} /></small><em>{t("studio.openResult")}</em></button>)}</div>
        {snapshot && <Pagination {...snapshot.results} onChange={(resultsOffset) => setOffsets((value) => ({ ...value, resultsOffset }))} />}
      </section>
      {!calm && !stale && <StudioTransfers motions={motion.items} />}
    </div>
    {handoffDetail && <StudioHandoffDetail key={handoffDetail.id} handoff={handoffDetail} sourceName={name(handoffDetail.sourceBotId)} targetName={name(handoffDetail.targetBotId)} onClose={() => setHandoffDetail(null)} onOpen={(target) => { setHandoffDetail(null); open(target); }} />}
    <form className="studio-brief" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="studio-brief-heading"><label htmlFor="studio-brief">{t("studio.brief")}</label><span draggable={Boolean(draft.trim()) && !sending} onDragStart={(event) => { event.dataTransfer.setData("application/x-omb-studio-brief", "brief"); event.dataTransfer.effectAllowed = "copy"; }} className="studio-drag-slip" aria-label={t("studio.dragBrief")}><Send size={15} />{t("studio.dragBrief")}</span></div>
      <textarea id="studio-brief" value={draft} disabled={sending} placeholder={t("studio.briefPlaceholder")} onChange={(event) => { setDraft(event.target.value); if (target) setTarget({ ...target, sendId: crypto.randomUUID() }); setSendError(false); }} rows={2} />
      <div className="studio-send-row"><label>{t("studio.chooseBot")}<select aria-label={t("studio.chooseBot")} disabled={sending} value={target?.botId ?? ""} onChange={(event) => event.target.value ? stage(event.target.value) : setTarget(null)}><option value="">{t("studio.chooseBot")}</option>{state.bots.filter((bot) => !bot.hidden).map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      {target && <><label>{t("studio.destination")}<select disabled={sending || sendError} value={target.threadId} onChange={(event) => setTarget({ ...target, threadId: event.target.value, sendId: crypto.randomUUID() })}><option value="">{t("studio.newConversation")}</option>{targetBot?.tasks?.map((task) => <option key={task.threadId} value={task.threadId}>{task.title || t("studio.conversation")}</option>)}</select></label><button type="button" disabled={sending} onClick={() => { setTarget(null); setSendError(false); }}>{t("studio.cancel")}</button></>}
      <button className="studio-send" disabled={!targetBot || !draft.trim() || sending || !state.connected} type="submit"><Send size={15} />{sending ? t("studio.sending") : sendError ? t("studio.retry") : t("studio.send")}</button></div>
      {target && <p className="studio-send-review">{t("studio.review", { name: targetBot?.name ?? t("studio.missingBot") })}</p>}
      {sendError && <p role="alert" className="studio-warning">{t("studio.sendError")}</p>}
    </form>
  </main>;
}
