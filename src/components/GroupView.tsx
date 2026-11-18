import { AutoResumeNoticeCard } from "./AutoResumeNoticeCard";
import { UsageRings } from "./UsageRings";
// A room: several bots + you in one shared thread. Minimal by design — the
// mauses are the only expressive element. Members sit in the header (their
// idle/working motion IS the status), the bulletin is one pinned line, and
// bot messages carry a small maus + name cluster label. Bots reply only
// when @mentioned (the composer's @ picker knows the members).
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDown, ClipboardList, Pin, Smartphone, AlarmClock, Settings2 } from "lucide-react";
import { useStore, useStreaming, formatTime, type Attachment, type Bot, type Group } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { normalizeState } from "@/lib/mascot";
import { ChatMarkdown } from "./ChatMarkdown";
import { OPEN_PREVIEW_EVENT } from "@/lib/chatLinks";
import { SHOW_TESTING_EVENT, type ShowTestingDetail } from "@/lib/previewTestingStore";
import { Composer } from "./Composer";
import { ReactionBar, ReactionChips } from "./Reactions";
import { cn } from "@/lib/cn";
import { ProjectMentionText } from "./ProjectMentionText";
import { ProjectMentionTextarea } from "./ProjectMentionTextarea";
import { RoomActivityPanel } from "./RoomActivityPanel";
import { MobilePreviewPanel } from "./MobilePreviewPanel";
import { TasksPanel } from "./TasksPanel";
import { OptionCard } from "./OptionCard";
import { AttachmentList } from "./AttachmentViewer";
import { useHeaderCollapse } from "@/lib/useHeaderCollapse";
import { HeaderMoreMenu } from "./HeaderMoreMenu";
import { RoomSettings } from "./RoomSettings";
import { SHARED_HEADER_HEIGHT_CLASS } from "@/lib/layoutTokens";
import { getStoredPanelWidth } from "@/lib/usePanelResize";

function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** 16px maus + name, shown once per sender cluster. */
function ClusterLabel({ bot, name, color }: { bot?: Bot; name: string; color: string }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 pl-0.5">
      <MausAvatar
        color={(bot?.color ?? color) as Bot["color"]}
        state={normalizeState(bot?.mascotExpression) ?? "happy"}
        size={16}
        motion="none"
        motionKey={0}
      />
      <span className="text-[11px] font-medium text-ink-secondary">{name}</span>
    </div>
  );
}

