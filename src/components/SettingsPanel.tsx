import { ChevronDown, ChevronLeft, Crown, FolderOpen, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import type { EffortLevel } from "../../server/contracts";
import type { JsonValue } from "../../server/schema";
import { parseAgentProfileSummary, relativeProfileFreshness, type AgentProfileSummary } from "@/lib/agent-profile-summary";
import { cn } from "@/lib/cn";
import { instanceSupportsLocalComputer, localComputerDisabledReason, localComputerSelectable } from "@/lib/local-computer";
import { stateForBot } from "@/lib/mascot";
import { requestNotificationPermission } from "@/lib/notify";
import { shortPath } from "@/lib/short-path";
import { api, useStore, type Bot } from "@/state/store";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { ModelPicker } from "./ModelPicker";
import { preloadConnectedApps } from "./PluginsPanel";
import { VoiceSettings } from "./VoiceSettings";

const inputClass = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
const COMPUTER_DESTINATIONS = [
  { mode: "cloud", label: "Cloud" },
  { mode: "vm", label: "Local VM" },
  { mode: "local", label: "This PC" },
  { mode: "off", label: "Off" },
] satisfies ReadonlyArray<{ mode: NonNullable<Bot["computer"]>; label: string }>;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[12px] font-medium text-ink-secondary">{label}</div>
      {children}
    </label>
  );
}

function Toggle({
  checked,
  label,
  disabled = false,
  title,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  title?: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      title={title}
      onClick={onChange}
      className={cn(
        "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "bg-accent" : "bg-control",
      )}
    >
      <span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-all", checked ? "left-[21px]" : "left-[3px]")} />
    </button>
  );
}

function ProfileRow({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-ink">{title}</div>
        {detail ? <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{detail}</div> : null}
      </div>
      {children}
    </div>
  );
}

