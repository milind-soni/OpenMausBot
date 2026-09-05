import { BookOpen, CalendarClock, ChevronDown, ChevronLeft, Crown, FolderOpen, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { stateForBot } from "@/lib/mascot";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { ModelPicker } from "./ModelPicker";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { builtInBrowserEnabled, skillRecorderEnabled } from "@/lib/feature-flags";
import { requestNotificationPermission } from "@/lib/notify";
import { botUsage, costCaption, formatTokens, formatUsd, hasFiniteCost } from "@/lib/usage";
import { shortPath } from "@/lib/short-path";
import { instanceSupportsLocalComputer, localComputerDisabledReason, localComputerSelectable } from "@/lib/local-computer";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { ApprovalModeSelector } from "./ApprovalModeSelector";
import { FullAccessWarning } from "./FullAccessWarning";
import { VoiceSettings } from "./VoiceSettings";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode";
import { Switch } from "./SettingsPrimitives";
import { RoutineEditor } from "./RoutinesPage";
import { BotInstructionsDialog } from "./BotInstructionsDialog";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[13px] text-ink-secondary">{label}</div>
      {children}
    </label>
  );
}

/** What this bot has spent across its tasks. Cost is captioned by how the
 * engine is billed — on a subscription the figure is an equivalent. */
function BotUsageCard({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const usage = botUsage(bot);
  const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
  if (usage.turns === 0) return null;
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[15px] font-medium text-ink">Usage</div>
        <button
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
          className="text-[12px] text-ink-secondary hover:text-ink"
        >
          All bots →
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-[13px]">
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Turns</div>
          <div className="mt-0.5 tabular-nums text-ink">{usage.turns}</div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Tokens</div>
          <div className="mt-0.5 tabular-nums text-ink" title={`${formatTokens(usage.input)} in · ${formatTokens(usage.output)} out`}>
            {formatTokens(usage.input + usage.output)}
          </div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Cost</div>
          <div className="mt-0.5 tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : "—"}</div>
        </div>
      </div>
      <div className="mt-2 text-[12px] text-ink-secondary">
        {hasFiniteCost(usage.costUsd) ? `Cost ${costCaption(instance?.snapshot.billing)}.` : "This engine doesn't report a price; tokens are counted."}
      </div>
    </div>
  );
}

interface ManagedSkill {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  warnings: string[];
}

interface StagedSkillSummary {
  id: string;
  name: string;
  gist: string;
}

/** Skills are durable behavior, so the user needs a normal way to inspect,
 * disable, and remove them after the one-time approval card is gone. */
