// App settings, as a real modal with sections rather than one long panel.
// Per-bot settings (persona, model, computer) stay in SettingsPanel — this
// is the stuff shared by every bot: who you are, your keys, and the
// machine your bots can borrow.
import { useEffect, useRef, useState } from "react";
import { Coins, KeyRound, Monitor, Smartphone, Terminal, User, X } from "lucide-react";
import { useStore, type AppSettingsSection } from "@/state/store";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { ApiKeyRow, VpsConnection } from "./ApiKeys";
import { useUpdaterState } from "@/lib/updater";
import { EnginesSettings } from "./EnginesSettings";
import { LocalComputerSection } from "./LocalComputerSection";
import { CompanionSection } from "./CompanionSection";
import { Card } from "./SettingsPrimitives";
import { UsageSection } from "./UsageSection";
import { SkinPicker } from "./SkinPicker";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { cn } from "@/lib/cn";
import { LOCALES, type LocaleId } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

const SECTIONS: Array<{ id: AppSettingsSection; label: string; icon: typeof User }> = [
  { id: "general", label: "General", icon: User },
  { id: "connections", label: "Connections", icon: KeyRound },
  { id: "engines", label: "Engines", icon: Terminal },
  { id: "companion", label: "Companion", icon: Smartphone },
  { id: "computer", label: "Local VM", icon: Monitor },
  { id: "usage", label: "Usage", icon: Coins },
];

/** Name + email, persisted to /api/config {profile} on blur. */
function ProfileFields() {
  const { state, dispatch } = useStore();
  const { t } = useI18n();
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
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder={t("Your name")} className={inputClass} />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={save}
        placeholder={t("you@example.com")}
        className={inputClass}
      />
    </div>
  );
}

function UpdatesRow() {
  const s = useUpdaterState();
  const { t } = useI18n();
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  const label =
    s?.status === "checking"
      ? t("Checking…")
      : s?.status === "available"
        ? t("{version} available", { version: s.version ?? "" })
        : s?.status === "downloading"
          ? t("Downloading {percent}%", { percent: Math.round(s.percent ?? 0) })
          : s?.status === "downloaded"
            ? t("{version} ready — restart to apply", { version: s.version ?? "" })
            : s?.status === "error"
              ? t("Check failed: {message}", { message: s.message ?? t("unknown error") })
              : t("You're on the latest version we know of.");
  return (
    <Card title={t("Updates")} subtitle={label}>
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
          ? t("Download")
          : s?.status === "downloaded"
            ? t("Restart and install")
            : t("Check for updates")}
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
  const { t } = useI18n();
  return (
    <Card
      title={t("Usage analytics")}
      subtitle={t("Anonymous product events — app opened, which features get used. Never conversations, prompts, file contents, or bot output. Your email is only attached if you shared it during setup.")}
    >
      <button
        role="switch"
        aria-checked={on}
        aria-label={t("Send usage analytics")}
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

function LanguageRow() {
  const { locale, setLocale, t } = useI18n();
  return (
    <Card title={t("Language")} subtitle={t("Choose the language used by OpenMausBot.")}>
      <select
        value={locale}
        aria-label={t("Language")}
        onChange={(event) => setLocale(event.target.value as LocaleId)}
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink focus:border-hairline focus:outline-none"
      >
        {LOCALES.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
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
  const { t } = useI18n();
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const exportDiagnostics = async () => {
    if (!window.ogb?.exportDiagnostics || exporting) return;
    setExporting(true);
    setResult(null);
    try {
      const path = await window.ogb.exportDiagnostics();
      if (path) setResult({ kind: "success", message: t("Saved to {path}", { path }) });
    } catch (e) {
      setResult({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card
      title={t("Diagnostics")}
      subtitle={t("Versions, configuration on/off state and a redacted server log tail. Review the file before sharing it.")}
    >
      <div className="flex min-w-0 flex-col items-end gap-2">
        <button
          onClick={() => void exportDiagnostics()}
          disabled={exporting}
          aria-label={t("Export diagnostics to a text file")}
          className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
        >
          {exporting ? t("Exporting…") : t("Export Diagnostics…")}
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

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const { t } = useI18n();
  const section = state.appSettingsSection;
  const dialogRef = useRef<HTMLDivElement>(null);

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
            {t("Settings")}
          </div>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
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
              {t(label)}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-[15px] font-semibold text-ink">
              {t(SECTIONS.find((s) => s.id === section)?.label ?? "")}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label={t("Close settings")}
              className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {section === "general" && (
              <>
                <Card title={t("Profile")} subtitle={t("Shown in the sidebar. Saved as you go.")}>
                  <ProfileFields />
                </Card>
                <LanguageRow />
                <Card title={t("Skin")} subtitle={t("Applies instantly and is remembered on this machine.")}>
                  <SkinPicker />
                </Card>
                <Card title={t("Channel turns")} subtitle={t("Set one maximum duration for every bot turn in a channel.")}>
                  <RoomTurnTimeoutSettings />
                </Card>
                <UpdatesRow />
                <DiagnosticsRow />
                <AnalyticsRow />
              </>
            )}

            {section === "connections" && (
              <Card
                title={t("Connections")}
                subtitle={t("Connected apps work automatically in the installed app. Other optional service keys stay on this computer.")}
              >
                <div className="flex flex-col gap-4">
                  {state.config?.composio.mode === "managed" ? (
                    <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
                      {t("Connected apps service is ready")}
                    </div>
                  ) : null}
                  <ApiKeyRow section="box" />
                  <VpsConnection />
                  <ApiKeyRow section="opencodeGo" />
                  <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
                    <summary className="cursor-pointer text-[13px] text-ink-secondary">{t("Self-host connected apps")}</summary>
                    <div className="mt-3">
                      <ApiKeyRow section="composio" />
                    </div>
                  </details>
                </div>
              </Card>
            )}

            {section === "engines" && (
              <Card title={t("Engine CLIs")} subtitle={t("Which binary each engine runs. Saved as you go.")}>
                <EnginesSettings />
              </Card>
            )}

            {section === "companion" && <CompanionSection />}

            {section === "computer" && <LocalComputerSection />}

            {section === "usage" && <UsageSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
