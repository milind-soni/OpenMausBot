import { useEffect, useState } from "react";
import { Check, AlertTriangle, Copy, ExternalLink, Loader2, Mic, Minus, ShieldCheck } from "lucide-react";
import { MausAvatar } from "./Avatar";
import { setEmailGateDone, track } from "@/lib/analytics";
import {
  ONBOARDING_CONTINUE_WITHOUT_EMAIL,
  ONBOARDING_EMAIL_HELPER,
  ONBOARDING_ENGINES_TITLE,
  ONBOARDING_LOCAL_GUARANTEE,
  ONBOARDING_MIC_DETAIL,
  ONBOARDING_PERMISSIONS_SUBTITLE,
  ONBOARDING_PERMISSIONS_TITLE,
  ONBOARDING_WELCOME_SUBTITLE,
  ONBOARDING_WELCOME_TITLE,
  describeOnboardingEngine,
  isValidOnboardingEmail,
  onboardingEnginesSubtitle,
  resolveOnboardingProfile,
  type OnboardingInstanceRow,
} from "@/lib/onboardingCopy";

// Three-step first-run onboarding: who you are (local profile + optional email),
// what's installed (live AI app checks from the harness), what the app may use (TCC).
// Every check is skippable — onboarding must never brick the app.

const isElectron = navigator.userAgent.includes("Electron");

// The engines live wherever the harness runs; only Electron knows the host OS.
const hostLabel =
  window.gbs?.platform === "darwin" ? "this Mac" : window.gbs?.platform === "win32" ? "this PC" : "this computer";