const Transcript = memo(function Transcript({
  group,
  members,
}: {
  group: Group;
  members: Bot[];
}) {
  const memberOf = (id?: string) => members.find((b) => b.id === id);
  const textMessages = group.messages;
  return (
    <>
      {textMessages.map((m, i) => {
        const prev = textMessages[i - 1];
        const newDay = !prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString();
        const user = m.role === "user";
        const newCluster = !prev || prev.role !== m.role || prev.from?.botId !== m.from?.botId || newDay;
        const row =
          m.kind === "activity" && m.tool ? (
            <div className="flex justify-start">
              <div
                className={cn(
                  "flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px]",
                  m.tool.ok === false ? "text-danger" : "text-ink-secondary",
                )}
              >
                <span className="max-w-[480px] truncate font-mono">{m.tool.name}</span>
              </div>
            </div>
          ) : m.kind === "text" && (m.text || (m.attachments && m.attachments.length > 0)) ? (
            <div className={cn("group flex w-full flex-col", user ? "items-end" : "items-start")}>
              <div className={cn("flex w-full items-end gap-1.5", user ? "justify-end" : "justify-start")}>
                {user && <ReactionBar threadId={group.threadId} message={m} />}
                <div
                  className={cn(
                    "max-w-[70%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
                    user ? "whitespace-pre-wrap bg-bubble-user text-ink" : "bg-card text-ink",
                  )}
                  title={new Date(m.at).toLocaleString()}
                >
                  <AttachmentList attachments={m.attachments} />
                  {m.steered && <span className="mb-1 block text-[11px] text-ink-secondary" title={m.steered === "native" ? "Picked up at the next step" : undefined}>{m.steered === "failed" ? "Correction saved · delivery failed" : m.steered === "cancelled" ? "Correction saved · delivery stopped" : m.steered === "pending" ? "Sending correction…" : m.steered === "restarted" ? "Stopped and redirected" : m.steered === "queued" ? "Sent as the next turn" : "Sent mid-turn"}</span>}
                  {m.scheduled && <span className="mb-1 flex items-center gap-1 text-[11px] text-ink-secondary"><AlarmClock size={11} /> Scheduled</span>}
                  {m.text && (user ? <ProjectMentionText text={m.text} /> : <ChatMarkdown text={m.text} />)}
                </div>
                {!user && <ReactionBar threadId={group.threadId} message={m} />}
                <span className="self-end pb-1 text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100">
                  {formatTime(m.at)}
                </span>
              </div>
              <ReactionChips threadId={group.threadId} message={m} members={members} align={user ? "right" : "left"} />
            </div>
          ) : m.kind === "options" && m.card && m.from ? (
            <OptionCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : null;
        if (!row) return null;
        return (
          <div key={m.id} className="contents">
            {newDay && (
              <div className="py-3 text-center text-[13px] text-ink-secondary">
                {dayLabel(m.at)} {formatTime(m.at)}
              </div>
            )}
            {!user && m.from && newCluster && (
              <ClusterLabel bot={memberOf(m.from.botId)} name={m.from.name} color={m.from.color} />
            )}
            {row}
          </div>
        );
      })}
    </>
  );
});

function StreamingBubble({ text }: { text: string }) {
  const deferred = useDeferredValue(text);
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[70%] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink">
        <ChatMarkdown text={deferred} streaming />
        <span className="animate-caret ml-0.5 inline-block h-[14px] w-[2px] bg-ink align-middle" />
      </div>
    </div>
  );
}

