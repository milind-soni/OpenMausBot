// App settings, as a real modal with sections rather than one long panel.
// Per-bot settings (persona, model, computer) stay in SettingsPanel — this
// is the stuff shared by every bot: who you are, your keys, and the
// machine your bots can borrow.
import { useEffect, useRef, useState } from "react";
import { Coins, KeyRound, Monitor, Search, Smartphone, Terminal, User, X } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { skillRecorderEnabled } from "@/lib/feature-flags";
import { ApiKeyRow, VpsConnection } from "./ApiKeys";
import { useUpdaterState } from "@/lib/updater";
import { EnginesSettings } from "./EnginesSettings";
import { LocalComputerSection } from "./LocalComputerSection";
import { CompanionSection } from "./CompanionSection";
import { Card } from "./SettingsPrimitives";
import { UsageSection } from "./UsageSection";
import { SkinPicker } from "./SkinPicker";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { TranscriptionSettings } from "./TranscriptionSettings";
import { WorkspaceVoiceSettings } from "./WorkspaceVoiceSettings";
import { cn } from "@/lib/cn";
import type { EncryptedBackupStatus } from "@/types/ogb";

const SECTIONS: Array<{
  id: AppSettingsSection;
  label: string;
  icon: typeof User;
  keywords: string[];
}> = [
  { id: "general", label: "General", icon: User, keywords: ["profile", "name", "email", "skin", "theme", "appearance", "analytics", "updates"] },
  { id: "connections", label: "Connections", icon: KeyRound, keywords: ["keys", "api", "composio", "box", "xai", "vps"] },
  { id: "engines", label: "Engines", icon: Terminal, keywords: ["models", "claude", "grok", "providers", "cli"] },
  { id: "companion", label: "Phone", icon: Smartphone, keywords: ["companion", "phone", "pair", "mobile"] },
  { id: "computer", label: "Local VM", icon: Monitor, keywords: ["vm", "virtual", "desktop"] },
  { id: "usage", label: "Usage", icon: Coins, keywords: ["tokens", "cost", "billing"] },
];

function sectionMatches(section: (typeof SECTIONS)[number], query: string): boolean {
  if (!query) return true;
  return [section.label, ...section.keywords].some((part) => part.toLowerCase().includes(query));
}

/** Name + email, persisted to /api/config {profile} on blur. */
function ProfileFields() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = () => {
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    })
      .then((r) => r.json())
      .then((config) => dispatch({ type: "configStatus", config }))
      .catch(() => {});
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder="Your name" className={inputClass} />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={save}
        placeholder="you@example.com"
        className={inputClass}
      />
    </div>
  );
}

function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  const label =
    s?.status === "checking"
      ? "Checking…"
      : s?.status === "available"
        ? `${s.version} available`
        : s?.status === "downloading"
          ? `Downloading ${Math.round(s.percent ?? 0)}%`
          : s?.status === "downloaded"
            ? `${s.version} ready — restart to apply`
            : s?.status === "error"
              ? `Check failed: ${s.message ?? "unknown error"}`
              : "You're on the latest version we know of.";
  return (
    <Card title="Updates" subtitle={label}>
      <button
        onClick={() => {
          if (s?.status === "available") return void updater.download();
          if (s?.status === "downloaded") return void updater.install();
          void updater.check();
        }}
        disabled={s?.status === "checking" || s?.status === "downloading"}
        className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
      >
        {s?.status === "available"
          ? "Download"
          : s?.status === "downloaded"
            ? "Restart and install"
            : "Check for updates"}
      </button>
    </Card>
  );
}

/** Usage analytics, on by default and switchable here. Naming what is sent
 * matters more than the switch: people who cannot see the scope assume the
 * worst, and the worst — conversation text — is exactly what this never
 * sends (autocapture is off; see lib/analytics.ts). */
