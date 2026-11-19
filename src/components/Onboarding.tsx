import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, ExternalLink, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { MausAvatar } from "./Avatar";
import { setEmailGateDone, track } from "@/lib/analytics";
import { describeOnboardingEngine, isValidOnboardingEmail, ONBOARDING_EMAIL_HELPER, ONBOARDING_LOCAL_GUARANTEE, resolveOnboardingProfile, type OnboardingEngineKind, type OnboardingInstanceRow } from "@/lib/onboardingCopy";
import { proposeTeam, purposes, type ProposedBuddy, type Purpose } from "@/lib/workspaceOnboarding";
import { api, useStore, type AppState } from "@/state/store";

const inputClass = "w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 text-[14px] text-ink focus-visible:outline-2 focus-visible:outline-accent";
const buttonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-[14px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-45";
const primary = `${buttonClass} bg-accent text-white hover:brightness-110`;
const secondary = `${buttonClass} bg-card text-ink hover:bg-raised`;

const steps = ["Welcome", "Personal details", "AI engines", "Workspace purpose", "Review your team"];
type Engine = OnboardingInstanceRow & {
  models?: { default: string; options: Array<{ id: string; label: string }> };
};
type Draft = { step: number; name: string; email: string; focus: Purpose[]; custom: string; team: ProposedBuddy[]; edited: boolean };
const initialDraft: Draft = { step: 0, name: "", email: "", focus: [], custom: "", team: [], edited: false };
function loadDraft(key: string, profile: { name: string; email: string }): Draft {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return { ...initialDraft, ...JSON.parse(stored) };
  } catch {}
  return { ...initialDraft, ...profile, step: profile.name ? 2 : 0 };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1.5 text-sm font-medium text-ink"><span>{label}</span>{children}</label>;
}

const featuredEngines = ["claudeAgent", "codex", "grokAgent", "antigravityAgent"] as const;
function EngineCard({ engine }: { engine: Engine }) {
  const known = featuredEngines.find((kind) => kind === engine.driverKind);
  const help = known ? describeOnboardingEngine(known as OnboardingEngineKind, engine, false) : undefined;
  const { state, reason, authenticated, version, subscriptionPlan } = engine.snapshot;
  const ready = state === "available" && authenticated === true;
  const installation = state === "available" ? "Detected" : /CLI not found/i.test(reason ?? "") ? "CLI not detected" : "Unknown";
  const signIn = authenticated === true ? "Detected" : authenticated === false ? "Required" : "Unknown";
  const readiness = ready ? "Ready" : state === "unavailable" ? "Unavailable" : authenticated === false ? "Sign-in required" : "Unverified";
  return (
    <article className="rounded-xl border border-hairline/40 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-semibold text-ink">{help?.title ?? engine.displayName}</h3>
        <span className={ready ? "text-sm text-success" : "text-sm text-ink-secondary"}>{readiness}</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-ink-secondary sm:grid-cols-3">
        <div><dt>Installation</dt><dd className="mt-0.5 text-ink">{installation}{!help && version ? ` · ${version}` : ""}</dd></div>
        <div><dt>Sign-in</dt><dd className="mt-0.5 text-ink">{signIn}</dd></div>
        <div><dt>Subscription plan</dt><dd className="mt-0.5 text-ink first-letter:uppercase">{subscriptionPlan ?? "Unavailable from engine"}</dd></div>
      </dl>
      {help?.docsUrl && <a className="mt-3 inline-flex items-center gap-1 text-xs text-accent hover:underline" href={help.docsUrl} target="_blank" rel="noreferrer">Setup guide <ExternalLink size={12} /></a>}
      {help?.command && <details className="mt-2 text-xs text-ink-secondary">
        <summary className="cursor-pointer">{state === "available" ? "Open the engine" : "Installation command"}</summary>
        <code className="mt-1 block select-all break-all rounded bg-inset p-2 text-ink">{help.command}</code>
      </details>}
    </article>
  );
}