export function GroupView({ group }: { group: Group }) {
  const { state, dispatch } = useStore();
  const stream = useStreaming();
  const streaming = stream.streaming[group.threadId];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const touchY = useRef(0);
  const [bulletinOpen, setBulletinOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bulletinDraft, setBulletinDraft] = useState(group.bulletin);
  const [activityOpen, setActivityOpen] = useState(() => {
    const saved = localStorage.getItem("room-activity-open");
    return saved === null ? window.matchMedia("(min-width: 1180px)").matches : saved === "true";
  });
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(
    () => localStorage.getItem("room-mobile-preview-open") === "true",
  );
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const [tasksOpen, setTasksOpen] = useState(() => localStorage.getItem("room-tasks-open") === "true");
  const mainRef = useRef<HTMLElement>(null);
  const [mainWidth, setMainWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 1180 - 320;
    const sidebar = getStoredPanelWidth("sidebar", 320);
    return Math.max(0, window.innerWidth - sidebar);
  });

  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) setMainWidth(rect.width);
    };
    update();
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setMainWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const isLargeScreen = mainWidth >= 860;
  const isDualPanelWide = mainWidth >= 1080;
  const previewAsDrawer = !isDualPanelWide && tasksOpen;

  const closeAllDrawers = useCallback(() => {
    setMobilePreviewOpen(false);
    setTasksOpen(false);
  }, []);

  const [lastRequestedDrawer, setLastRequestedDrawer] = useState<"preview" | "tasks">("preview");

  // A link or image clicked in a message, or a bot starting a Preview test, opens the Quick preview.
  useEffect(() => {
    const onOpen = (event: Event) => {
      setMobilePreviewOpen(true);
      if (event.type === SHOW_TESTING_EVENT) (event as CustomEvent<ShowTestingDetail>).detail.handled = true;
      if (!isLargeScreen) {
        setLastRequestedDrawer("preview");
        setTasksOpen(false);
      }
    };
    window.addEventListener(OPEN_PREVIEW_EVENT, onOpen);
    window.addEventListener(SHOW_TESTING_EVENT, onOpen);
    return () => {
      window.removeEventListener(OPEN_PREVIEW_EVENT, onOpen);
      window.removeEventListener(SHOW_TESTING_EVENT, onOpen);
    };
  }, [isLargeScreen]);

  const togglePreview = useCallback(() => {
    setMobilePreviewOpen((open) => {
      const next = !open;
      if (!isLargeScreen) {
        if (next) {
          setLastRequestedDrawer("preview");
          setTasksOpen(false);
        } else {
          setTasksOpen(false);
        }
      }
      return next;
    });
  }, [isLargeScreen]);

  const toggleTasks = useCallback(() => {
    setTasksOpen((open) => {
      const next = !open;
      if (!isLargeScreen) {
        if (next) {
          setLastRequestedDrawer("tasks");
          setMobilePreviewOpen(false);
        } else {
          setMobilePreviewOpen(false);
        }
      }
      return next;
    });
  }, [isLargeScreen]);

  const activeMobileDrawer: "preview" | "tasks" | null = useMemo(() => {
    if (isLargeScreen) return null;
    if (mobilePreviewOpen && tasksOpen) return lastRequestedDrawer;
    if (mobilePreviewOpen) return "preview";
    if (tasksOpen) return "tasks";
    return null;
  }, [isLargeScreen, mobilePreviewOpen, tasksOpen, lastRequestedDrawer]);

  // Escape key closes drawers at narrow viewports (<1180px)
  useEffect(() => {
    if (isLargeScreen) return;
    if (!mobilePreviewOpen && !tasksOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        setMobilePreviewOpen(false);
        setTasksOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isLargeScreen, mobilePreviewOpen, tasksOpen]);

  const estimatedInitialWidth = useMemo(() => {
    if (typeof window === "undefined") return 1024;
    const sidebarWidth = getStoredPanelWidth("sidebar", 320);
    const defaultPreview = window.innerWidth >= 1536 ? 420 : 380;
    const previewWidth = isDualPanelWide && mobilePreviewOpen ? getStoredPanelWidth("preview", defaultPreview) : 0;
    const tasksWidth = isDualPanelWide && tasksOpen ? getStoredPanelWidth("tasks", 320) : 0;
    return Math.max(300, window.innerWidth - sidebarWidth - previewWidth - tasksWidth);
  }, [isDualPanelWide, mobilePreviewOpen, tasksOpen]);

  const headerRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  const collapse = useHeaderCollapse({
    headerRef,
    nameRef,
    actionsRef,
    estimatedInitialWidth,
  });

  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)),
    [group.memberIds, state.bots],
  );
  const speaker = members.find((b) => b.id === group.busyBotId);
  const roomTasks = useMemo(
    () => (group.projectId ? state.tasks.filter((task) => task.projectId === group.projectId) : []),
    [state.tasks, group.projectId],
  );

  useEffect(() => { setFollow(true); setSettingsOpen(false); }, [group.id]);
  useEffect(() => setBulletinDraft(group.bulletin), [group.id, group.bulletin]);
  useEffect(() => localStorage.setItem("room-activity-open", String(activityOpen)), [activityOpen]);
  useEffect(() => localStorage.setItem("room-mobile-preview-open", String(mobilePreviewOpen)), [mobilePreviewOpen]);
  useEffect(() => localStorage.setItem("room-tasks-open", String(tasksOpen)), [tasksOpen]);
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [group.id, group.messages.length, streaming, group.busyBotId, follow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const saveBulletin = () => {
    setBulletinOpen(false);
    if (bulletinDraft !== group.bulletin) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { bulletin: bulletinDraft } });
    }
  };

  const isWin = window.gbs?.platform === "win32";
  const drag = isWin ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
  const noDrag = isWin ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

  const activityCount = Number(Boolean(group.busyBotId)) + (group.queuedBotIds?.length ?? 0);

  const tasksProjectPicker = (
    <label className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-secondary">
      Project
      <select
        value={group.projectId ?? ""}
        onChange={(event) =>
          dispatch({ type: "patchGroup", groupId: group.id, patch: { projectId: event.target.value || null } })
        }
        className="min-w-0 flex-1 rounded-md border border-hairline/50 bg-inset px-1.5 py-1 text-[11px] text-ink focus:border-accent focus:outline-none"
      >
        <option value="">No project</option>
        {state.taskProjects.map((project) => (
          <option key={project.id} value={project.id}>
            #{project.mention} · {project.name}
            {project.available ? "" : " (unavailable)"}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <main ref={mainRef} className="relative flex h-full min-w-0 flex-1 bg-app overflow-hidden">
      <section className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* Header: name left, member mauses right — their motion IS the status */}
      <div
        ref={headerRef}
        className={cn(
          "flex shrink-0 items-center justify-between gap-2 px-3.5 min-[1600px]:px-5 border-b border-transparent min-w-0 max-w-full",
          SHARED_HEADER_HEIGHT_CLASS,
          isWin && "pr-[148px]",
        )}
        style={drag}
      >
        <div ref={nameRef} className="flex min-w-0 shrink items-center gap-2">
          <span className="max-w-[10rem] truncate text-[15px] font-semibold text-ink">{group.name}</span>
          {/* Member avatars: when tight and more than 2 members, show first 2 plus a count badge */}
          {collapse.isTight && members.length > 2 ? (
            <div className="flex items-center -space-x-1.5 pr-1 shrink-0">
              {members.slice(0, 2).map((b) => (
                <span key={b.id} title={`${b.name}${group.busyBotId === b.id ? " — working…" : ""}`}>
                  <MausAvatar
                    color={b.color}
                    state={normalizeState(b.mascotExpression) ?? "happy"}
                    size={24}
                    motion={group.busyBotId === b.id ? "working" : "none"}
                    motionKey={group.busyBotId === b.id ? 1 : 0}
                  />
                </span>
              ))}
              <span className="flex h-6 items-center justify-center rounded-full bg-raised px-1.5 text-[10px] font-medium text-ink-secondary border border-hairline/60">
                +{members.length - 2}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 shrink-0">
              {members.map((b) => (
                <span key={b.id} title={`${b.name}${group.busyBotId === b.id ? " — working…" : ""}`}>
                  <MausAvatar
                    color={b.color}
                    state={normalizeState(b.mascotExpression) ?? "happy"}
                    size={24}
                    motion={group.busyBotId === b.id ? "working" : "none"}
                    motionKey={group.busyBotId === b.id ? 1 : 0}
                  />
                </span>
              ))}
            </div>
          )}
        </div>
        <div ref={actionsRef} className="flex shrink-0 items-center gap-1.5" style={noDrag}>
          {!group.dm && !collapse.collapseSecondaryToMenu && (
            <button
              type="button"
              title="Room settings"
              aria-label="Room settings"
              onClick={() => setSettingsOpen(true)}
              className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised"
            >
              <Settings2 size={16} />
            </button>
          )}
          {!collapse.collapseSecondaryToMenu && (
            <button
              type="button"
              title="Schedule run…"
              aria-label="Schedule run…"
              onClick={() => dispatch({ type: "openSchedule", target: { groupId: group.id } })}
              className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised"
            >
              <AlarmClock size={16} />
            </button>
          )}

          <UsageRings compact={collapse.isTight || !isDualPanelWide || tasksOpen} />
          {!collapse.collapseSecondaryToMenu && (
            <button
              type="button"
              onClick={() => setActivityOpen((open) => !open)}
              aria-label={activityOpen ? "Hide room activity" : "Show room activity"}
              aria-pressed={activityOpen}
              title={activityOpen ? "Hide room activity" : "Show room activity"}
              className={cn(
                "relative flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px]",
                activityOpen ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
              )}
            >
              <Activity size={14} />
              {collapse.showButtonsText && <span>Activity</span>}
              {activityCount > 0 && (
                <span className="flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
                  {activityCount}
                </span>
              )}
            </button>
          )}

          {collapse.collapseSecondaryToMenu && (
            <HeaderMoreMenu
              items={[
                ...(group.dm ? [] : [{
                  id: "settings",
                  label: "Room settings…",
                  icon: <Settings2 size={14} />,
                  onClick: () => setSettingsOpen(true),
                }]),
                {
                  id: "schedule",
                  label: "Schedule run…",
                  icon: <AlarmClock size={14} />,
                  onClick: () => dispatch({ type: "openSchedule", target: { groupId: group.id } }),
                },
                {
                  id: "activity",
                  label: "Room activity",
                  icon: <Activity size={14} />,
                  onClick: () => setActivityOpen((o) => !o),
                },
              ]}
            />
          )}
          <button
            type="button"
            onClick={togglePreview}
            aria-label={mobilePreviewOpen ? "Hide mobile preview" : "Show mobile preview"}
            aria-pressed={mobilePreviewOpen}
            title={mobilePreviewOpen ? "Hide mobile preview" : "Show mobile preview"}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px]",
              mobilePreviewOpen ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
            )}
          >
            <Smartphone size={14} />
            {collapse.showButtonsText && <span>Preview</span>}
          </button>
          <button
            type="button"
            onClick={toggleTasks}
            aria-label={tasksOpen ? "Hide tasks" : "Show tasks"}
            aria-pressed={tasksOpen}
            title={tasksOpen ? "Hide tasks" : "Show tasks"}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px]",
              tasksOpen ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
            )}
          >
            <ClipboardList size={14} />
            {collapse.showButtonsText && <span>Tasks</span>}
            {roomTasks.length > 0 && (
              <span className="flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
                {roomTasks.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Bulletin: one pinned line; click to edit */}
      <div className="mx-auto w-full max-w-[900px] px-5">
        {bulletinOpen ? (
          <div className="mb-1 rounded-lg border border-hairline/40 bg-panel p-2">
            <ProjectMentionTextarea
              autoFocus
              value={bulletinDraft}
              onValueChange={setBulletinDraft}
              onBlur={saveBulletin}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveBulletin();
                if (e.key === "Escape") {
                  setBulletinDraft(group.bulletin);
                  setBulletinOpen(false);
                }
              }}
              placeholder="Room instructions — use # to give every bot project context"
              rows={4}
              className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
        ) : (
          <div
            role="button"
            tabIndex={0}
            onClick={() => setBulletinOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setBulletinOpen(true);
              }
            }}
            className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-raised/40"
            title="Room bulletin — shared instructions for every bot here"
          >
            <Pin size={12} className="shrink-0 text-ink-secondary" />
            <span className={cn("truncate text-[12.5px]", group.bulletin ? "text-ink-secondary" : "text-ink-secondary/60")}>
              {group.bulletin ? <ProjectMentionText text={group.bulletin.split("\n")[0]} /> : "Add room instructions…"}
            </span>
          </div>
        )}
      </div>

      {/* Error banner — same as ChatView, so a refused room send is visible */}
      {state.error && (
        <div className="mx-auto w-full max-w-[900px] px-5 pt-2">
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.error}
          </div>
        </div>
      )}

      {/* Transcript */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 [overflow-anchor:none]"
        onWheel={(e) => {
          if (e.deltaY < 0) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onScroll={() => {
          if (!follow && atEnd()) setFollow(true);
        }}
      >
        <div
          className="mx-auto flex max-w-[900px] flex-col gap-3 pb-4"
          role="log"
          aria-live="polite"
          aria-label={`Room ${group.name}`}
        >
          {group.messages.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
              <div className="flex -space-x-2">
                {members.slice(0, 3).map((b) => (
                  <MausAvatar key={b.id} color={b.color} state="happy" size={44} motion="none" motionKey={0} />
                ))}
              </div>
              <div className="text-[17px] font-semibold text-ink">{group.name}</div>
              <div className="max-w-[380px] text-[14px] text-ink-secondary">
                Mention a bot with @ to bring them in, and a project with # to share its workspace.
              </div>
            </div>
          )}
          <Transcript group={group} members={members} />
          {speaker && !streaming && (
            <>
              <ClusterLabel bot={speaker} name={speaker.name} color={speaker.color} />
              <div className="flex justify-start">
                <div className="flex items-center gap-1.5 rounded-2xl bg-raised px-4 py-3">
                  <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:0ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:150ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:300ms]" />
                </div>
              </div>
            </>
          )}
          {speaker && streaming && (
            <>
              <ClusterLabel bot={speaker} name={speaker.name} color={speaker.color} />
              <StreamingBubble text={streaming} />
            </>
          )}
        </div>
      </div>

      {!follow && (
        <button
          onClick={() => {
            setFollow(true);
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
          }}
          aria-label="Jump to latest messages"
          className="animate-pop-in absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}

      <AutoResumeNoticeCard threadId={group.threadId} />
      <Composer
        key={group.id}
        group={group}
        members={members}
        pendingAttachment={previewAttachment}
        onPendingAttachmentConsumed={() => setPreviewAttachment(null)}
      />
      </section>

      {activityOpen && (
        <RoomActivityPanel
          group={group}
          members={members}
          onClose={() => setActivityOpen(false)}
          className="hidden min-[1180px]:flex"
        />
      )}

      {activityOpen && (
        <>
          <button
            type="button"
            aria-label="Close activity panel"
            onClick={() => setActivityOpen(false)}
            className="absolute inset-0 z-20 bg-black/55 min-[1180px]:hidden"
          />
          <RoomActivityPanel
            group={group}
            members={members}
            onClose={() => setActivityOpen(false)}
            className="absolute inset-y-0 right-0 z-30 flex max-w-[88vw] shadow-2xl min-[1180px]:hidden"
          />
        </>
      )}

      {/* Drawer mode: Single backdrop for narrow viewports (< 860px main width) */}
      {!isLargeScreen && activeMobileDrawer && (
        <button
          type="button"
          aria-label={activeMobileDrawer === "preview" ? "Close mobile preview panel" : "Close tasks panel"}
          onClick={closeAllDrawers}
          className="absolute inset-0 z-20 bg-black/55"
        />
      )}

      {/* Preview drawer below 860px main width */}
      {!isLargeScreen && mobilePreviewOpen && activeMobileDrawer === "preview" && (
        <MobilePreviewPanel
          onClose={closeAllDrawers}
          onScreenshot={setPreviewAttachment}
          docked={false}
          className="absolute inset-y-0 right-0 z-30 flex max-w-full shadow-2xl"
        />
      )}

      {/* Tasks drawer below 860px main width */}
      {!isLargeScreen && tasksOpen && activeMobileDrawer === "tasks" && (
        <TasksPanel
          tasks={roomTasks}
          emptyLabel={group.projectId ? "No tasks in this project yet." : "Set a project above to see its tasks here."}
          headerExtra={tasksProjectPicker}
          onClose={closeAllDrawers}
          docked={false}
          className="absolute inset-y-0 right-0 z-30 flex max-w-full shadow-2xl"
        />
      )}

      {/* Large screen (>= 1180px): Preview (docked or overlay drawer) */}
      {isLargeScreen && mobilePreviewOpen && (
        <>
          {previewAsDrawer && (
            <button
              type="button"
              aria-label="Close mobile preview panel"
              onClick={() => setMobilePreviewOpen(false)}
              className="absolute inset-0 z-20 bg-black/55"
            />
          )}
          <MobilePreviewPanel
            onClose={() => setMobilePreviewOpen(false)}
            onScreenshot={setPreviewAttachment}
            docked={!previewAsDrawer}
            className={cn(
              previewAsDrawer
                ? "absolute inset-y-0 right-0 z-30 flex max-w-full shadow-2xl"
                : "relative inset-auto z-auto max-w-none shadow-none flex",
            )}
          />
        </>
      )}

      {/* Large screen (>= 1180px): Tasks docks statically */}
      {isLargeScreen && tasksOpen && (
        <TasksPanel
          tasks={roomTasks}
          emptyLabel={group.projectId ? "No tasks in this project yet." : "Set a project above to see its tasks here."}
          headerExtra={tasksProjectPicker}
          onClose={() => setTasksOpen(false)}
          docked={true}
          className="flex"
        />
      )}
      {settingsOpen && <RoomSettings groupId={group.id} onClose={() => setSettingsOpen(false)} />}
    </main>
  );
}
