import { useEffect, useState } from "react";
import { DesktopWorkspaceSwitcher } from "../components/DesktopWorkspaceSwitcher";
import { productName } from "../lib/brand";

import {
  defaultDeviceLabel,
  isConnected,
  newAttemptId,
  pairWithCode,
  readSessionState,
  reasonWorthShowing,
  rememberedTeamSignIn,
  startEmailSignIn,
  verifyEmailSignIn,
  type EnvironmentDescriptor,
  type SessionState,
} from "../lib/session";
import { pairedDestination } from "../lib/phone-pairing";
import { t } from "../lib/i18n";
import { formatPairingCode, PAIRING_INPUT_PROBLEM_KEY, readPairingInput } from "../../shared/pairing-code";
import { isPrivateHost } from "../../shared/private-host";

const input = "mt-1 w-full rounded-md border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent-border";
const button = "mt-5 w-full rounded-md bg-accent px-4 py-2 text-[14px] font-medium text-accent-ink disabled:opacity-50";
const fieldLabel = "mt-4 block text-[12px] font-medium text-ink-secondary";

/** Only the desktop app pairs from a link at once; a browser asks, so a sent link cannot sign it in unseen. */
export function pairsAutomatically(initialCode: string | null, desktop = typeof window !== "undefined" && Boolean(window.ogb?.workspaces)): boolean {
  return Boolean(initialCode) && desktop;
}

export function pairIntro({ mode, sent, email, cloudHome }: { mode: "email" | "code" | null; sent: boolean; email: string; cloudHome: boolean }): string {
  if (mode === "email") return sent ? t("pair.intro.emailSent", { email }) : t("pair.intro.email");
  if (cloudHome) return t("pair.intro.cloud", { app: productName(), open: t("cloudHome.connect"), section: t("settings.section.cloudAccount") });
  return t("pair.intro.code");
}

/** The sentence for a wrong kind of code (an email's sign-in code, an old six-digit code, a script key), else null. */
export function codeProblem(code: string): string | null {
  const read = readPairingInput(code);
  return read.kind === "wrong" && read.problem !== "notACode" ? t(PAIRING_INPUT_PROBLEM_KEY[read.problem]) : null;
}

export function codeReady(code: string): boolean {
  const kind = readPairingInput(code).kind;
  return kind === "code" || kind === "credential";
}

/** The phone app opens this server with the code already filled in. */
export function openInAppLink(origin: string, code: string): string {
  const read = readPairingInput(code);
  const filled = read.kind === "code" ? `&code=${encodeURIComponent(formatPairingCode(read.code))}` : "";
  return `openmausbot://pair?address=${encodeURIComponent(origin)}${filled}`;
}

/** Plain http to the open internet: the session cookie and every chat would cross it readable. */
export function unencryptedPublic(where: { protocol: string; hostname: string }): boolean {
  return where.protocol === "http:" && !isPrivateHost(where.hostname);
}

/** A team's Cloud: the person's team page on MausBot Cloud, as their signed-in session told this browser (never before
 * sign-in), where they open it again. Only an https page (or a loopback fixture's). */
export function teamPage(environment: EnvironmentDescriptor | null, remembered: string | null = rememberedTeamSignIn()): string | null {
  if (!environment?.capabilities.cloudTeam || typeof remembered !== "string") return null;
  try {
    const url = new URL(remembered);
    const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || loopback) && !url.username && !url.password && !url.hash ? url.href : null;
  } catch { return null; }
}

export function pairTitle(environment: EnvironmentDescriptor | null, mode: "email" | "code" | null): string {
  if (environment?.capabilities.cloudTeam) return environment.label;
  if (environment?.capabilities.cloudHome) return t("pair.myCloud");
  return t(mode === "email" ? "pair.signInTo" : "pair.connectTo", { name: environment?.label ?? t("pair.thisOpenMausBot", { app: productName() }) });
}