function InstallHelp({ command, docsUrl }: { command?: string; docsUrl?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyCommand = () => {
    if (!command) return;
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        {docsUrl && (
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
          >
            Setup guide <ExternalLink size={11} />
          </a>
        )}
        {command && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-ink-secondary hover:text-ink"
          >
            {open ? "Hide command" : "Show command"}
          </button>
        )}
      </div>
      {open && command && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-inset px-2.5 py-1.5 font-mono text-[11.5px] text-ink">
          <code className="truncate">{command}</code>
          <button
            type="button"
            onClick={copyCommand}
            className="inline-flex shrink-0 items-center gap-1 rounded bg-raised px-2 py-0.5 font-sans text-[11px] text-ink-secondary hover:text-ink"
          >
            <Copy size={11} />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}

function StatusRow({
  ok,
  warn,
  title,
  detail,
  command,
  docsUrl,
}: {
  ok: boolean;
  warn?: boolean;
  title: string;
  detail: string;
  command?: string;
  docsUrl?: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-card p-3.5">
      <span
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
          ok ? "bg-[#00c97222] text-[#38d591]" : warn ? "bg-[#ff980022] text-[#ff9800]" : "bg-raised text-ink-secondary"
        }`}
      >
        {ok ? <Check size={14} /> : warn ? <AlertTriangle size={13} /> : <Minus size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-ink">{title}</div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{detail}</div>
        {(command || docsUrl) && <InstallHelp command={command} docsUrl={docsUrl} />}
      </div>
    </div>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [instances, setInstances] = useState<OnboardingInstanceRow[] | null>(null);
  const [perms, setPerms] = useState<{ mic: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const validEmail = isValidOnboardingEmail(email);
  const sanitizedLocalName = name.trim().replace(/\s+/g, " ");
  const validLocalName = sanitizedLocalName.length > 0;

  const saveProfile = (includeEmail = true) => {
    setIsSubmitting(true);
    const profile = resolveOnboardingProfile({ name, email, includeEmail });
    track("profile_saved", { hasEmail: Boolean(profile.email) });
    setEmailGateDone("submitted");
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile }),
    })
      .catch(() => {})
      .finally(() => {
        setIsSubmitting(false);
        setStep(1);
      });
  };

  const skipAll = () => {
    track("email_skipped");
    setEmailGateDone("skipped");
    onDone();
  };

  useEffect(() => {
    track("onboarding_step", { step });
    if (step === 1 && !instances) {
      fetch("/api/instances")
        .then((r) => r.json())
        .then((d) => setInstances(d.instances ?? []))
        .catch(() => setInstances([]));
    }
    if (step === 2 && isElectron) {
      const poll = () => window.gbs?.permStatus?.().then(setPerms).catch(() => {});
      poll();
      const t = setInterval(poll, 2000);
      return () => clearInterval(t);
    }
  }, [step, instances]);

  const finish = () => {
    track("onboarding_completed", {
      engines_available: instances?.filter((i) => i.snapshot.state === "available").length ?? -1,
      mic: perms?.mic ?? "n/a",
    });
    setEmailGateDone("submitted");
    onDone();
  };

  const byKind = (kind: string) => instances?.find((i) => i.driverKind === kind);
  const noEngines = !!instances && !instances.some((i) => i.snapshot.state === "available");
  const engineRows = instances
    ? (["claudeAgent", "codex", "grokAgent", "antigravityAgent"] as const).map((kind) =>
        describeOnboardingEngine(kind, byKind(kind), noEngines),
      )
    : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app p-4">
      <div className="flex w-full max-w-[460px] flex-col rounded-2xl border border-hairline/40 bg-panel p-8">
        {step === 0 && (
          <div className="flex flex-col items-center">
            <MausAvatar color="green" state="happy" size={72} />
            <h1 className="mt-4 text-center text-[20px] font-semibold text-ink">
              {ONBOARDING_WELCOME_TITLE}
            </h1>
            <p className="mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary">
              {ONBOARDING_WELCOME_SUBTITLE}
            </p>

            <div className="mt-4 flex w-full items-center gap-2 rounded-xl border border-[#38d591]/25 bg-[#00c97212] px-3.5 py-2.5 text-[12.5px] text-ink">
              <ShieldCheck size={16} className="shrink-0 text-[#38d591]" />
              <span>{ONBOARDING_LOCAL_GUARANTEE}</span>
            </div>

            <div className="mt-4 w-full space-y-3">
              <label className="block">
                <span className="mb-1 block text-[12.5px] font-medium text-ink">Your name</span>
                <input
                  autoFocus
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (validEmail || validLocalName) && saveProfile(true)}
                  placeholder="e.g. Alex Doe"
                  className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[12.5px] font-medium text-ink">
                  Email <span className="font-normal text-ink-secondary">(optional)</span>
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (validEmail || validLocalName) && saveProfile(true)}
                  placeholder="you@example.com"
                  className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                />
                <span className="mt-1 block text-[11.5px] text-ink-secondary">
                  {ONBOARDING_EMAIL_HELPER}
                </span>
              </label>
            </div>

            <button
              onClick={() => saveProfile(true)}
              disabled={(!validEmail && !validLocalName) || isSubmitting}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Saving…
                </>
              ) : (
                "Continue"
              )}
            </button>

            <button
              type="button"
              onClick={() => saveProfile(false)}
              disabled={isSubmitting}
              className="mt-2.5 w-full rounded-lg border border-hairline/50 bg-card py-2 text-[13.5px] font-medium text-ink-secondary transition-colors hover:border-hairline hover:bg-raised hover:text-ink disabled:opacity-40"
            >
              {ONBOARDING_CONTINUE_WITHOUT_EMAIL}
            </button>

            <button
              onClick={skipAll}
              className="mt-3 text-[12px] text-ink-secondary hover:text-ink"
            >
              Skip for now
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col">
            <h1 className="text-[18px] font-semibold text-ink">{ONBOARDING_ENGINES_TITLE}</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">
              {onboardingEnginesSubtitle(hostLabel)}
            </p>
            <div className="mt-4 flex flex-col gap-2.5">
              {!instances ? (
                <div className="flex items-center gap-2 py-6 text-ink-secondary">
                  <Loader2 size={16} className="animate-spin" /> Checking…
                </div>
              ) : (
                engineRows.map((engine) => (
                  <StatusRow
                    key={engine.kind}
                    ok={engine.ok}
                    warn={engine.warn}
                    title={engine.title}
                    detail={engine.detail}
                    command={engine.command}
                    docsUrl={engine.docsUrl}
                  />
                ))
              )}
            </div>
            <button
              onClick={() => (isElectron ? setStep(2) : finish())}
              className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
            >
              Continue
            </button>
            <button onClick={finish} className="mt-3 text-[12px] text-ink-secondary hover:text-ink">
              Skip for now
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col">
            <h1 className="text-[18px] font-semibold text-ink">{ONBOARDING_PERMISSIONS_TITLE}</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">
              {ONBOARDING_PERMISSIONS_SUBTITLE}
            </p>
            <div className="mt-4 flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3 rounded-xl bg-card p-3.5">
                <div className="flex items-start gap-3">
                  <Mic size={18} className="mt-0.5 shrink-0 text-ink-secondary" />
                  <div>
                    <div className="text-[14px] font-medium text-ink">Microphone & speech</div>
                    <div className="mt-0.5 text-[12.5px] text-ink-secondary">
                      {ONBOARDING_MIC_DETAIL}
                    </div>
                  </div>
                </div>
                {perms?.mic === "granted" ? (
                  <Check size={16} className="shrink-0 text-[#38d591]" />
                ) : perms?.mic === "denied" || perms?.mic === "restricted" ? (
                  <button
                    onClick={() => window.gbs?.permOpenSettings?.("mic")}
                    className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                  >
                    Open Settings
                  </button>
                ) : (
                  <button
                    onClick={() =>
                      window.gbs?.permRequestMic?.().then(() => window.gbs?.permStatus?.().then(setPerms))
                    }
                    className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                  >
                    Enable
                  </button>
                )}
              </div>
              {/* Screen Recording deliberately has no row here: macOS 15+
                  makes a pre-grant unreliable (per-process status caching,
                  helper misattribution, periodic re-prompts) — the OS flow
                  triggers on the first real capture in the Computer panel,
                  which is the moment the user has context for the dialog. */}
            </div>
            <button
              onClick={finish}
              className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
            >
              Start using Gerer Build Studio
            </button>
            <button onClick={finish} className="mt-3 text-[12px] text-ink-secondary hover:text-ink">
              Skip for now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