function LearnedSkillsCard({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const featureEnabled = skillRecorderEnabled(state.config);
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [staged, setStaged] = useState<StagedSkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState<{ skill: ManagedSkill; text: string } | null>(null);

  const refresh = async (cancelled?: () => boolean) => {
    try {
      const result = await api(`/api/bots/${bot.id}/skills`) as {
        skills?: ManagedSkill[];
        staged?: StagedSkillSummary[];
      };
      if (cancelled?.()) return;
      setSkills(result.skills ?? []);
      setStaged(result.staged ?? []);
      setError("");
    } catch (cause) {
      if (!cancelled?.()) setError(cause instanceof Error ? cause.message : "Could not load learned skills.");
    } finally {
      if (!cancelled?.()) setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReviewing(null);
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [bot.id]);

  const toggle = async (skill: ManagedSkill) => {
    setWorking(skill.name);
    setError("");
    try {
      if (!skill.enabled) {
        // A disabled import has not necessarily been reviewed. Fetch the
        // integrity-checked bytes and require one explicit review step before
        // they can reach the bot's prompt or native skill discovery.
        const result = await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`) as { text?: string };
        if (!result.text) throw new Error("The skill contents are unavailable; remove and import or learn it again.");
        setReviewing({ skill, text: result.text });
        return;
      }
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this skill.");
    } finally {
      setWorking("");
    }
  };

  const enableReviewed = async () => {
    if (!reviewing) return;
    const { skill } = reviewing;
    setWorking(skill.name);
    setError("");
    try {
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      });
      setReviewing(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not enable this skill.");
    } finally {
      setWorking("");
    }
  };

  const remove = async (skill: ManagedSkill) => {
    if (!window.confirm(`Remove the learned skill “${skill.name}”?`)) return;
    setWorking(skill.name);
    setError("");
    try {
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove this skill.");
    } finally {
      setWorking("");
    }
  };

  if (!featureEnabled && !loading && skills.length === 0 && staged.length === 0) return null;
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-center gap-2">
        <BookOpen size={16} className="text-ink-secondary" />
        <div className="text-[15px] font-medium text-ink">Learned skills</div>
      </div>
      <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
        {featureEnabled
          ? "Use /learn to create a skill, or /learn update <name> to revise one. Every change waits for your review."
          : "Skill authoring is off, but skills you already enabled stay under your control here."}
      </div>
      {loading ? (
        <div className="mt-3 text-[12px] text-ink-secondary">Loading…</div>
      ) : skills.length === 0 ? (
        <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">No installed skills yet.</div>
      ) : (
        <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
          {skills.map((skill) => (
            <div key={skill.name} className="px-3 py-2.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12.5px] text-ink">{skill.name}</div>
                  <div className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-secondary">{skill.description}</div>
                </div>
                <Switch
                  checked={skill.enabled}
                  aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                  disabled={working === skill.name}
                  onClick={() => void toggle(skill)}
                />
                <button
                  aria-label={`Remove ${skill.name}`}
                  title="Remove skill"
                  disabled={working === skill.name}
                  onClick={() => void remove(skill)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="mt-1 truncate text-[10.5px] text-ink-secondary" title={skill.source}>Source: {skill.source}</div>
              {skill.warnings.length > 0 && (
                <div className="mt-1 text-[10.5px] text-warning">{skill.warnings.join(" · ")}</div>
              )}
            </div>
          ))}
        </div>
      )}
      {staged.length > 0 && (
        <div className="mt-2 text-[11.5px] text-warning">
          {staged.length} proposal{staged.length === 1 ? " is" : "s are"} waiting for a decision in chat.
        </div>
      )}
      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
      {reviewing && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="skill-review-title"
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-6"
        >
          <div className="flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col rounded-2xl bg-card p-5 shadow-2xl">
            <div id="skill-review-title" className="text-[16px] font-semibold text-ink">
              Review {reviewing.skill.name} before enabling
            </div>
            <div className="mt-1 break-all text-[11.5px] text-ink-secondary">
              Source: {reviewing.skill.source}
            </div>
            {reviewing.skill.warnings.length > 0 && (
              <div className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] text-warning">
                {reviewing.skill.warnings.join(" · ")}
              </div>
            )}
            <pre
              tabIndex={0}
              aria-label={`Full SKILL.md for ${reviewing.skill.name}`}
              className="mt-3 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink"
            >
              {reviewing.text}
            </pre>
            {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={working === reviewing.skill.name}
                onClick={() => setReviewing(null)}
                className="rounded-lg px-4 py-2 text-[13px] font-medium text-ink-secondary hover:bg-raised disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={working === reviewing.skill.name}
                onClick={() => void enableReviewed()}
                className="rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                Enable reviewed skill
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

/** Where a bot's shell tools run. Set per bot; each task pins its own copy
 * on its first turn (the server does the pinning — Claude keeps sessions
 * per project folder, so a folder must not move under a live task). The
 * PATCH is made directly rather than through updateBot: the server
 * validates the path and a rejected folder must not stick in local state. */
function WorkingFolder({ bot }: { bot: Bot }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const pinned = task?.cwd; // undefined = not yet, null = legacy home, string = folder
  const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== bot.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.ogb?.pickFolder?.(bot.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Working folder</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">Where this bot runs its shell and file tools.</div>
      {canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">Private bot workspace</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> Choose…
          </button>
          {bot.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              Clear
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // an emptied field clears the folder — the server wants null
            void save((draft ?? bot.cwd ?? "").trim() || null);
          }}
        >
          <input
            className={cn(inputCls, "font-mono text-[12.5px]")}
            placeholder="Private bot workspace — or an absolute path"
            value={draft ?? bot.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            Save
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          New tasks start here. This task is pinned to {pinned ? <span className="font-mono">{shortPath(pinned, home)}</span> : "the home folder"} — start a new task to use the new folder.
        </div>
      )}
    </div>
  );
}

interface MemoryTopic {
  name: string;
  bytes: number;
}

const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`);

/** MEMORY.md + memory/ topic files, surfaced so the user can read and fix
 * what the bot believes. Fetched on expand, not on mount: settings opens for
 * every bot and most visits never look at memory — and an expand also
 * re-reads, so notes the bot wrote mid-session show up on the next open. */
function MemoryCard({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [topics, setTopics] = useState<MemoryTopic[]>([]);
  const [saving, setSaving] = useState(false);
  const [topic, setTopic] = useState<{ name: string; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setTopic(null);
    try {
      const result: { text: string; truncated: boolean; topics: MemoryTopic[] } = await api(
        `/api/bots/${bot.id}/memory`,
      );
      setText(result.text);
      setTruncated(result.truncated);
      setTopics(result.topics);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result: { truncated: boolean } = await api(`/api/bots/${bot.id}/memory`, {
        method: "PUT",
        body: JSON.stringify({ text }),
      });
      setTruncated(result.truncated);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const openTopic = async (name: string) => {
    setError(null);
    try {
      setTopic(await api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(name)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <button
        className="flex w-full items-center justify-between gap-4 text-left"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
      >
        <div>
          <div className="text-[15px] font-medium text-ink">Memory</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Notes this bot keeps between tasks — plain files you can edit.
          </div>
        </div>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>

      {open && loading && <div className="mt-3 text-[13px] text-ink-secondary">Loading…</div>}

      {open && !loading && topic && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[12.5px] text-ink">memory/{topic.name}</span>
            <button
              onClick={() => setTopic(null)}
              className="shrink-0 rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
            >
              Back
            </button>
          </div>
          <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12.5px] leading-relaxed text-ink">
            {topic.text}
          </pre>
        </div>
      )}

      {open && !loading && !topic && (
        <div className="mt-3">
          <textarea
            className={cn(inputCls, "min-h-[160px] resize-y font-mono text-[12.5px] leading-relaxed")}
            value={text}
            placeholder="Nothing remembered yet. The bot writes durable notes here — or add your own."
            aria-label="Bot memory"
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={() => void save()}
              disabled={saving || !dirty}
              className="rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {truncated && (
              <span className="text-[11.5px] text-ink-secondary">
                Over the budget — only the top of this file loads each turn.
              </span>
            )}
          </div>
          {topics.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                Topic files
              </div>
              <div className="overflow-hidden rounded-lg border border-hairline/40">
                {topics.map((entry) => (
                  <button
                    key={entry.name}
                    onClick={() => void openTopic(entry.name)}
                    className="flex w-full items-center justify-between gap-2 border-b border-hairline/40 px-3 py-2 text-left last:border-b-0 hover:bg-control/60"
                  >
                    <span className="truncate font-mono text-[12.5px] text-ink">{entry.name}</span>
                    <span className="shrink-0 text-[11.5px] text-ink-secondary">{formatBytes(entry.bytes)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

export function SettingsPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
  const [localAutoWarning, setLocalAutoWarning] = useState<{
    botId: string;
    kind: "auto" | "local";
  } | null>(null);
  const [fullAccessTarget, setFullAccessTarget] = useState<string | null>(null);
  const [creatingRoutine, setCreatingRoutine] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  useEffect(() => {
    setCreatingRoutine(false);
    setInstructionsOpen(false);
  }, [bot.id]);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const patch = (
    p: Partial<
      Pick<
        Bot,
        | "name"
        | "title"
        | "description"
        | "notifications"
        | "cloudBackend"
        | "autoStartVps"
        | "color"
        | "mascotExpression"
        | "mascotBody"
        | "avatarUrl"
        | "avatarCrop"
        | "autoApprove"
        | "approvalMode"
        | "autoReview"
        | "depth"
        | "speakReplies"
        | "voice"
        | "chiefOfStaff"
        | "approvePeerComms"
        | "composio"
        | "browser"
        | "modelSelection"
      >
    > & {
      computer?: Bot["computer"] | null;
      acknowledgeLocalAuto?: boolean;
      confirmFullAccess?: boolean;
    },
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  const activeState = stateForBot(bot);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const approvalMode = approvalModeFor(bot);
  const setApprovalMode = (mode: ApprovalMode) => {
    if (bot.busy || mode === approvalMode) return;
    if (mode === "full") {
      setFullAccessTarget(bot.id);
      return;
    }
    if (mode === "auto" && bot.computer === "local") {
      setLocalAutoWarning({ botId: bot.id, kind: "auto" });
      return;
    }
    patch({ approvalMode: mode });
  };
  const canAutoReview = engine?.capabilities?.approvalReview === true;
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const canUseConnectedApps = engine?.capabilities?.composioMcp === true;
  const canUseVps = engine?.capabilities?.computerMcp === true && engine.driverKind !== "boxAgent";
  const connectedAppsConfigured = state.config?.composio?.configured === true;
  const connectedAppsEnabled = bot.composio !== false;
  const canUseBrowser = engine?.capabilities?.browserMcp === true;
  const desktopBrowser = Boolean(window.ogb?.browser);
  const browserBlockedOnWindows = window.ogb?.platform === "win32" && !desktopBrowser;
  const browserFeature = builtInBrowserEnabled(state.config);
  const browserAllowed = bot.browser !== false;
  const browserEnabled = browserFeature && browserAllowed;
  // "Works on: Browser" needs everything the switch needs except the switch
  // itself; the box-native Computer engine has no browser-only mode.
  const browserSelectable = desktopBrowser && browserFeature && canUseBrowser && engine?.driverKind !== "boxAgent";
  const browserDisabledReason = !desktopBrowser
    ? "The built-in browser needs the OpenMausBot desktop app"
    : !browserFeature
      ? "The built-in browser is switched off under App Settings → Experimental"
      : "This model engine cannot use the built-in browser";
  const sectionName = bot.section?.trim() || "General";
  const currentChief = state.bots.find(
    (candidate) =>
      candidate.chiefOfStaff &&
      (candidate.section?.trim() || "") === (bot.section?.trim() || ""),
  );
  const botRoutines = state.routines.filter((routine) => routine.botId === bot.id);
  const activeBotRoutines = botRoutines.filter((routine) => routine.enabled).length;

  return (
    <>
    <aside className="animate-panel-in relative z-20 flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label="Collapse agent profile"
          title="Collapse agent profile"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">Agent profile</span>
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label="Close agent profile"
          title="Close agent profile"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex flex-col gap-4 pt-4">
          <BotProfileAvatarCard
            bot={bot}
            activeState={activeState}
            mascotMotion={mascotMotion}
            onPatch={patch}
          />

          <Field label="Name">
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.name}
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label="Title">
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.title}
              placeholder="Describe what your agent does"
              value={bot.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          <div className="block">
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <label htmlFor={`bot-instructions-${bot.id}`} className="text-[13px] text-ink-secondary">Instructions</label>
              <button
                type="button"
                onClick={() => setInstructionsOpen(true)}
                className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-accent-text hover:bg-accent/10"
              >
                <BookOpen size={12} /> View full
              </button>
            </div>
            <textarea
              id={`bot-instructions-${bot.id}`}
              className={cn(inputCls, "min-h-[176px] resize-y leading-relaxed")}
              maxLength={BOT_PROFILE_LIMITS.description}
              placeholder="Describe this bot’s role, priorities, working style, and boundaries"
              aria-label="Bot instructions"
              value={bot.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
            <div className="mt-1.5 flex items-start justify-between gap-3 text-[11px] text-ink-secondary">
              <span>Included in this bot’s context on every turn.</span>
              <span className="shrink-0 tabular-nums">
                {bot.description.length.toLocaleString()} / {BOT_PROFILE_LIMITS.description.toLocaleString()}
              </span>
            </div>
          </div>

          <div className="rounded-xl bg-card p-4">
            <div className="flex items-center gap-2">
              <CalendarClock size={16} className="text-accent" />
              <div className="min-w-0 flex-1 text-[15px] font-medium text-ink">Scheduled tasks</div>
              <span className="shrink-0 text-[11.5px] tabular-nums text-ink-secondary">
                {activeBotRoutines} active · {botRoutines.length} total
              </span>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setCreatingRoutine(true)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110"
              >
                <Plus size={14} />
                New schedule
              </button>
              <button
                type="button"
                onClick={() => dispatch({ type: "showRoutines" })}
                className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
              >
                Manage
              </button>
            </div>
          </div>

          <div className={cn(
            "rounded-xl border p-4",
            bot.chiefOfStaff ? "border-accent/40 bg-accent/10" : "border-hairline/40 bg-card",
          )}>
            <div className="flex items-center gap-3">
              <span className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                bot.chiefOfStaff ? "bg-accent text-white" : "bg-control text-ink-secondary",
              )}>
                <Crown size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-medium text-ink">Chief of Staff</div>
                <div className="text-[11.5px] text-ink-secondary">One for {sectionName}</div>
              </div>
              <Switch
                checked={Boolean(bot.chiefOfStaff)}
                aria-label="Chief of Staff"
                disabled={!bot.chiefOfStaff && !canCoordinate}
                onClick={() => patch({ chiefOfStaff: !bot.chiefOfStaff })}
                title={!bot.chiefOfStaff && !canCoordinate ? "This engine cannot contact other bots" : undefined}
                className="disabled:cursor-not-allowed"
              />
            </div>
            <div className="mt-3 text-[13px] leading-relaxed text-ink-secondary">
              {bot.chiefOfStaff && !canCoordinate
                ? "This bot still holds the role, but its current engine cannot contact teammates. Choose a Claude or ACP engine to restore coordination."
                : bot.chiefOfStaff
                  ? `This is the primary contact for ${sectionName}. It can create and coordinate specialists in this section, then combine their work into one answer.`
                : !canCoordinate
                  ? "Choose a Claude or ACP engine to let this bot coordinate teammates."
                  : currentChief
                    ? `Make this bot the ${sectionName} Chief and hand the role over from ${currentChief.name}.`
                    : `Make this bot the primary contact for the ${sectionName} section.`}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                Ask me before contacting other bots
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {bot.approvePeerComms
                  ? "This bot will stop and ask before it reaches out to another bot."
                  : "Let this bot talk to teammates on its own, without a confirmation step."}
              </div>
            </div>
            <Switch
              checked={Boolean(bot.approvePeerComms)}
              aria-label="Ask me before contacting other bots"
              disabled={!bot.approvePeerComms && !canCoordinate}
              onClick={() => patch({ approvePeerComms: !bot.approvePeerComms })}
              title={!bot.approvePeerComms && !canCoordinate ? "This engine cannot contact other bots" : undefined}
              className="disabled:cursor-not-allowed"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Connected apps</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {!connectedAppsConfigured
                  ? "Connect apps in App Settings before giving this bot access."
                  : !canUseConnectedApps
                    ? "This bot's current engine cannot use connected apps."
                    : connectedAppsEnabled
                      ? "Let this bot use your connected Gmail, Calendar, Slack, and other apps."
                      : "Keep your connected apps unavailable to this bot."}
              </div>
            </div>
            <Switch
              checked={connectedAppsEnabled}
              aria-label="Allow this bot to use connected apps"
              disabled={
                !connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)
              }
              onClick={() => patch({ composio: !connectedAppsEnabled })}
              title={
                !connectedAppsEnabled && !connectedAppsConfigured
                  ? "Connect apps in App Settings first"
                  : !connectedAppsEnabled && !canUseConnectedApps
                    ? "This engine cannot use connected apps"
                    : undefined
              }
              className="disabled:cursor-not-allowed"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Browser</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {!desktopBrowser
                  ? browserBlockedOnWindows
                    ? "The built-in browser is temporarily unavailable on Windows while Electron's production sandbox support is being verified."
                    : "The built-in browser needs the OpenMausBot desktop app."
                  : !browserFeature
                    ? "The built-in browser is switched off under App Settings → Experimental."
                    : !canUseBrowser
                      ? "This bot's current engine cannot use the built-in browser."
                      : browserEnabled
                        ? "This bot has its own browser tab in the computer panel — its own logins, watchable and takeable at any time."
                        : "Keep the built-in browser unavailable to this bot."}
              </div>
            </div>
            <Switch
              checked={browserEnabled}
              aria-label="Give this bot a built-in browser"
              disabled={!browserEnabled && (!desktopBrowser || !browserFeature || !canUseBrowser)}
              onClick={() => patch({ browser: !browserAllowed })}
              className="disabled:cursor-not-allowed"
            />
          </div>

          <div className="rounded-xl bg-card p-4">
            <ModelPicker
              bot={bot}
              contained
              label={
                <div>
                  <div className="text-[15px] font-medium text-ink">Model</div>
                  <div className="mt-0.5 text-[13px] text-ink-secondary">
                    Which provider and model this bot runs on
                  </div>
                </div>
              }
            />
          </div>

          {!!engine?.capabilities?.effortLevels?.length && (
            <div className="rounded-xl bg-card p-4">
              <div className="text-[15px] font-medium text-ink">Effort</div>
              {/* Says what the app does, not what the engine ends up at:
                  Codex applies a level to the whole thread and has no way to
                  take one back, so "currently: engine default" was a promise
                  we could not keep for a thread that had already been sent
                  one. Sending nothing is true on every engine. */}
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                How hard this bot thinks{bot.modelSelection.effort ? "" : " (Default: no level is sent)"}
              </div>
              <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
                {([undefined, ...engine.capabilities.effortLevels] as const).map((level, i) => (
                  <button
                    key={level ?? "default"}
                    aria-pressed={bot.modelSelection.effort === level}
                    onClick={() => patch({ modelSelection: { ...bot.modelSelection, effort: level } })}
                    className={cn(
                      "flex-1 py-1.5 text-[13px] capitalize",
                      i > 0 && "border-l border-hairline/40",
                      bot.modelSelection.effort === level
                        ? "bg-control text-ink"
                        : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                    )}
                  >
                    {/* the others capitalize cleanly; "xhigh" would read "Xhigh" */}
                    {level === "xhigh" ? "X-High" : (level ?? "Default")}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Answer depth</div>
            {/* Same shape as Effort above, and for the same reason: the
                default sends nothing at all, so a bot that predates this
                setting reads exactly as it always did. */}
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              How much work a reply shows{bot.depth && bot.depth !== "standard" ? "" : " (Standard: nothing is added)"}
            </div>
            <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
              {(["quick", "standard", "deep"] as const).map((level, i) => (
                <button
                  key={level}
                  aria-pressed={(bot.depth ?? "standard") === level}
                  onClick={() => patch({ depth: level })}
                  className={cn(
                    "flex-1 py-1.5 text-[13px] capitalize",
                    i > 0 && "border-l border-hairline/40",
                    (bot.depth ?? "standard") === level
                      ? "bg-control text-ink"
                      : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                  )}
                >
                  {level === "deep" ? "Deep report" : level}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Works on</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              Where this bot works{bot.computer ? "" : " (currently: auto)"}. Browser is the built-in browser tab only; no desktop.
            </div>
            <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
              {([
                [null, "Auto"],
                ["cloud", "Cloud"],
                ["vm", "Local VM"],
                ["local", "This computer"],
                ["browser", "Browser"],
                ["off", "Off"],
              ] as const).map(([mode, label], i) => (
                <button
                  key={mode ?? "auto"}
                  disabled={(mode === "local" && !localSelectable) || (mode === "browser" && !browserSelectable)}
                  title={
                    mode === "local" && !localSelectable
                      ? localDisabledReason ?? undefined
                      : mode === "browser"
                        ? browserSelectable ? "The built-in browser tab only; no desktop" : browserDisabledReason
                        : undefined
                  }
                  onClick={() => {
                    if ((mode === null && bot.computer === undefined) || mode === bot.computer) return;
                    if (mode === "local" && approvalMode === "auto") {
                      setLocalAutoWarning({ botId: bot.id, kind: "local" });
                    }
                    // a browser-only bot must actually have its browser: flip
                    // the per-bot switch on with the destination
                    else if (mode === "browser") patch({ computer: mode, browser: true });
                    else patch({ computer: mode });
                  }}
                  className={cn(
                    "flex-1 py-1.5 text-[13px] capitalize",
                    i > 0 && "border-l border-hairline/40",
                    ((mode === "local" && !localSelectable) || (mode === "browser" && !browserSelectable)) && "cursor-not-allowed opacity-40",
                    (mode === null ? bot.computer === undefined : bot.computer === mode)
                      ? "bg-control text-ink"
                      : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {(!bot.computer || bot.computer === "cloud") && (
              <>
                {!bot.computer && (
                  <div className="mt-3 rounded-lg bg-inset px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-secondary">
                    <span className="font-medium text-ink">Auto cloud preference.</span>{" "}
                    This chooses what Auto may reuse during a task; viewing settings does not create or wake a computer.
                  </div>
                )}
                <CloudBackendPicker
                  value={bot.cloudBackend ?? "box"}
                  vpsSupported={canUseVps}
                  onChange={(backend) => patch({ cloudBackend: backend })}
                />
                {!bot.computer && bot.cloudBackend === "vps" && (
                  <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink">Start VPS automatically</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                        Allow Auto to create or wake this bot's managed container when needed.
                      </div>
                    </div>
                    <Switch
                      checked={Boolean(bot.autoStartVps)}
                      aria-label="Start VPS automatically"
                      onClick={() => patch({ autoStartVps: !bot.autoStartVps })}
                    />
                  </div>
                )}
              </>
            )}
          </div>

          <BotUsageCard bot={bot} />
          <WorkingFolder bot={bot} />

          {/* keyed so switching bots never shows one bot's notes under another's name */}
          <MemoryCard key={bot.id} bot={bot} />

          <LearnedSkillsCard key={`skills-${bot.id}`} bot={bot} />

          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Approval level</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              Choose how much this bot can do before it stops to ask you.
            </div>
            <div className="mt-3">
              <ApprovalModeSelector
                approvalMode={bot.approvalMode}
                autoApprove={bot.autoApprove}
                providerName={engine?.displayName ?? bot.name}
                driverKind={engine?.driverKind ?? ""}
                onSelect={setApprovalMode}
                menuDirection="down"
                wide
                disabled={Boolean(bot.busy)}
                trustedModesAvailable={Boolean(window.ogb?.approvals && capabilities.host.packaged)}
              />
            </div>
          </div>

          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Review routine approvals</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {approvalMode === "custom"
                ? "Custom follows your Codex config.toml and its approval prompts. Routine auto-review stays off in this mode."
                : canAutoReview
                ? "The same engine reviews ordinary approval cards. Existing safety rules, unattended turns, local-computer access, and questions still wait for you."
                : "This engine cannot run an isolated review safely, so approval cards continue to wait for you."}
            </div>
            <div className="mt-3 flex gap-1 rounded-lg bg-inset p-0.5">
              {(
                [
                  ["off", "Off", "Every undecided approval waits for you."],
                  ["shadow", "Watch", "Record the review without answering the card."],
                  ["enforce", "On", "Answer only reviews that return a strict approval."],
                ] as const
              ).map(([value, label, hint]) => {
                const current = approvalMode === "custom"
                  ? "off"
                  : bot.autoReview === "shadow" || bot.autoReview === "enforce"
                    ? bot.autoReview
                    : "off";
                const disabled = value !== "off" && (approvalMode === "custom" || !canAutoReview);
                return (
                  <button
                    key={value}
                    title={disabled
                      ? approvalMode === "custom"
                        ? "Custom approval behavior is controlled by config.toml"
                        : "Not supported by this engine"
                      : hint}
                    disabled={disabled}
                    onClick={() => patch({ autoReview: value })}
                    className={cn(
                      "flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40",
                      current === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <VoiceSettings bot={bot} onPatch={patch} />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                Notifications
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Get notified when this agent finishes or needs input
              </div>
            </div>
            <Switch
              checked={bot.notifications}
              aria-label="Agent notifications"
              onClick={() => {
                const enabled = !bot.notifications;
                if (enabled) void requestNotificationPermission();
                patch({ notifications: enabled });
              }}
            />
          </div>
        </div>
      </div>
    </aside>
    {creatingRoutine && (
      <RoutineEditor
        key={bot.id}
        bots={[bot]}
        lockedBotId={bot.id}
        onClose={() => setCreatingRoutine(false)}
      />
    )}
    {instructionsOpen && <BotInstructionsDialog bot={bot} onClose={() => setInstructionsOpen(false)} />}
    <LocalComputerAutoWarning
      open={localAutoWarning !== null}
      onCancel={() => setLocalAutoWarning(null)}
      onConfirm={() => {
        const target = localAutoWarning;
        setLocalAutoWarning(null);
        if (!target) return;
        dispatch({
          type: "updateBot",
          botId: target.botId,
          patch: target.kind === "auto"
            ? { approvalMode: "auto", acknowledgeLocalAuto: true }
            : { computer: "local", acknowledgeLocalAuto: true },
        });
      }}
    />
    <FullAccessWarning
      open={fullAccessTarget !== null}
      onCancel={() => setFullAccessTarget(null)}
      onConfirm={() => {
        if (fullAccessTarget) {
          dispatch({
            type: "updateBot",
            botId: fullAccessTarget,
            patch: { approvalMode: "full", confirmFullAccess: true },
          });
        }
        setFullAccessTarget(null);
      }}
    />
    </>
  );
}