function MemorySummary({ bot, onViewMemory }: { bot: Bot; onViewMemory: () => void }) {
  const [summary, setSummary] = useState<AgentProfileSummary | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setUnavailable(false);
    api(`/api/bots/${bot.id}/profile-summary`, { signal: controller.signal })
      .then((value: JsonValue) => {
        const parsed = parseAgentProfileSummary(value);
        setSummary(parsed);
        setUnavailable(parsed === null);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setUnavailable(true);
      });
    return () => controller.abort();
  }, [bot.id]);

  const items: Array<{ label: string; value: number | undefined }> = [
    { label: "Identity & preferences", value: summary?.identityAndPreferences },
    { label: "Standing rules", value: summary?.standingRules },
    { label: "Open work", value: summary?.openWork },
  ];

  return (
    <div className="rounded-2xl border border-hairline/40 bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium text-ink">What {bot.name} knows</div>
          <div className="mt-0.5 text-[12px] text-ink-secondary">
            {summary ? relativeProfileFreshness(summary.lastUpdatedAt) : unavailable ? "Summary unavailable" : "Loading…"}
          </div>
        </div>
        <button type="button" onClick={onViewMemory} className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink">
          View memory
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        {items.map((item) => (
          <div key={item.label} className="rounded-xl bg-inset px-2 py-2.5">
            <div className="text-[17px] font-semibold tabular-nums text-ink">{item.value ?? "—"}</div>
            <div className="mt-0.5 text-[10.5px] leading-tight text-ink-secondary">{item.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkingFolder({ bot }: { bot: Bot }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  const pinned = task?.cwd;
  const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== bot.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const chooseFolder = async () => {
    const chosen = await window.ogb?.pickFolder?.(bot.cwd);
    if (chosen) await save(chosen);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[14px] font-medium text-ink">Working folder</div>
      {canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">Private agent workspace</span>}
          </div>
          <button
            type="button"
            onClick={() => void chooseFolder()}
            disabled={saving}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            <FolderOpen size={14} /> Choose
          </button>
        </div>
      ) : (
        <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); void save((draft ?? bot.cwd ?? "").trim() || null); }}>
          <input className={cn(inputClass, "font-mono text-[12px]")} value={draft ?? bot.cwd ?? ""} onChange={(event) => setDraft(event.target.value)} placeholder="Private workspace or absolute path" />
          <button type="submit" disabled={saving || draft === null} className="rounded-lg bg-control px-3 text-[12.5px] text-ink disabled:opacity-40">Apply</button>
        </form>
      )}
      {bot.cwd ? <button type="button" onClick={() => void save(null)} disabled={saving} className="mt-2 text-[11.5px] text-ink-secondary hover:text-ink">Use private workspace instead</button> : null}
      {pinnedElsewhere ? <div className="mt-2 text-[11.5px] text-ink-secondary">New tasks use this folder. The current task remains pinned to {pinned ? shortPath(pinned, home) : "the home folder"}.</div> : null}
      {error ? <div className="mt-2 text-[12px] text-danger">{error}</div> : null}
    </div>
  );
}

interface MemoryTopic { name: string; bytes: number }
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`;

function MemoryEditor({ bot, revealToken }: { bot: Bot; revealToken: number }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [topics, setTopics] = useState<MemoryTopic[]>([]);
  const [topic, setTopic] = useState<{ name: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editVersion = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setTopic(null);
    try {
      const result: { text: string; truncated: boolean; topics: MemoryTopic[] } = await api(`/api/bots/${bot.id}/memory`);
      setText(result.text);
      setTruncated(result.truncated);
      setTopics(result.topics);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [bot.id]);

  useEffect(() => {
    if (revealToken < 1) return;
    setOpen(true);
    void load();
  }, [load, revealToken]);

  useEffect(() => {
    if (!dirty) return;
    const version = editVersion.current;
    const timer = window.setTimeout(() => {
      setSaving(true);
      setError(null);
      void api(`/api/bots/${bot.id}/memory`, { method: "PUT", body: JSON.stringify({ text }) })
        .then((result: { truncated: boolean }) => {
          setTruncated(result.truncated);
          if (editVersion.current === version) setDirty(false);
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setSaving(false));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [bot.id, dirty, text]);

  const openTopic = async (name: string) => {
    setError(null);
    try {
      setTopic(await api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(name)}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <button type="button" className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={open} onClick={() => { const next = !open; setOpen(next); if (next) void load(); }}>
        <div>
          <div className="text-[14px] font-medium text-ink">Raw memory</div>
          <div className="mt-0.5 text-[11.5px] text-ink-secondary">Advanced repair view for durable notes and topic files.</div>
        </div>
        <ChevronDown size={15} className={cn("text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>
      {open && loading ? <div className="mt-3 text-[12px] text-ink-secondary">Loading…</div> : null}
      {open && !loading && topic ? (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[12px] text-ink">memory/{topic.name}</span>
            <button type="button" onClick={() => setTopic(null)} className="text-[12px] text-ink-secondary hover:text-ink">Back</button>
          </div>
          <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink">{topic.text}</pre>
        </div>
      ) : null}
      {open && !loading && !topic ? (
        <div className="mt-3">
          <textarea
            className={cn(inputClass, "min-h-[150px] resize-y font-mono text-[12px] leading-relaxed")}
            value={text}
            aria-label="Agent raw memory"
            onChange={(event) => { editVersion.current += 1; setText(event.target.value); setDirty(true); }}
          />
          <div className="mt-1.5 text-[11px] text-ink-secondary">{saving ? "Saving…" : dirty ? "Changes save automatically" : "Saved"}{truncated ? " · Over the per-turn memory budget" : ""}</div>
          {topics.length > 0 ? (
            <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
              {topics.map((entry) => (
                <button key={entry.name} type="button" onClick={() => void openTopic(entry.name)} className="flex w-full items-center justify-between border-b border-hairline/40 px-3 py-2 text-left last:border-b-0 hover:bg-control/60">
                  <span className="truncate font-mono text-[12px] text-ink">{entry.name}</span>
                  <span className="text-[11px] text-ink-secondary">{formatBytes(entry.bytes)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div> : null}
    </div>
  );
}

export function SettingsPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [memoryRevealToken, setMemoryRevealToken] = useState(0);
  const [connectedAppCount, setConnectedAppCount] = useState<number | null>(null);
  const [localAutoWarning, setLocalAutoWarning] = useState<"auto" | "local" | null>(null);

  const patch = (value: Partial<Pick<Bot,
    "name" | "title" | "description" | "instructions" | "notifications" | "reportingMode" | "computer" | "cloudBackend" |
    "autoStartVps" | "color" | "mascotExpression" | "avatarUrl" | "avatarCrop" | "autoApprove" | "speakReplies" | "voice" |
    "chiefOfStaff" | "approvePeerComms" | "composio" | "modelSelection"
  >> & { acknowledgeLocalAuto?: boolean }) => dispatch({ type: "updateBot", botId: bot.id, patch: value });

  useEffect(() => {
    let alive = true;
    void preloadConnectedApps().then((inventory) => {
      if (!alive) return;
      const count = Object.values(inventory.services).filter((service) => service.connected || Boolean(service.accounts?.length)).length;
      setConnectedAppCount(count);
    });
    return () => { alive = false; };
  }, []);

  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const canUseConnectedApps = engine?.capabilities?.composioMcp === true;
  const canUseVps = engine?.capabilities?.computerMcp === true && engine.driverKind !== "boxAgent";
  const connectedAppsConfigured = state.config?.composio?.configured === true;
  const connectedAppsEnabled = bot.composio !== false;
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const currentCoordinator = state.bots.find((candidate) => candidate.chiefOfStaff && (candidate.section?.trim() || "") === (bot.section?.trim() || ""));
  const sectionName = bot.section?.trim() || "General";
  const computerLabel = bot.computer === "local" ? "This computer" : bot.computer === "off" ? "Computer off" : bot.computer === "vm" ? "Local VM" : bot.computer === "cloud" ? "Cloud computer" : "Auto computer";
  const appsLabel = !connectedAppsEnabled ? "Apps off" : connectedAppCount === null ? "Checking apps" : `${connectedAppCount} ${connectedAppCount === 1 ? "app" : "apps"}`;
  const activeState = stateForBot(bot);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const effortLevels: ReadonlyArray<EffortLevel | undefined> = [undefined, ...(engine?.capabilities?.effortLevels ?? [])];

  const viewMemory = () => {
    setAdvancedOpen(true);
    setMemoryRevealToken((value) => value + 1);
  };

  return (
    <>
      <aside className="animate-panel-in relative z-20 flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
        <div className="flex items-center justify-between px-4 py-3">
          <button type="button" onClick={() => dispatch({ type: "toggleSettings", open: false })} aria-label="Collapse agent profile" className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"><ChevronLeft size={18} /></button>
          <div className="text-center">
            <div className="text-[14px] font-semibold text-ink">Agent profile</div>
            <div className="text-[10.5px] text-ink-secondary">Saved as you go</div>
          </div>
          <button type="button" onClick={() => dispatch({ type: "toggleSettings", open: false })} aria-label="Close agent profile" className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-5">
          <div className="flex flex-col gap-4 pt-4">
            <BotProfileAvatarCard bot={bot} activeState={activeState} mascotMotion={mascotMotion} onPatch={patch} />

            <div className="grid grid-cols-2 gap-3">
              <Field label="Name"><input className={inputClass} maxLength={BOT_PROFILE_LIMITS.name} value={bot.name} onChange={(event) => patch({ name: event.target.value })} /></Field>
              <Field label="Title"><input className={inputClass} maxLength={BOT_PROFILE_LIMITS.title} value={bot.title} placeholder="What this agent does" onChange={(event) => patch({ title: event.target.value })} /></Field>
            </div>

            <Field label="Personality">
              <textarea className={cn(inputClass, "min-h-[88px] resize-none")} maxLength={BOT_PROFILE_LIMITS.description} value={bot.description} placeholder="Sharp, warm, loyal, dryly funny." onChange={(event) => patch({ description: event.target.value })} />
            </Field>

            <div className="rounded-xl bg-card p-4">
              <ModelPicker bot={bot} contained label={<div className="text-[14px] font-medium text-ink">Model</div>} />
            </div>

            <button type="button" onClick={() => setAdvancedOpen(true)} className="rounded-xl bg-card p-4 text-left hover:bg-control/60">
              <div className="text-[14px] font-medium text-ink">Access</div>
              <div className="mt-1 text-[12.5px] text-ink-secondary">{appsLabel} · {computerLabel} · {canCoordinate ? "Can delegate" : "Works solo"}</div>
            </button>

            <ProfileRow title="Auto mode" detail={bot.autoApprove ? "Keeps going; risky actions still stop for you." : "Asks before tool actions."}>
              <Toggle checked={Boolean(bot.autoApprove)} label="Auto mode" onChange={() => { if (!bot.autoApprove && bot.computer === "local") setLocalAutoWarning("auto"); else patch({ autoApprove: !bot.autoApprove }); }} />
            </ProfileRow>

            <ProfileRow title="Important notifications" detail="Finishes, failures, and approvals.">
              <Toggle checked={bot.notifications} label="Important notifications" onChange={() => { const enabled = !bot.notifications; if (enabled) void requestNotificationPermission(); patch({ notifications: enabled }); }} />
            </ProfileRow>

            <MemorySummary bot={bot} onViewMemory={viewMemory} />

            <details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} className="rounded-2xl border border-hairline/40 bg-card">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3.5 text-[14px] font-medium text-ink">
                Advanced
                <ChevronDown size={16} className={cn("text-ink-secondary transition-transform", advancedOpen && "rotate-180")} />
              </summary>
              <div className="flex flex-col gap-4 border-t border-hairline/40 p-4">
                <Field label="Detailed instructions">
                  <textarea className={cn(inputClass, "min-h-[140px] resize-y text-[13px] leading-relaxed")} maxLength={BOT_PROFILE_LIMITS.instructions} value={bot.instructions ?? ""} placeholder="Operating rules, quality bar, workflows, and boundaries." onChange={(event) => patch({ instructions: event.target.value })} />
                </Field>

                <Field label="Unsolicited updates">
                  <select className={inputClass} value={bot.reportingMode ?? "all"} onChange={(event) => { const value = event.target.value; if (value === "all" || value === "actionable" || value === "silent") patch({ reportingMode: value }); }}>
                    <option value="actionable">Important only</option>
                    <option value="all">All progress and results</option>
                    <option value="silent">Only when I ask</option>
                  </select>
                </Field>

                {engine?.capabilities?.effortLevels?.length ? (
                  <div>
                    <div className="mb-2 text-[12px] font-medium text-ink-secondary">Effort</div>
                    <div className="flex overflow-hidden rounded-lg border border-hairline/40">
                      {effortLevels.map((level, index) => (
                        <button key={level ?? "default"} type="button" aria-pressed={bot.modelSelection.effort === level} onClick={() => patch({ modelSelection: { ...bot.modelSelection, effort: level } })} className={cn("flex-1 py-1.5 text-[12px] capitalize", index > 0 && "border-l border-hairline/40", bot.modelSelection.effort === level ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60")}>{level === "xhigh" ? "X-High" : level ?? "Default"}</button>
                      ))}
                    </div>
                  </div>
                ) : null}

                <ProfileRow title="Connected apps" detail={connectedAppsConfigured ? `${connectedAppCount ?? 0} connected in this workspace.` : "Connect apps in workspace Settings first."}>
                  <Toggle checked={connectedAppsEnabled} label="Allow connected apps" disabled={!connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)} onChange={() => patch({ composio: !connectedAppsEnabled })} />
                </ProfileRow>

                <div className="rounded-xl bg-card p-4">
                  <div className="text-[14px] font-medium text-ink">Computer destination</div>
                  <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
                    {COMPUTER_DESTINATIONS.map(({ mode, label }, index) => (
                      <button key={mode} type="button" disabled={mode === "local" && !localSelectable} title={mode === "local" && !localSelectable ? localDisabledReason ?? undefined : undefined} onClick={() => { if (mode === bot.computer) return; if (mode === "local" && bot.autoApprove) setLocalAutoWarning("local"); else patch({ computer: mode }); }} className={cn("flex-1 py-1.5 text-[12px]", index > 0 && "border-l border-hairline/40", mode === "local" && !localSelectable && "opacity-40", bot.computer === mode ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60")}>{label}</button>
                    ))}
                  </div>
                  {(!bot.computer || bot.computer === "cloud") ? (
                    <>
                      <CloudBackendPicker value={bot.cloudBackend ?? "box"} vpsSupported={canUseVps} onChange={(backend) => patch({ cloudBackend: backend })} />
                      {!bot.computer && bot.cloudBackend === "vps" ? <ProfileRow title="Start VPS automatically"><Toggle checked={Boolean(bot.autoStartVps)} label="Start VPS automatically" onChange={() => patch({ autoStartVps: !bot.autoStartVps })} /></ProfileRow> : null}
                    </>
                  ) : null}
                </div>

                <WorkingFolder bot={bot} />

                <div className={cn("rounded-xl border p-4", bot.chiefOfStaff ? "border-accent/40 bg-accent/10" : "border-hairline/40 bg-card")}>
                  <div className="flex items-center gap-3">
                    <span className={cn("flex size-8 items-center justify-center rounded-lg", bot.chiefOfStaff ? "bg-accent text-white" : "bg-control text-ink-secondary")}><Crown size={16} /></span>
                    <div className="min-w-0 flex-1"><div className="text-[14px] font-medium text-ink">Coordinator</div><div className="text-[11.5px] text-ink-secondary">Optional for {sectionName}</div></div>
                    <Toggle checked={Boolean(bot.chiefOfStaff)} label="Coordinator role" disabled={!bot.chiefOfStaff && !canCoordinate} title={!bot.chiefOfStaff && !canCoordinate ? "This engine cannot contact other agents" : currentCoordinator ? `Replaces ${currentCoordinator.name}` : undefined} onChange={() => patch({ chiefOfStaff: !bot.chiefOfStaff })} />
                  </div>
                </div>

                <ProfileRow title="Ask before delegation" detail="Require approval before this agent contacts another agent.">
                  <Toggle checked={Boolean(bot.approvePeerComms)} label="Ask before delegation" disabled={!bot.approvePeerComms && !canCoordinate} onChange={() => patch({ approvePeerComms: !bot.approvePeerComms })} />
                </ProfileRow>

                <VoiceSettings bot={bot} onPatch={patch} />
                <MemoryEditor key={bot.id} bot={bot} revealToken={memoryRevealToken} />

                <button type="button" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })} className="rounded-xl px-3 py-2 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink">Open global Usage →</button>
              </div>
            </details>
          </div>
        </div>
      </aside>

      <LocalComputerAutoWarning
        open={localAutoWarning !== null}
        onCancel={() => setLocalAutoWarning(null)}
        onConfirm={() => {
          if (localAutoWarning === "auto") patch({ autoApprove: true, acknowledgeLocalAuto: true });
          if (localAutoWarning === "local") patch({ computer: "local", acknowledgeLocalAuto: true });
          setLocalAutoWarning(null);
        }}
      />
    </>
  );
}
