import { useEffect, useRef, useState } from "react";

import { defaultDeviceLabel, peekMagicLink, reasonWorthShowing, startMagicLink, verifyMagicLink } from "../lib/session";
import { recordNewRegistration } from "../lib/ad-measurement";
import { AdMeasurementPreference } from "../components/AdMeasurementPreference";

const MARK_SRC = `${import.meta.env.BASE_URL}nation-mark.png`;
const RESEND_AFTER_MS = 30_000;

const field = "mt-1.5 w-full rounded-lg border border-white/15 bg-white/[0.04] px-3.5 py-2.5 text-[15px] text-white outline-none placeholder:text-white/35 focus:border-nation";
const primary = "mt-5 w-full rounded-lg bg-nation px-4 py-2.5 text-[15px] font-semibold text-nation-ink transition-opacity disabled:opacity-50";
const quiet = "mt-3 w-full text-[13px] text-white/60 underline decoration-white/25 underline-offset-2 hover:text-white";

/** Product context for a first visit; examples are briefs, never fabricated
 * agent results. Keep this outside the email-link confirmation flow. */
function SignupOverview() {
  return (
    <section aria-labelledby="swarm-intro" className="min-w-0">
      <div className="flex items-center gap-3">
        <img src={MARK_SRC} alt="" width={44} height={44} className="size-11 rounded-xl" />
        <p className="text-[14px] font-semibold tracking-[0.18em] text-nation">NATION SWARM</p>
      </div>
      <h1 id="swarm-intro" className="mt-8 max-w-[650px] text-[40px] font-bold leading-[1.06] tracking-[-0.04em] sm:text-[60px]">
        One brief.<br /><span className="text-nation">Your AI team.</span>
      </h1>
      <p className="mt-5 max-w-[520px] text-[17px] leading-relaxed text-white/75">
        Research crypto projects, create content and build with AI teammates in your own workspace.
      </p>
    </section>
  );
}

const EXAMPLE_BRIEFS = [
  { face: "researcher", title: "Research", brief: "Compare three crypto projects. Include sources and risks." },
  { face: "creator", title: "Create", brief: "Turn my project brief into a week of launch content." },
  { face: "builder", title: "Build", brief: "Help me build a landing page for my next idea." },
];

function SignupExamples() {
  return (
    <section aria-label="Example briefs to try" className="min-w-0 lg:col-start-1 lg:row-start-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">Example briefs to try</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {EXAMPLE_BRIEFS.map((example) => (
          <article key={example.face} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.025] p-4 sm:block">
            <img src={`${import.meta.env.BASE_URL}bot-faces/${example.face}.png`} alt="" width={72} height={72} className="size-14 shrink-0 object-contain sm:size-[72px]" />
            <div>
              <h2 className="text-[15px] font-semibold sm:mt-3">{example.title}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-white/65">{example.brief}</p>
            </div>
          </article>
        ))}
      </div>
      <p className="mt-5 text-[12px] leading-relaxed text-white/45">You set the goal and review the work.</p>
    </section>
  );
}

type Step =
  | { kind: "email" }
  | { kind: "sent"; email: string; at: number }
  | { kind: "checking" }
  | { kind: "confirm"; email: string }
  | { kind: "signing-in"; email: string };

/** Sign in to Nation Team Chat with an emailed link. The same link creates a
 * workspace on first use. A link opens the app at `#login=…`; this page asks
 * before using it, so a mail scanner that opens links cannot spend it. */