export function Onboarding({ id, profile, onDone }: { id: string; profile: { name: string; email: string }; onDone: () => void }) {
  const key = `gbs-alpha-onboarding:${id}`;
  const [draft, setDraft] = useState(() => loadDraft(key, profile));
  const { step, name, email, focus, custom, team, edited } = draft;
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const [engines, setEngines] = useState<Engine[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const { dispatch } = useStore();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(draft)); } catch {}
  }, [draft, key]);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    track("onboarding_step", { step });
  }, [step]);

  async function checkEngines(refresh = false) {
    setChecking(true);
    setCheckError(false);
    try {
      const response = await api(`/api/instances?setup=1${refresh ? "&refresh=1" : ""}`, { signal: AbortSignal.timeout(15_000) });
      setEngines(response.instances);
    } catch {
      setCheckError(true);
    } finally {
      setChecking(false);
    }
  }
  const engineStepReached = step >= 2;
  useEffect(() => { if (engineStepReached) void checkEngines(); }, [engineStepReached]);

  const options = (engines ?? []).flatMap((engine) => {
    if (engine.snapshot.state !== "available" || engine.snapshot.authenticated === false) return [];
    return (engine.models?.options ?? []).map((model) => ({
      value: JSON.stringify([engine.instanceId, model.id]),
      selection: { instanceId: engine.instanceId, model: model.id },
      label: `${engine.displayName} · ${model.label}${engine.snapshot.authenticated === undefined ? " (sign-in unverified)" : ""}`,
      recommended: engine.snapshot.authenticated === true && model.id === engine.models?.default,
    }));
  });
  const preferredModel = options.find((item) => item.recommended)?.selection ?? null;
  const previous = () => {
    setError("");
    setRegenerating(false);
    update({ step: step - 1 });
  };

  async function saveProfile() {
    if (saving) return;
    const profile = resolveOnboardingProfile({ name, email, includeEmail: true });
    setSaving(true);
    setError("");
    try {
      const config = await api("/api/config", { method: "PUT", body: JSON.stringify({ profile }), signal: AbortSignal.timeout(12_000) });
      dispatch({ type: "configStatus", config });
      track("profile_saved", { hasEmail: Boolean(profile.email) });
      update({ ...profile, step: 2 });
    } catch {
      setError("Studio couldn’t save your details. Your entries are still here. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function generate() {
    update({ team: proposeTeam(focus, custom, preferredModel), edited: false, step: 4 });
    setRegenerating(false);
  }

  function patchBuddy(id: string, patch: Partial<ProposedBuddy>) {
    update({ edited: true, team: team.map((buddy) => buddy.id === id ? { ...buddy, ...patch } : buddy) });
  }

  async function approve() {
    if (saving) return;
    setError("");
    setSaving(true);
    try {
      await api("/api/onboarding/team", {
        method: "POST",
        body: JSON.stringify({ id, purposes: focus, customGoal: custom, team }),
        signal: AbortSignal.timeout(20_000),
      });
      const { bots, groups }: Pick<AppState, "bots" | "groups"> = await api("/api/bots");
      dispatch({ type: "hydrate", bots, groups });
      const lead = bots.find((buddy) => buddy.id === `${id}-0`) ?? bots.find((buddy) => !buddy.hidden);
      if (lead) dispatch({ type: "select", id: lead.id });
      track("onboarding_completed");
      setEmailGateDone("submitted");
      try { localStorage.removeItem(key); } catch {}
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Studio couldn’t save your team. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const profileValid = Boolean(name.trim()) && (!email.trim() || isValidOnboardingEmail(email));
  function changePurpose(purpose: Purpose) {
    update({ focus: focus.includes(purpose) ? focus.filter((value) => value !== purpose) : [...focus, purpose] });
  }
  const purposeValid = focus.length > 0 && (!focus.includes("Custom") || Boolean(custom.trim()));
  const teamValid = team.length > 0 && team.every((buddy) => buddy.name.trim() && buddy.title.trim() && buddy.description.trim())
    && new Set(team.map((buddy) => buddy.name.trim().toLowerCase())).size === team.length;
  const titles = ["Gérer Build Studio (v0.1 Alpha)", "Tell us about yourself", `Hi, ${name}. Let’s set up your AI engines.`, "What will you use Studio for?", "Review your team"];
  const subtitles = [
    "Bring AI Buddies together to plan, build, and review work in one workspace.",
    ONBOARDING_LOCAL_GUARANTEE,
    "Studio checks the integrated engines on this computer. You can finish setup now and connect an engine later.",
    "Choose one or more purposes. Your first selection is your primary focus.",
    `Studio suggests these Buddies for ${focus.join(", ").toLowerCase()}. Edit the team before creating your workspace.`,
  ];

  return (
    <main className="fixed inset-0 z-50 flex flex-col overflow-auto bg-app px-4 py-6 sm:p-10">
      <section aria-labelledby="onboarding-title" className="mx-auto my-auto w-full max-w-[660px] shrink-0 rounded-2xl border border-hairline/50 bg-panel p-5 shadow-xl sm:p-9">
        {step > 0 && <p className="mb-2 text-xs font-medium text-ink-secondary" aria-label={`Step ${step + 1} of ${steps.length}`}>{steps[step]} · {step + 1} of {steps.length}</p>}
        {step === 0 && <div className="mb-7 flex flex-wrap items-end justify-center gap-4 rounded-2xl bg-inset px-3 py-7 sm:gap-7">
          {([{ name: "Building", color: "orange", face: "working" }, { name: "Designing", color: "blue", face: "celebrate" }, { name: "Researching", color: "purple", face: "thinking" }] as const).map((activity) => (
            <div className="flex flex-col items-center gap-2" key={activity.name}>
              <MausAvatar size={58} color={activity.color} state={activity.face} animated={!reducedMotion} />
              <span className="text-xs font-medium text-ink-secondary">{activity.name}</span>
            </div>
          ))}
        </div>}
        <h1 ref={heading} id="onboarding-title" tabIndex={-1} className={step === 0 ? "text-center text-3xl font-bold leading-tight text-ink outline-none sm:text-4xl" : "text-2xl font-bold text-ink outline-none"}>{titles[step]}</h1>
        <p className={`mt-2 text-sm leading-relaxed text-ink-secondary ${step === 0 ? "text-center" : ""}`}>{subtitles[step]}</p>

        {step === 1 && <form id="alpha-profile" className="mt-6 space-y-4" onSubmit={(event) => { event.preventDefault(); if (profileValid) void saveProfile(); }}>
          <Field label="Display name"><input className={inputClass} autoComplete="name" required maxLength={80} value={name} onChange={(event) => update({ name: event.target.value })} /></Field>
          <Field label="Email (optional)"><input className={inputClass} type="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => update({ email: event.target.value })} aria-describedby="alpha-email-help" /></Field>
          <p id="alpha-email-help" className="text-xs text-ink-secondary">{ONBOARDING_EMAIL_HELPER}</p>
          {email.trim() && !isValidOnboardingEmail(email) && <p className="text-xs text-warning">Enter a valid address or leave email blank.</p>}
        </form>}

        {step === 2 && <div className="mt-5 space-y-3">
          <button type="button" className={secondary} disabled={checking} onClick={() => void checkEngines(true)}><RefreshCw size={15} className={checking ? "animate-spin" : ""} /> Recheck engines</button>
          {checking && <p role="status" className="text-sm text-ink-secondary">Checking engines…</p>}
          {checkError && <p role="alert" className="text-sm text-warning">Studio couldn’t complete the check. Try again or continue with your workspace setup.</p>}
          {engines?.length === 0 && <p className="text-sm text-ink-secondary">No engines are configured.</p>}
          {engines?.map((engine) => <EngineCard key={engine.instanceId} engine={engine} />)}
        </div>}

        {step === 3 && <div className="mt-5 space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {purposes.map((purpose) => <button type="button" key={purpose} aria-pressed={focus.includes(purpose)} className={`${secondary} justify-start border ${focus.includes(purpose) ? "border-accent" : "border-hairline/40"}`} onClick={() => changePurpose(purpose)}>{focus.includes(purpose) && <Check size={15} />} {purpose}</button>)}
          </div>
          {focus.includes("Custom") && <Field label="What do you want to accomplish?"><textarea className={inputClass} maxLength={500} rows={3} value={custom} onChange={(event) => update({ custom: event.target.value })} /></Field>}
        </div>}

        {step === 4 && <div className="mt-5 space-y-3">
          {team.map((buddy) => {
            const value = buddy.modelSelection ? JSON.stringify([buddy.modelSelection.instanceId, buddy.modelSelection.model]) : "";
            return <article key={buddy.id} className="space-y-3 rounded-xl border border-hairline/40 bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-ink-secondary">{buddy.reason}</p>
                <button type="button" className={secondary} disabled={team.length < 2 || saving} aria-label={`Remove ${buddy.name || "Buddy"}`} onClick={() => update({ edited: true, team: team.filter((item) => item.id !== buddy.id) })}><Trash2 size={15} /></button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name"><input className={inputClass} disabled={saving} maxLength={48} value={buddy.name} onChange={(event) => patchBuddy(buddy.id, { name: event.target.value })} /></Field>
                <Field label="Role"><input className={inputClass} disabled={saving} maxLength={80} value={buddy.title} onChange={(event) => patchBuddy(buddy.id, { title: event.target.value })} /></Field>
              </div>
              <Field label="Responsibilities"><textarea className={inputClass} disabled={saving} maxLength={2400} rows={2} value={buddy.description} onChange={(event) => patchBuddy(buddy.id, { description: event.target.value })} /></Field>
              <Field label="AI engine and model"><select className={inputClass} disabled={saving} value={value} onChange={(event) => patchBuddy(buddy.id, { modelSelection: options.find((item) => item.value === event.target.value)?.selection ?? null })}>
                <option value="">Unassigned</option>
                {value && !options.some((item) => item.value === value) && <option value={value}>Previously selected model (unavailable)</option>}
                {options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select></Field>
            </article>;
          })}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondary} disabled={saving || team.length >= 8} onClick={() => update({ edited: true, team: [...team, { id: crypto.randomUUID(), name: "", title: "", description: "", reason: "Added by you.", modelSelection: preferredModel }] })}><Plus size={15} /> Add Buddy</button>
            <button type="button" className={secondary} disabled={saving} onClick={() => edited ? setRegenerating(true) : generate()}><RefreshCw size={15} /> Regenerate</button>
          </div>
          {regenerating && <div className="rounded-lg border border-warning/40 p-3 text-sm text-ink">
            Regenerating replaces your team edits.
            <div className="mt-2 flex flex-wrap gap-2"><button type="button" className={secondary} onClick={() => setRegenerating(false)}>Keep edits</button><button type="button" className={primary} onClick={generate}>Replace proposal</button></div>
          </div>}
          {!teamValid && <p className="text-xs text-warning">Give each Buddy a unique name, role, and responsibilities.</p>}
        </div>}

        {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
        <footer className={`mt-6 flex flex-wrap items-center gap-3 ${step === 0 ? "justify-center" : "justify-between"}`}>
          {step > 0 && <button type="button" className={secondary} onClick={previous} disabled={saving}><ArrowLeft size={15} /> Back</button>}
          {step === 0 && <button type="button" className={primary} onClick={() => update({ step: 1 })}>Get started <ArrowRight size={15} /></button>}
          {step === 1 && <button type="submit" form="alpha-profile" className={primary} disabled={saving || !profileValid}>{saving && <Loader2 size={15} className="animate-spin" />} Continue</button>}
          {step === 2 && <button type="button" className={primary} onClick={() => update({ step: 3 })}>Continue <ArrowRight size={15} /></button>}
          {step === 3 && <button type="button" className={primary} disabled={!purposeValid} onClick={() => team.length ? update({ step: 4 }) : generate()}>{team.length ? "Review saved proposal" : "Suggest my team"} <ArrowRight size={15} /></button>}
          {step === 4 && <button type="button" className={primary} disabled={!teamValid || saving} onClick={() => void approve()}>{saving && <Loader2 size={15} className="animate-spin" />} Approve and create workspace</button>}
        </footer>
      </section>
    </main>
  );
}