export function PairPage({ initialCode, initialEmail = null, reason }: { initialCode: string | null; initialEmail?: string | null; reason?: string }) {
  const [code, setCode] = useState(initialCode ?? "");
  const [label, setLabel] = useState(defaultDeviceLabel());
  const [environment, setEnvironment] = useState<EnvironmentDescriptor | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState(() => newAttemptId());
  const [mode, setMode] = useState<"email" | "code">(initialEmail && !initialCode ? "email" : "code");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [opening, setOpening] = useState(() => pairsAutomatically(initialCode));

  useEffect(() => {
    if (!opening || !initialCode) return;
    let active = true;
    void pairWithCode({ code: initialCode, label, attemptId }).then((result) => {
      if (!active) return;
      if (result.ok) { location.replace(pairedDestination(location.search)); return; }
      setOpening(false);
      setError(result.error);
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void fetch("/.well-known/openmausbot/environment")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: EnvironmentDescriptor | null) => {
        setEnvironment(d);
      })
      .catch(() => {
        setEnvironment(null);
      });
    void readSessionState().then(setSession);
  }, []);

  const connected = isConnected(session);
  const emailOffered = environment?.capabilities.emailSignIn === true;
  const cloudHome = environment?.capabilities.cloudHome === true;
  const ownServer = !cloudHome && environment?.capabilities.cloudTeam !== true;
  const problem = codeProblem(code);
  const where = typeof location !== "undefined" && typeof location.protocol === "string" ? location : null;

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await pairWithCode({ code, label, attemptId });
    setBusy(false);
    if (result.ok) {
      location.replace(pairedDestination(location.search));
      return;
    }
    setError(result.error);
  }

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = sent ? await verifyEmailSignIn({ email, code: otp, label }) : await startEmailSignIn(email);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (sent) {
      location.replace(pairedDestination(location.search));
      return;
    }
    setSent(true);
  }

  function switchMode(next: "email" | "code") {
    setMode(next);
    setError(null);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-app px-6 text-ink">
      <div className="absolute left-3 top-12 max-w-[280px]"><DesktopWorkspaceSwitcher /></div>
      <div className="w-full max-w-[420px]">
        {where && unencryptedPublic(where) ? <p role="alert" className="mb-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[13px] text-warning">{t("pair.notEncrypted")}</p> : null}
        {opening ? (
          <p role="status" className="text-[20px] font-semibold">{cloudHome ? t("pair.openingCloud") : t("pair.connectingTo", { name: environment?.label ?? t("pair.thisOpenMausBot") })}</p>
        ) : <>
        <h1 className="text-[20px] font-semibold">{pairTitle(environment, mode)}</h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-secondary">
          {environment && !cloudHome ? `${t("pair.version", { version: environment.version, platform: environment.platform })} ` : ""}
          {pairIntro({ mode, sent, email, cloudHome })}
        </p>
        {reasonWorthShowing(reason) && !connected ? <p className="mt-3 text-[13px] text-ink-secondary">{reasonWorthShowing(reason)}</p> : null}
        {error && cloudHome && initialCode ? <p className="mt-3 text-[13px] text-ink-secondary">{t("pair.expired", { app: productName(), open: t("cloudHome.connect"), section: t("settings.section.cloudAccount") })}</p> : null}
        {!connected && teamPage(environment) ? <div data-team-sign-in className="mt-4 flex flex-col items-start gap-1.5">
          <a href={teamPage(environment)!} className="rounded-md bg-accent px-4 py-2 text-[14px] font-medium text-accent-ink">{t("pair.team.open", { team: environment!.label })}</a>
          <p className="text-[13px] text-ink-secondary">{t("pair.team.openHint")}</p>
        </div> : null}
        </>}
        {opening ? null : connected ? (
          <p className="mt-4 text-[14px]">
            {t("pair.alreadyConnected")}{" "}
            <a href="/" className="text-accent underline">
              {t("pair.openApp")}
            </a>
          </p>
        ) : mode === "email" ? (
          <form onSubmit={submitEmail}>
            <label className={fieldLabel} htmlFor="signin-email">
              {t("cloudBuy.signIn.email")}
            </label>
            <input
              id="signin-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setSent(false);
                setOtp("");
              }}
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              className={input}
            />
            {sent ? (
              <>
                <label className={fieldLabel} htmlFor="signin-code">
                  {t("pair.emailCode")}
                </label>
                <input
                  id="signin-code"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  placeholder="12345678"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  spellCheck={false}
                  className={`${input} font-mono text-[15px] tracking-[0.12em]`}
                />
                <label className={fieldLabel} htmlFor="signin-label">
                  {t("pair.deviceLabel")}
                </label>
                <input id="signin-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} className={input} />
              </>
            ) : null}
            {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
            <button type="submit" disabled={busy || !email.includes("@") || (sent && otp.replace(/\D/g, "").length < 8)} className={button}>
              {t(busy ? (sent ? "pair.signingIn" : "pair.sending") : sent ? "pair.signIn" : "cloudBuy.signIn.send")}
            </button>
            {sent ? (
              <button type="button" onClick={() => setSent(false)} className="mt-3 w-full text-[13px] text-ink-secondary underline">
                {t("pair.resend")}
              </button>
            ) : null}
            <button type="button" onClick={() => switchMode("code")} className="mt-3 w-full text-[13px] text-ink-secondary underline">
              {t("pair.useCode")}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <label className={fieldLabel} htmlFor="pair-code">
              {t("pair.code")}
            </label>
            <input
              id="pair-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setAttemptId(newAttemptId());
              }}
              placeholder="XXXX-XXXX-XXXX"
              aria-describedby={initialCode && code === initialCode ? "pair-code-from-link" : undefined}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              className={`${input} font-mono text-[15px] tracking-[0.12em]`}
            />
            {initialCode && code === initialCode ? <p id="pair-code-from-link" className="mt-1 text-[12px] text-ink-secondary">{t("pair.fromLink")}</p> : null}
            <label className={fieldLabel} htmlFor="pair-label">
              {t("pair.deviceLabel")}
            </label>
            <input id="pair-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} className={input} />
            {problem ? <p role="alert" className="mt-3 text-[13px] text-danger">{problem}</p> : error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
            <button type="submit" disabled={busy || !codeReady(code)} className={button}>
              {t(busy ? "pair.connecting" : "pair.connect")}
            </button>
            {where?.origin ? (
              <p className="mt-3 text-[13px] text-ink-secondary">
                {t("pair.onPhone")}{" "}
                <a href={openInAppLink(where.origin, code)} className="text-accent underline">{t("pair.openInApp", { app: productName() })}</a>
              </p>
            ) : null}
            {ownServer ? (
              <p className="mt-3 text-[13px] text-ink-secondary">
                {t("pair.noCode")} <code className="select-all rounded bg-inset px-1.5 py-0.5 text-[12px] text-ink">npx openmausbot pair</code>
              </p>
            ) : null}
            {emailOffered ? (
              <p className="mt-5 border-t border-hairline/40 pt-4 text-[13px] text-ink-secondary">
                {t("pair.invitedByEmail")}{" "}
                <button type="button" onClick={() => switchMode("email")} className="text-accent underline">
                  {t("pair.useEmail")}
                </button>
              </p>
            ) : null}
          </form>
        )}
      </div>
    </main>
  );
}