export function LoginPage({ initialToken = null, reason }: { initialToken?: string | null; reason?: string }) {
  const [step, setStep] = useState<Step>(initialToken ? { kind: "checking" } : { kind: "email" });
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const token = useRef(initialToken);

  useEffect(() => {
    if (!initialToken) return;
    let active = true;
    void peekMagicLink(initialToken).then((result) => {
      if (!active) return;
      if (result.ok) setStep({ kind: "confirm", email: result.email });
      else {
        token.current = null;
        setError(result.error);
        setStep({ kind: "email" });
      }
    });
    return () => { active = false; };
  }, [initialToken]);

  useEffect(() => {
    if (step.kind !== "sent") return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [step.kind]);

  async function send(address: string) {
    setBusy(true);
    setError(null);
    const result = await startMagicLink(address);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNow(Date.now());
    setStep({ kind: "sent", email: address.trim().toLowerCase(), at: Date.now() });
  }

  async function confirm(address: string) {
    if (!token.current) return;
    setStep({ kind: "signing-in", email: address });
    setError(null);
    const result = await verifyMagicLink({ token: token.current, label: defaultDeviceLabel() });
    if (result.ok) {
      recordNewRegistration(result.created);
      location.replace(import.meta.env.BASE_URL);
      return;
    }
    token.current = null;
    setError(result.error);
    setStep({ kind: "email" });
  }

  const shownReason = step.kind === "email" && !error ? reasonWorthShowing(reason) : null;
  const waitMs = step.kind === "sent" ? Math.max(0, step.at + RESEND_AFTER_MS - now) : 0;
  const showOverview = step.kind === "email" && !initialToken && !reasonWorthShowing(reason);

  return (
    <main className="flex min-h-screen items-center justify-center bg-nation-ink px-5 py-10 text-white sm:px-8 sm:py-16">
      <div className={showOverview ? "grid w-full max-w-[1120px] items-start gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-x-16" : "w-full max-w-[400px]"}>
      {showOverview ? <SignupOverview /> : null}
      <div className={showOverview ? "w-full min-w-0 rounded-3xl border border-white/10 bg-white/[0.025] p-6 sm:p-8 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-center" : "w-full"} data-testid="nation-login">
        {!showOverview ? <img src={MARK_SRC} alt="NATION" width={48} height={48} className="size-12 rounded-xl" /> : null}
        {step.kind === "checking" ? (
          <p className="mt-8 text-[15px] text-white/70" aria-live="polite">Checking your sign-in link…</p>
        ) : step.kind === "confirm" || step.kind === "signing-in" ? (
          <>
            <h1 className="mt-8 text-[26px] font-bold leading-tight tracking-tight">Sign in to Nation Team Chat</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-white/70">
              Continue as <span className="font-semibold text-white">{step.email}</span>.
            </p>
            <button type="button" className={primary} disabled={step.kind === "signing-in"} onClick={() => void confirm(step.email)}>
              {step.kind === "signing-in" ? "Signing in…" : "Continue"}
            </button>
            <button type="button" className={quiet} onClick={() => { token.current = null; setStep({ kind: "email" }); }}>
              Not you? Use another email
            </button>
          </>
        ) : step.kind === "sent" ? (
          <>
            <h1 className="mt-8 text-[26px] font-bold leading-tight tracking-tight">Check your email</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-white/70" aria-live="polite">
              We sent a sign-in link to <span className="font-semibold text-white">{step.email}</span>. Open it on this device. It works once and expires soon.
            </p>
            {error ? <p className="mt-4 text-[13.5px] text-[#ff8a95]" role="alert">{error}</p> : null}
            <button type="button" className={primary} disabled={busy || waitMs > 0} onClick={() => void send(step.email)}>
              {busy ? "Sending…" : waitMs > 0 ? `Send another link in ${Math.ceil(waitMs / 1000)}s` : "Send another link"}
            </button>
            <button type="button" className={quiet} onClick={() => { setError(null); setStep({ kind: "email" }); }}>
              Use a different email
            </button>
          </>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void send(email); }}>
            {showOverview ? <h2 className="text-[26px] font-bold leading-tight tracking-tight">Start your team</h2> : <h1 className="mt-8 text-[26px] font-bold leading-tight tracking-tight">Sign in to Nation Team Chat</h1>}
            <p className="mt-2 text-[15px] leading-relaxed text-white/70">
              Create your workspace or sign in with an email link. No password to remember.
            </p>
            <p className="mt-3 text-[13px] leading-relaxed text-nation">Starter credit for eligible new accounts.</p>
            {shownReason ? <p className="mt-4 text-[13.5px] text-white/70">{shownReason}</p> : null}
            <label className="mt-6 block text-[13px] font-medium text-white/80" htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              autoFocus={!showOverview}
              className={field}
            />
            {error ? <p className="mt-3 text-[13.5px] text-[#ff8a95]" role="alert">{error}</p> : null}
            <button type="submit" className={primary} disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())}>
              {busy ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
        )}
        <p className="mt-8 text-center text-[12.5px] text-white/50">
          Need help?{" "}
          <a href="https://t.me/thenation_city" target="_blank" rel="noopener noreferrer" className="text-nation underline decoration-nation/40 underline-offset-2">
            Message us on Telegram
          </a>
        </p>
        <AdMeasurementPreference />
      </div>
      {showOverview ? <SignupExamples /> : null}
      </div>
    </main>
  );
}