function AnalyticsRow() {
  const [on, setOn] = useState(analyticsEnabled);
  return (
    <Card
      title="Usage analytics"
      subtitle="Anonymous product events — app opened, which features get used. Never conversations, prompts, file contents, or agent output. Your email is only attached if you shared it during setup."
    >
      <button
        role="switch"
        aria-checked={on}
        aria-label="Send usage analytics"
        onClick={() => {
          const next = !on;
          setAnalyticsEnabled(next);
          setOn(next);
        }}
        className={cnSwitch(on)}
      >
        <span className={cnKnob(on)} />
      </button>
    </Card>
  );
}

function ExperimentalFeaturesRow() {
  const { state, dispatch } = useStore();
  const enabled = skillRecorderEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { skillRecorder: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the experimental feature setting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Experimental features"
      subtitle="Early features may change while we test them. They stay off unless you enable them."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Teach a skill</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            Show the workflow recorder in the sidebar.
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Show Teach a skill"
          disabled={saving}
          onClick={() => void toggle()}
          className={`${cnSwitch(enabled)} disabled:cursor-wait disabled:opacity-50`}
        >
          <span className={cnKnob(enabled)} />
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;

/** Writes a redacted diagnostics file to a location the user picks. The
 * report holds versions, configured-or-not booleans and the server.log tail —
 * never credential values (the desktop shell does not read secret fields). */
function DiagnosticsRow() {
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const exportDiagnostics = async () => {
    if (!window.ogb?.exportDiagnostics || exporting) return;
    setExporting(true);
    setResult(null);
    try {
      const path = await window.ogb.exportDiagnostics();
      if (path) setResult({ kind: "success", message: `Saved to ${path}` });
    } catch (e) {
      setResult({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card
      title="Diagnostics"
      subtitle="Versions, configuration on/off state and a redacted server log tail. Review the file before sharing it."
    >
      <div className="flex min-w-0 flex-col items-end gap-2">
        <button
          onClick={() => void exportDiagnostics()}
          disabled={exporting}
          aria-label="Export diagnostics to a text file"
          className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
        >
          {exporting ? "Exporting…" : "Export Diagnostics…"}
        </button>
        {result ? (
          <span
            role={result.kind === "error" ? "alert" : "status"}
            className={`max-w-64 break-all text-right text-[12px] ${result.kind === "error" ? "text-danger" : "text-success"}`}
          >
            {result.message}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

function BackupRow() {
  const bridge = window.ogb?.backup;
  const [status, setStatus] = useState<EncryptedBackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    if (!bridge) return;
    void bridge.status().then(setStatus).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not inspect backups.");
    });
  }, [bridge]);

  if (!bridge) return null;
  const latest = status?.latest;
  const detail = !status
    ? "Checking the newest encrypted backup…"
    : !status.available
      ? "Encrypted backups run automatically in the installed desktop app."
      : !latest
        ? "No verified backup exists yet. Create the first one now."
        : latest.verified && latest.createdAt
          ? `Newest backup verified ${new Date(latest.createdAt).toLocaleString()} · ${latest.files ?? 0} core files · ${status.count} retained`
          : `Newest backup needs attention${latest.error ? `: ${latest.error}` : "."}`;

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      setStatus(await bridge.create());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a backup.");
    } finally {
      setBusy(false);
    }
  };

  const setRetention = async (keep: number) => {
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      setStatus(await bridge.setRetention(keep));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update backup retention.");
    } finally {
      setBusy(false);
    }
  };

  const exportRecoveryKey = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      const saved = await bridge.exportRecoveryKey();
      if (saved) setFeedback(`Recovery key saved to ${saved}. Keep it separate from the backups.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export the recovery key.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Recovery" subtitle={detail}>
      <div className="flex min-w-0 flex-col items-end gap-2">
        <div className="flex flex-wrap justify-end gap-2">
          <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
            Keep
            <select
              aria-label="Number of encrypted backups to retain"
              value={status?.keep ?? 14}
              disabled={busy || !status?.available}
              onChange={(event) => void setRetention(Number(event.target.value))}
              className="rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[13px] text-ink disabled:opacity-40"
            >
              {[7, 14, 30, 60].map((keep) => <option key={keep} value={keep}>{keep}</option>)}
            </select>
          </label>
          <button
            onClick={() => void bridge.openFolder()}
            className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control"
          >
            Open folder
          </button>
          <button
            onClick={() => void exportRecoveryKey()}
            disabled={busy || status?.available === false}
            className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
          >
            Save recovery key…
          </button>
          <button
            onClick={() => void create()}
            disabled={busy || status?.available === false}
            className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
          >
            {busy ? "Working…" : "Back up now"}
          </button>
        </div>
        {feedback ? <span role="status" className="max-w-72 break-all text-right text-[12px] text-success">{feedback}</span> : null}
        {error ? <span role="alert" className="max-w-72 text-right text-[12px] text-danger">{error}</span> : null}
      </div>
    </Card>
  );
}

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const section = state.appSettingsSection;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visibleSections = SECTIONS.filter((entry) => sectionMatches(entry, q));

  useEffect(() => {
    const visible = SECTIONS.filter((entry) => sectionMatches(entry, q));
    if (visible.some((entry) => entry.id === section)) return;
    const first = visible[0];
    if (first) dispatch({ type: "toggleAppSettings", open: true, section: first.id });
  }, [dispatch, q, section]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className="flex h-[560px] w-full max-w-[860px] overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none"
      >
        {/* section nav */}
        <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 border-r border-hairline/40 p-3">
          <div id="app-settings-title" className="px-2 pb-2 pt-1 text-[15px] font-semibold text-ink">
            Settings
          </div>
          <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-control/70 px-2.5 py-1.5">
            <Search size={14} className="shrink-0 text-ink-secondary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                if (query) setQuery("");
                else dispatch({ type: "toggleAppSettings", open: false });
              }}
              placeholder="Search"
              aria-label="Search settings"
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
          {visibleSections.length === 0 && (
            <div className="px-2.5 py-4 text-[12.5px] leading-relaxed text-ink-secondary">
              Nothing matches “{query.trim()}”
            </div>
          )}
          {visibleSections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px]",
                section === id ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-[15px] font-semibold text-ink">
              {SECTIONS.find((s) => s.id === section)?.label}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label="Close settings"
              className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {section === "general" && (
              <>
                <Card title="Profile" subtitle="Shown in the sidebar. Saved as you go.">
                  <ProfileFields />
                </Card>
                <Card title="Skin" subtitle="Applies instantly and is remembered on this machine.">
                  <SkinPicker />
                </Card>
                <Card title="Channel turns" subtitle="Set one maximum duration for every agent turn in a channel.">
                  <RoomTurnTimeoutSettings />
                </Card>
                <ExperimentalFeaturesRow />
                <UpdatesRow />
                <BackupRow />
                <DiagnosticsRow />
                <AnalyticsRow />
              </>
            )}

            {section === "connections" && (
              <Card
                title="Connections"
                subtitle="Connected apps work automatically in the installed app. Other optional service keys stay on this computer."
              >
                <div className="flex flex-col gap-4">
                  {state.config?.composio.mode === "managed" ? (
                    <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
                      Connected apps service is ready
                    </div>
                  ) : null}
                  <WorkspaceVoiceSettings />
                  <TranscriptionSettings />
                  <ApiKeyRow section="box" />
                  <VpsConnection />
                  <ApiKeyRow section="opencodeGo" />
                  <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
                    <summary className="cursor-pointer text-[13px] text-ink-secondary">Self-host connected apps</summary>
                    <div className="mt-3">
                      <ApiKeyRow section="composio" />
                    </div>
                  </details>
                </div>
              </Card>
            )}

            {section === "engines" && (
              <Card title="Engine CLIs" subtitle="Which binary each engine runs. Saved as you go.">
                <EnginesSettings />
              </Card>
            )}

            {section === "companion" && <CompanionSection profileEmail={state.config?.profile?.email} />}

            {section === "computer" && <LocalComputerSection />}

            {section === "usage" && <UsageSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
