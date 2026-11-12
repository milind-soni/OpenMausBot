import { useEffect, useState } from "react";
import { Check, AlertTriangle, Loader2, Mic, Minus } from "lucide-react";
import { MausAvatar } from "./Avatar";
import { setEmailGateDone, track } from "@/lib/analytics";

// Three-step first-run onboarding: who you are (email), what's installed
// (live engine checks from the harness), what the app may use (TCC).
// Every check is skippable — onboarding must never brick the app.

type InstanceRow = {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: { state: "available" | "unavailable"; reason?: string; version?: string | null; authenticated?: boolean };
};

const isElectron = navigator.userAgent.includes("Electron");

// The engines live wherever the harness runs; only Electron knows the host OS.
const hostLabel =
  window.gbs?.platform === "darwin" ? "this Mac" : window.gbs?.platform === "win32" ? "this PC" : "this computer";

function StatusRow({
  ok,
  warn,
  title,
  detail,
}: {
  ok: boolean;
  warn?: boolean;
  title: string;
  detail: string;
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
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-ink">{title}</div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{detail}</div>
      </div>
    </div>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [instances, setInstances] = useState<InstanceRow[] | null>(null);
  const [perms, setPerms] = useState<{ mic: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const sanitizedLocalName = name.trim().replace(/\s+/g, " ");
  const validLocalName = sanitizedLocalName.length > 0;

  const saveProfile = (_mode: "auth" | "local" = "local") => {
    setIsSubmitting(true);
    track("profile_saved", { hasEmail: validEmail });
    setEmailGateDone("submitted");
    const cleanName = sanitizedLocalName || (validEmail ? email.trim().split("@")[0]! : "User");
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: {
          name: cleanName,
          email: validEmail ? email.trim().toLowerCase() : "",
        },
      }),
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
  const claude = byKind("claudeAgent");
  const codex = byKind("codex");
  const grok = byKind("grokAgent");
  const antigravity = byKind("antigravityAgent");
  const isAvailable = (row?: InstanceRow) => row?.snapshot.state === "available";
  // Signed in, or an engine that doesn't report sign-in state.
  const isReady = (row?: InstanceRow) => isAvailable(row) && row?.snapshot.authenticated !== false;
  // Warn only when something needs the user's action: an engine is installed but
  // signed out, or nothing at all is installed (Claude Code is the suggested start).
  const needsSignIn = (row?: InstanceRow) => isAvailable(row) && row?.snapshot.authenticated === false;
  const noEngines = !!instances && !instances.some((i) => i.snapshot.state === "available");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app">
      <div className="flex w-[460px] flex-col rounded-2xl border border-hairline/40 bg-panel p-8">
        {step === 0 && (
          <div className="flex flex-col items-center">
            <MausAvatar color="green" state="happy" size={72} />
            <h1 className="mt-4 text-[20px] font-semibold text-ink">Welcome to Gerer Build Studio</h1>
            <p className="mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary">
              Bots that do real work on their own computer. Tell us who you are
              and we&rsquo;ll let you know when big things ship.
            </p>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="mt-5 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (validEmail || validLocalName) && saveProfile("local")}
              placeholder="you@example.com"
              className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <button
              onClick={() => saveProfile("local")}
              disabled={(!validEmail && !validLocalName) || isSubmitting}
              className="mt-5 flex items-center justify-center gap-2 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white disabled:opacity-40 hover:brightness-110 transition-all"
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
              onClick={skipAll}
              className="mt-3 text-[12px] text-ink-secondary hover:text-ink"
            >
              Skip for now
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col">
            <h1 className="text-[18px] font-semibold text-ink">Your engines</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">
              Bots run on the AI tools already on {hostLabel} — here&rsquo;s what we found.
            </p>
            <div className="mt-4 flex flex-col gap-2.5">
              {!instances ? (
                <div className="flex items-center gap-2 py-6 text-ink-secondary">
                  <Loader2 size={16} className="animate-spin" /> Checking…
                </div>
              ) : (
                <>
                  <StatusRow
                    ok={isReady(claude)}
                    warn={needsSignIn(claude) || noEngines}
                    title={`Claude Code ${claude?.snapshot.version ? `· ${claude.snapshot.version.split(" ")[0]}` : ""}`}
                    detail={
                      claude?.snapshot.state === "available"
                        ? claude.snapshot.authenticated
                          ? "Installed and signed in — ready to power bots."
                          : "Installed. Run `claude` once in a terminal to sign in."
                        : "Not found. Install: npm i -g @anthropic-ai/claude-code"
                    }
                  />
                  <StatusRow
                    ok={isReady(codex)}
                    warn={needsSignIn(codex)}
                    title={`Codex ${codex?.snapshot.version ? `· ${codex.snapshot.version.replace("codex-cli ", "")}` : ""}`}
                    detail={
                      codex?.snapshot.state === "available"
                        ? "Installed — bots can run on Codex too."
                        : "Optional. Install: npm i -g @openai/codex"
                    }
                  />
                  <StatusRow
                    ok={isReady(grok)}
                    warn={needsSignIn(grok)}
                    title={`Grok Build ${grok?.snapshot.version ? `· ${grok.snapshot.version.split(" ")[1]}` : ""}`}
                    detail={
                      grok?.snapshot.state === "available"
                        ? grok.snapshot.authenticated
                          ? "Installed and signed in — bots can run on Grok too."
                          : "Installed. Run `grok login` in a terminal to sign in."
                        : "Optional. Install: curl -fsSL https://x.ai/cli/install.sh | bash"
                    }
                  />
                  <StatusRow
                    ok={isReady(antigravity)}
                    warn={needsSignIn(antigravity)}
                    title={`Antigravity ${antigravity?.snapshot.version ? `· ${antigravity.snapshot.version.split(" ")[0]}` : ""}`}
                    detail={
                      antigravity?.snapshot.state === "available"
                        ? "Installed — bots can run on Antigravity too."
                        : "Optional. Install: see antigravity.google/docs/cli"
                    }
                  />
                </>
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
            <h1 className="text-[18px] font-semibold text-ink">Permissions</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">
              Optional, and only ever used when you ask for the feature.
            </p>
            <div className="mt-4 flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3 rounded-xl bg-card p-3.5">
                <div className="flex items-start gap-3">
                  <Mic size={18} className="mt-0.5 shrink-0 text-ink-secondary" />
                  <div>
                    <div className="text-[14px] font-medium text-ink">Microphone & speech</div>
                    <div className="mt-0.5 text-[12.5px] text-ink-secondary">
                      Voice dictation into the composer, transcribed on-device.
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
            <button onClick={finish} className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white">
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
