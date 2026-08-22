import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Cloud,
  Copy,
  ExternalLink,
  Laptop,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCw,
  Send,
  Trash2,
  Webhook,
  X,
} from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { RoutineRun, RoutineRunOn } from "@/lib/routines";
import {
  loadWebhookCredentials,
  removeWebhookCredential,
  saveWebhookCredential,
  webhookCredentialStore,
} from "@/lib/webhook-credentials";
import { webhookActivationDefaults, type WebhookAttempt, type WebhookCredential, type WebhookTrigger, type WebhookTriggerInput } from "@/lib/webhooks";
import { api, useStore, type Bot } from "@/state/store";

function relativeTime(at?: number) {
  if (!at) return "Never";
  const elapsed = Math.max(0, Date.now() - at);
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

function deliverySummary(run: RoutineRun) {
  const eventName = run.prompt?.match(/^Event: (.+)$/m)?.[1]?.trim() || "Webhook event";
  const eventData = run.prompt?.match(/\[UNTRUSTED WEBHOOK EVENT DATA\]\n([\s\S]*?)\n\[\/UNTRUSTED WEBHOOK EVENT DATA\]/)?.[1] ?? "";
  const payloadStart = eventData.indexOf("\n\n");
  const payload = (payloadStart >= 0 ? eventData.slice(payloadStart + 2) : eventData).replace(/\s+/g, " ").trim();
  return { eventName, preview: payload.slice(0, 240) };
}

function suggestedName(prompt: string, bot?: Bot) {
  const first = prompt.trim().split(/[.!?\n]/)[0]?.trim().slice(0, 60);
  return first || `${bot?.name ?? "MAUS"} webhook`;
}

function statusFor(webhook: WebhookTrigger) {
  if (webhook.verificationPending) return { label: "Waiting for test", tone: "text-accent", dot: "bg-accent animate-pulse" };
  if (webhook.verifiedAt && !webhook.enabled) return { label: "Ready to enable", tone: "text-warning", dot: "bg-warning" };
  if (webhook.enabled) return { label: "Active", tone: "text-success", dot: "bg-success" };
  return { label: "Paused", tone: "text-ink-secondary", dot: "bg-ink-secondary/50" };
}

function outcomeTone(outcome: WebhookAttempt["outcome"], run?: RoutineRun) {
  if (outcome === "rejected" || run?.status === "failed" || run?.status === "missed") return "text-danger";
  if (run && ["queued", "running", "waiting"].includes(run.status)) return "text-accent";
  if (run?.status === "completed" || outcome === "captured" || outcome === "accepted") return "text-success";
  return "text-ink-secondary";
}

function outcomeLabel(outcome: WebhookAttempt["outcome"], run?: RoutineRun) {
  if (run) return run.status === "waiting" ? "Needs you" : run.status[0]!.toUpperCase() + run.status.slice(1);
  if (outcome === "captured") return "Test received";
  if (outcome === "duplicate") return "Duplicate";
  if (outcome === "ignored") return "Ignored";
  if (outcome === "rejected") return "Rejected";
  return "Accepted";
}

function terminalCommand(credential: WebhookCredential) {
  return `curl -sS '${credential.url}' --json '{"task":"A customer wrote: This app saved me hours. Write a short thank-you reply."}'`;
}

function WebhookEditor({ webhook, bots, onClose, onCredential }: { webhook?: WebhookTrigger; bots: Bot[]; onClose: () => void; onCredential: (credential: WebhookCredential, webhookId: string) => void }) {
  const { state, dispatch } = useStore();
  const [botId, setBotId] = useState(webhook?.botId ?? bots[0]?.id ?? "");
  const [name, setName] = useState(webhook?.name ?? "");
  const [prompt, setPrompt] = useState(webhook?.prompt ?? "");
  const [runOn, setRunOn] = useState<RoutineRunOn>(webhook?.runOn ?? "maus");
  const [eventTypes, setEventTypes] = useState((webhook?.eventTypes ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const cloudInstance = state.instances.find((instance) => instance.driverKind === "boxAgent");
  const cloudReady = Boolean(state.config?.box.configured && cloudInstance?.snapshot.state === "available");

  const save = async () => {
    const bot = bots.find((candidate) => candidate.id === botId);
    const input: WebhookTriggerInput = { name: name.trim() || suggestedName(prompt, bot), prompt: prompt.trim(), botId, runOn, ...webhookActivationDefaults(webhook), eventTypes: eventTypes.split(",").map((value) => value.trim()).filter(Boolean) };
    setSaving(true);
    setError("");
    try {
      const response = await api(webhook ? `/api/webhooks/${webhook.id}` : "/api/webhooks", { method: webhook ? "PATCH" : "POST", body: JSON.stringify(input) });
      dispatch({ type: "webhookPatched", webhook: response.webhook });
      onClose();
      if (response.credential) onCredential(response.credential, response.webhook.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="flex max-h-[90vh] w-full max-w-[590px] flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-start justify-between border-b border-hairline/40 px-5 py-4"><div><div className="text-[17px] font-semibold text-ink">{webhook ? "Edit webhook" : "New local webhook"}</div><div className="mt-1 text-[12px] text-ink-secondary">Each request starts a new task in the MAUS chat.</div></div><button onClick={onClose} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button></div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <div><div className="mb-2 text-[12px] font-medium text-ink-secondary">Who receives the tasks?</div><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{bots.map((bot) => <button key={bot.id} type="button" onClick={() => setBotId(bot.id)} className={cn("flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-left", botId === bot.id ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}><BotAvatar bot={bot} state={botId === bot.id ? "happy" : "idle"} size={38} animated={false} /><span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{bot.name}</span></button>)}</div></div>
          <div className="rounded-xl border border-accent/20 bg-accent/5 px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-secondary">Send the task in the request: <code className="text-ink">{`{"task":"Check the failed build"}`}</code>. The MAUS keeps its model, tools, permissions, and computer setup.</div>
          <details className="group rounded-xl border border-hairline/45 bg-inset/45 px-4 py-3" open={Boolean(webhook)}>
            <summary className="cursor-pointer text-[12.5px] font-medium text-ink">Advanced options</summary>
            <div className="mt-4 space-y-4">
              <label className="block"><span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">Name <span className="font-normal">· optional</span></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={suggestedName(prompt, bots.find((bot) => bot.id === botId))} className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70" /></label>
              <label className="block"><span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">Default instructions <span className="font-normal">· optional</span></span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="For every event, summarize what happened and suggest the next step…" className="w-full resize-y rounded-xl border border-hairline/60 bg-panel px-3.5 py-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70" /><span className="mt-1.5 block text-[10.5px] leading-relaxed text-ink-secondary">Use this only when every event needs the same handling rule. Otherwise the request’s task is used.</span></label>
              <div><div className="mb-2 text-[11.5px] font-medium text-ink-secondary">Run on</div><div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => setRunOn("maus")} className={cn("rounded-xl border p-3 text-left", runOn === "maus" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-panel hover:bg-raised/60")}><div className="flex items-center gap-2 text-[12.5px] font-medium text-ink"><Laptop size={14} />This computer</div></button><button type="button" disabled={!cloudReady && runOn !== "cloud"} onClick={() => setRunOn("cloud")} className={cn("rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-45", runOn === "cloud" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-panel hover:bg-raised/60")}><div className="flex items-center gap-2 text-[12.5px] font-medium text-ink"><Cloud size={14} />Cloud VM</div></button></div></div>
              <label className="block"><span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">Only accept event types <span className="font-normal">· optional</span></span><input value={eventTypes} onChange={(event) => setEventTypes(event.target.value)} placeholder="push, workflow_run" className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70" /><span className="mt-1.5 block text-[10.5px] text-ink-secondary">Comma-separated values from the sender’s event-type header.</span></label>
            </div>
          </details>
          {error && <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12px] text-danger">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline/40 px-5 py-4"><button onClick={onClose} className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">Cancel</button><button disabled={saving || !botId} onClick={() => void save()} className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40">{saving && <Loader2 size={14} className="animate-spin" />}{webhook ? "Save changes" : "Create local webhook"}</button></div>
      </div>
    </div>
  );
}

interface ActivityItem { id: string; at: number; outcome: WebhookAttempt["outcome"]; eventName: string; preview: string; reason?: string; run?: RoutineRun }

/** A destination-first webhook view: choose a MAUS endpoint on the left, then
 * either copy its setup command or inspect its deliveries on the right. */
export function WebhooksPanel({ bots }: { bots: Bot[] }) {
  const { state, dispatch } = useStore();
  const [editor, setEditor] = useState<WebhookTrigger | "new" | null>(null);
  const [credentials, setCredentials] = useState<Record<string, WebhookCredential>>(() =>
    loadWebhookCredentials(webhookCredentialStore()),
  );
  const [selectedId, setSelectedId] = useState<string | null>(state.webhooks[0]?.id ?? null);
  const [tab, setTab] = useState<"setup" | "activity">("setup");
  const [working, setWorking] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const runById = useMemo(() => new Map(state.routineRuns.map((run) => [run.id, run])), [state.routineRuns]);

  useEffect(() => {
    if (!state.webhooks.length) setSelectedId(null);
    else if (!selectedId || !state.webhooks.some((webhook) => webhook.id === selectedId)) setSelectedId(state.webhooks[0]!.id);
  }, [selectedId, state.webhooks]);

  const selected = state.webhooks.find((webhook) => webhook.id === selectedId) ?? null;
  const selectedBot = selected ? bots.find((bot) => bot.id === selected.botId) : undefined;
  const attemptsByRun = useMemo(() => new Set(state.webhookAttempts.map((attempt) => attempt.runId).filter(Boolean)), [state.webhookAttempts]);
  const activity = useMemo<ActivityItem[]>(() => {
    if (!selected) return [];
    const attempts = state.webhookAttempts
      .filter((attempt) => attempt.webhookId === selected.id)
      .map((attempt) => ({
        id: attempt.id,
        at: attempt.receivedAt,
        outcome: attempt.outcome,
        eventName: attempt.eventName || (attempt.outcome === "rejected" ? "Rejected request" : "Webhook event"),
        preview: attempt.preview || "",
        reason: attempt.reason,
        run: attempt.runId ? runById.get(attempt.runId) : undefined,
      }));
    const legacy = state.routineRuns
      .filter((run) => run.webhookId === selected.id && !attemptsByRun.has(run.id))
      .map((run) => {
        const summary = deliverySummary(run);
        return { id: run.id, at: run.scheduledFor, outcome: "accepted" as const, eventName: summary.eventName, preview: summary.preview, run };
      });
    return [...attempts, ...legacy].sort((a, b) => b.at - a.at).slice(0, 30);
  }, [attemptsByRun, runById, selected, state.routineRuns, state.webhookAttempts]);

  const invoke = async (webhook: WebhookTrigger, action: "toggle" | "delete") => {
    setWorking(`${webhook.id}:${action}`);
    setError("");
    try {
      if (action === "delete") {
        if (!window.confirm(`Delete “${webhook.name}”? Existing task history will stay available.`)) return;
        await api(`/api/webhooks/${webhook.id}`, { method: "DELETE" });
        dispatch({ type: "webhookDeleted", webhookId: webhook.id });
        removeWebhookCredential(webhookCredentialStore(), webhook.id);
        setCredentials((current) => {
          const next = { ...current };
          delete next[webhook.id];
          return next;
        });
      } else {
        const enabling = !webhook.enabled;
        if (enabling && webhook.verificationPending) throw new Error("Send a request before turning this webhook on");
        const response = await api(`/api/webhooks/${webhook.id}`, { method: "PATCH", body: JSON.stringify({ enabled: enabling, verificationPending: false }) });
        dispatch({ type: "webhookPatched", webhook: response.webhook });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  };

  const createAndCopyCommand = async (webhook: WebhookTrigger, replace = false) => {
    if (replace && !window.confirm("Replace this private URL? Every previously copied command will stop working.")) return;
    setWorking(`${webhook.id}:command`);
    setError("");
    try {
      let credential = replace ? undefined : credentials[webhook.id];
      if (!credential) {
        const response = await api(`/api/webhooks/${webhook.id}/rotate`, { method: "POST" });
        credential = response.credential;
        dispatch({ type: "webhookPatched", webhook: response.webhook });
        setCredentials((current) => ({ ...current, [webhook.id]: credential! }));
        saveWebhookCredential(webhookCredentialStore(), webhook.id, credential!);
      }
      if (!credential) throw new Error("Could not create a terminal command");
      await navigator.clipboard.writeText(terminalCommand(credential));
      setCopiedId(webhook.id);
      setTimeout(() => setCopiedId((current) => current === webhook.id ? null : current), 1_800);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  };

  const ingress = state.webhookIngress;
  const credential = selected ? credentials[selected.id] : undefined;
  const command = credential ? terminalCommand(credential) : "";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto border-t border-hairline/40 p-4 md:p-6">
      <div className="mx-auto max-w-[1120px] space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[17px] font-semibold text-ink">Webhooks</h2>
              <span className="rounded-md bg-accent/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-accent">Local beta</span>
            </div>
            <p className="mt-1 text-[12px] text-ink-secondary">Send a task to a MAUS when another tool reports an event.</p>
          </div>
          <div className="flex items-center gap-3">
            <div className={cn("hidden items-center gap-1.5 text-[10.5px] sm:flex", ingress?.available ? "text-success" : "text-danger")}>
              <span className={cn("size-1.5 rounded-full", ingress?.available ? "bg-success" : "bg-danger")} />
              {ingress?.available ? "Receiver running" : ingress?.error ?? "Receiver unavailable"}
            </div>
            <button onClick={() => setEditor("new")} disabled={bots.length === 0} className="flex items-center gap-2 rounded-xl bg-accent px-3.5 py-2 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-40">
              <Plus size={15} />New webhook
            </button>
          </div>
        </header>

        {error && <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12px] text-danger">{error}</div>}

        {state.webhooks.length === 0 ? (
          <div className="border-t border-hairline/40 px-6 py-16 text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Send size={23} /></div>
            <h3 className="text-[16px] font-semibold text-ink">Create your first webhook</h3>
            <p className="mx-auto mt-2 max-w-[420px] text-[12.5px] leading-relaxed text-ink-secondary">Choose a MAUS, copy one command, and every request becomes a new task in its chat.</p>
            <button onClick={() => setEditor("new")} disabled={bots.length === 0} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"><Plus size={15} />Create local webhook</button>
            {bots.length === 0 && <p className="mt-3 text-[12px] text-warning">Create a MAUS first, then come back here.</p>}
          </div>
        ) : selected && (
          <div className="min-h-[580px] overflow-hidden rounded-2xl border border-hairline/45 bg-panel/25 md:grid md:grid-cols-[250px_minmax(0,1fr)]">
            <aside className="border-b border-hairline/40 bg-inset/35 p-2.5 md:border-r md:border-b-0">
              <div className="flex items-center justify-between px-2 py-2">
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-secondary">Your webhooks</span>
                <span className="text-[10px] tabular-nums text-ink-secondary">{state.webhooks.length}</span>
              </div>
              <nav className="flex gap-1 overflow-x-auto md:block md:space-y-1 md:overflow-visible">
                {state.webhooks.map((webhook) => {
                  const bot = bots.find((candidate) => candidate.id === webhook.botId);
                  const status = statusFor(webhook);
                  return (
                    <button key={webhook.id} onClick={() => { setSelectedId(webhook.id); setTab("setup"); setError(""); }} className={cn("flex min-w-[210px] items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition-colors md:w-full md:min-w-0", webhook.id === selected.id ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:bg-raised/55 hover:text-ink")}>
                      {bot ? <BotAvatar bot={bot} state={webhook.enabled ? "idle" : "sleeping"} size={36} animated={false} label={bot.name} /> : <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-raised text-ink-secondary"><Webhook size={16} /></div>}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium">{webhook.name}</span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[10px]"><span className={cn("size-1.5 rounded-full", status.dot)} /><span className={status.tone}>{status.label}</span></span>
                      </span>
                    </button>
                  );
                })}
              </nav>
            </aside>

            <section className="min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 md:px-7 md:pt-6">
                <div className="flex min-w-0 items-center gap-3">
                  {selectedBot ? <BotAvatar bot={selectedBot} state={selected.enabled ? "idle" : "sleeping"} size={44} animated={false} label={selectedBot.name} /> : <div className="flex size-11 items-center justify-center rounded-xl bg-raised text-ink-secondary"><Webhook size={18} /></div>}
                  <div className="min-w-0">
                    <h3 className="truncate text-[17px] font-semibold text-ink">{selected.name}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-ink-secondary"><span>{selectedBot?.name ?? "Deleted MAUS"}</span><span>·</span><span>{selected.runOn === "cloud" ? "Cloud VM" : "This computer"}</span></div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!selected.verificationPending && <button disabled={Boolean(working)} onClick={() => void invoke(selected, "toggle")} className={cn("flex items-center gap-1.5 rounded-lg px-3 py-2 text-[11.5px] font-medium", selected.enabled ? "bg-raised text-ink-secondary hover:text-ink" : "bg-accent text-white hover:brightness-110")}>{selected.enabled ? <Pause size={13} /> : <Play size={13} />}{selected.enabled ? "Pause" : "Enable"}</button>}
                  <details className="relative"><summary className="list-none rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><MoreHorizontal size={17} /></summary><div className="absolute right-0 top-full z-20 mt-1 w-[180px] rounded-xl border border-hairline/50 bg-card p-1.5 shadow-2xl"><button onClick={() => setEditor(selected)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-ink hover:bg-raised">Edit settings</button><button onClick={() => void invoke(selected, "delete")} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-danger hover:bg-danger/10"><Trash2 size={13} />Delete</button></div></details>
                </div>
              </div>

              <div className="mt-5 flex gap-5 border-b border-hairline/35 px-5 md:px-7">
                <button onClick={() => setTab("setup")} className={cn("border-b-2 px-0.5 pb-3 text-[12px] font-medium", tab === "setup" ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:text-ink")}>Setup</button>
                <button onClick={() => setTab("activity")} className={cn("flex items-center gap-1.5 border-b-2 px-0.5 pb-3 text-[12px] font-medium", tab === "activity" ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:text-ink")}>Activity{activity.length > 0 && <span className="rounded-full bg-raised px-1.5 py-0.5 text-[9px] tabular-nums text-ink-secondary">{activity.length}</span>}</button>
              </div>

              {tab === "setup" ? (
                <div className="px-5 py-6 md:px-7">
                  <div className="max-w-[720px]">
                    <h4 className="text-[14px] font-semibold text-ink">Send a task</h4>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">Copy this command into Terminal and press Return. It starts a real task in {selectedBot?.name ?? "this MAUS"}&apos;s chat; edit the task text for whatever you want done.</p>
                    {credential ? (
                      <div className="mt-4 overflow-hidden rounded-xl border border-hairline/45 bg-[#0d0d0d]">
                        <div className="flex items-center justify-between border-b border-white/5 px-3.5 py-2"><span className="text-[9.5px] font-medium uppercase tracking-wider text-ink-secondary">Terminal</span><div className="flex items-center gap-1"><button onClick={() => void createAndCopyCommand(selected)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink">{copiedId === selected.id ? <Check size={12} className="text-success" /> : <Copy size={12} />}{copiedId === selected.id ? "Copied" : "Copy command"}</button><button onClick={() => void createAndCopyCommand(selected, true)} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" title="Rotate private URL"><RotateCw size={12} /></button></div></div>
                        <pre className="overflow-x-auto p-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-ink-secondary">{command}</pre>
                      </div>
                    ) : (
                      <div className="mt-4">
                        <p className="max-w-[560px] text-[10.5px] leading-relaxed text-ink-secondary">The private URL is shown once. Generate a replacement to copy your webhook command; any older command for this webhook will stop working.</p>
                        <button disabled={Boolean(working) || !ingress?.available} onClick={() => void createAndCopyCommand(selected)} className="mt-3 flex items-center gap-2 rounded-xl bg-accent px-3.5 py-2.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40">{working === `${selected.id}:command` ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}Generate new private URL</button>
                      </div>
                    )}
                    <div className="mt-3 flex items-start gap-2 text-[10.5px] leading-relaxed text-ink-secondary"><Laptop size={12} className="mt-0.5 shrink-0" /><span>Local only for now. Keep OpenMausBot open while sending the request.</span></div>

                    {selected.verificationSample && !selected.enabled && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-y border-success/20 bg-success/5 px-3.5 py-3"><div><div className="flex items-center gap-2 text-[11.5px] font-medium text-success"><Check size={13} />Request received</div><p className="mt-1 max-w-[520px] truncate font-mono text-[10px] text-ink-secondary">{selected.verificationSample.preview || "Empty payload"}</p></div><button disabled={Boolean(working)} onClick={() => void invoke(selected, "toggle")} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[11px] font-medium text-white hover:brightness-110"><Play size={12} />Turn on</button></div>}

                    <div className="mt-7 border-t border-hairline/35 pt-5">
                      <div className="grid gap-4 text-[11.5px] sm:grid-cols-2"><div><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Tasks go to</div><div className="mt-1.5 font-medium text-ink">{selectedBot?.name ?? "Deleted MAUS"}</div></div><div><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Runs on</div><div className="mt-1.5 font-medium text-ink">{selected.runOn === "cloud" ? "Cloud VM" : "This computer"}</div></div></div>
                    </div>

                    <details className="group mt-5 border-t border-hairline/35 pt-4"><summary className="flex cursor-pointer list-none items-center justify-between text-[11.5px] font-medium text-ink"><span>Advanced</span><ChevronDown size={14} className="text-ink-secondary transition-transform group-open:rotate-180" /></summary><div className="mt-4 space-y-3 text-[10.5px] leading-relaxed text-ink-secondary">{selected.prompt ? <p><span className="font-medium text-ink">Default instruction:</span> {selected.prompt}</p> : <p>The task or message sent with each request becomes the MAUS instruction.</p>}{selected.eventTypes?.length ? <p><span className="font-medium text-ink">Accepted events:</span> {selected.eventTypes.join(", ")}</p> : <p>All event types are accepted.</p>}<button onClick={() => setEditor(selected)} className="rounded-lg border border-hairline/50 px-3 py-2 text-[11px] font-medium text-ink hover:bg-raised">Edit settings</button></div></details>
                  </div>
                </div>
              ) : (
                <div className="px-5 py-5 md:px-7">
                  <div className="mb-3"><h4 className="text-[13px] font-semibold text-ink">Recent deliveries</h4><p className="mt-1 text-[10.5px] text-ink-secondary">Accepted and rejected requests update automatically.</p></div>
                  <div className="border-t border-hairline/35">
                    {activity.length === 0 ? <div className="px-2 py-12 text-center text-[11.5px] text-ink-secondary">No requests yet. Use the command in Setup to send one.</div> : activity.map((item) => (
                      <div key={item.id} className="flex items-center gap-2.5 border-b border-hairline/25 px-1 py-3.5">
                        <span className={cn("size-2 shrink-0 rounded-full", item.outcome === "rejected" || item.run?.status === "failed" ? "bg-danger" : item.run && ["queued", "running", "waiting"].includes(item.run.status) ? "animate-pulse bg-accent" : item.outcome === "ignored" || item.outcome === "duplicate" ? "bg-ink-secondary/50" : "bg-success")} />
                        <div className="min-w-0 flex-1"><div className="flex items-center gap-1.5 text-[11.5px]"><span className="truncate font-medium text-ink">{item.eventName}</span><span className="shrink-0 text-ink-secondary">· {relativeTime(item.at)}</span></div><div className="mt-0.5 truncate font-mono text-[10px] text-ink-secondary/85">{item.reason || item.preview || "Empty payload"}</div></div>
                        <span className={cn("shrink-0 text-[10px] font-medium", outcomeTone(item.outcome, item.run))}>{outcomeLabel(item.outcome, item.run)}</span>
                        {item.run?.threadId && selectedBot && <button onClick={() => { dispatch({ type: "select", id: selectedBot.id }); dispatch({ type: "switchTask", botId: selectedBot.id, threadId: item.run!.threadId! }); }} className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[10.5px] text-ink-secondary hover:bg-raised hover:text-ink" title="Open this execution in the MAUS chat"><ExternalLink size={11} />Open chat</button>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
      {editor && <WebhookEditor webhook={editor === "new" ? undefined : editor} bots={bots} onClose={() => setEditor(null)} onCredential={(newCredential, webhookId) => { saveWebhookCredential(webhookCredentialStore(), webhookId, newCredential); setCredentials((current) => ({ ...current, [webhookId]: newCredential })); setSelectedId(webhookId); setTab("setup"); }} />}
    </div>
  );
}
