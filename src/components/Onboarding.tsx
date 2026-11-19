import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ChartNoAxesCombined, Check, ChevronDown, Code2, Cpu, ExternalLink, LayoutTemplate, Loader2, Plus, RefreshCw, Search, Settings2, Trash2, Users, UserRound } from "lucide-react";
import { MausAvatar } from "./Avatar";
import { OnboardingWelcome } from "./OnboardingWelcome";
import { cn } from "@/lib/cn";
import { setEmailGateDone, track } from "@/lib/analytics";
import { describeOnboardingEngine, isValidOnboardingEmail, ONBOARDING_EMAIL_HELPER, ONBOARDING_LOCAL_GUARANTEE, resolveOnboardingProfile, type OnboardingEngineKind, type OnboardingInstanceRow } from "@/lib/onboardingCopy";
import { proposeTeam, purposes, type ProposedBuddy, type Purpose } from "@/lib/workspaceOnboarding";
import { api, useStore, type AppState } from "@/state/store";

const inputClass = "w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 text-[14px] text-ink focus-visible:outline-2 focus-visible:outline-accent";
const buttonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-[14px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-45";
const primary = `${buttonClass} bg-accent text-white hover:brightness-110`;
const secondary = `${buttonClass} bg-card text-ink hover:bg-raised`;

const setupSteps = [
  { label: "Personal details", icon: UserRound },
  { label: "AI engines", icon: Cpu },
  { label: "Workspace purpose", icon: LayoutTemplate },
  { label: "Your team", icon: Users },
];

const purposeDetails = {
  Development: { icon: Code2, copy: "Build and test software" },
  Design: { icon: LayoutTemplate, copy: "Design products and workflows" },
  Research: { icon: Search, copy: "Find and compare evidence" },
  Finance: { icon: ChartNoAxesCombined, copy: "Plan budgets and forecasts" },
  Custom: { icon: Settings2, copy: "Describe your own goal" },
};

const buddyColors = ["purple", "blue", "green", "orange", "mint"] as const;
type Engine = OnboardingInstanceRow & {
  models?: { default: string; options: Array<{ id: string; label: string }> };
};
type Draft = { step: number; name: string; email: string; focus: Purpose[]; custom: string; team: ProposedBuddy[]; edited: boolean; proposalGoal: string };
const initialDraft: Draft = { step: 0, name: "", email: "", focus: [], custom: "", team: [], edited: false, proposalGoal: "" };
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
  const [activeBuddy, setActiveBuddy] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const { dispatch } = useStore();
  const heading = useRef<HTMLHeadingElement>(null);
  const stage = useRef<HTMLDivElement>(null);

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
    stage.current?.scrollTo({ top: 0 });
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

  const proposalGoal = JSON.stringify([focus, focus.includes("Custom") ? custom.trim() : ""]);
  function generate() {
    update({ team: proposeTeam(focus, custom, preferredModel), edited: false, step: 4, proposalGoal });
    setActiveBuddy(null);
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
  function reviewTeam() {
    if (team.length && draft.proposalGoal === proposalGoal) update({ step: 4 });
    else if (team.length && edited) {
      update({ step: 4 });
      setRegenerating(true);
    } else generate();
  }

  function addBuddy() {
    const buddy = { id: crypto.randomUUID(), name: "", title: "", description: "", reason: "Added by you.", modelSelection: preferredModel };
    update({ edited: true, team: [...team, buddy] });
    setActiveBuddy(buddy.id);
  }

  const titles = ["Gérer Build Studio (v0.1 Alpha)", "Tell us about yourself", `Hi, ${name}. Let’s set up your AI engines.`, "What will you use Studio for?", "Review your team"];
  const focusLabel = new Intl.ListFormat("en", { type: "conjunction" }).format(focus.map((purpose) => purpose === "Custom" ? "your custom goal" : purpose.toLowerCase()));
  const subtitles = [
    "Bring AI Buddies together to plan, build, and review work in one workspace.",
    "Choose the name your Buddies will use when they talk with you.",
    "Studio checks the integrated engines on this computer. You can finish setup now and connect an engine later.",
    "Choose one or more purposes. Your first selection is your primary focus.",
    `This team is tailored to ${focusLabel}. Open a Buddy to edit its role, responsibilities, or model.`,
  ];

  if (step === 0) return <OnboardingWelcome heading={heading} reducedMotion={reducedMotion} onStart={() => update({ step: 1 })} />;

  return (
    <main className="fixed inset-0 z-50 flex flex-col overflow-auto bg-app p-3 sm:p-7 lg:p-10">
      <section aria-labelledby="onboarding-title" className="mx-auto my-auto grid w-full max-w-[1032px] shrink-0 overflow-hidden rounded-[22px] border border-hairline/80 bg-panel shadow-2xl md:grid-cols-[216px_minmax(0,1fr)]">
        <aside className="border-b border-hairline/65 bg-inset/75 px-5 py-4 sm:px-6 md:border-r md:border-b-0 md:px-5 md:py-8">
          <div className="flex items-center gap-3">
            <img src="/app-icon.svg" alt="" className="size-8 rounded-lg md:size-9" />
            <span className="text-[13px] font-semibold leading-tight text-ink">Gérer Build Studio</span>
          </div>
          <ol aria-label="Workspace setup progress" className="mt-7 hidden space-y-1.5 md:block">
            {setupSteps.map(({ icon: Icon, label }, index) => {
              const current = index + 1 === step;
              const complete = index + 1 < step;
              return <li key={label} aria-current={current ? "step" : undefined} className={cn(
                "flex items-center gap-3 rounded-lg border border-transparent px-2.5 py-2.5 text-[13px] font-medium",
                current ? "border-accent/25 bg-accent/10 text-ink" : "text-ink-secondary",
              )}>
                {complete ? <Check size={16} className="text-success" /> : <Icon size={16} className={current ? "text-accent-border" : undefined} />}
                {label}
              </li>;
            })}
          </ol>
          <div className="mt-4 md:hidden">
            <p className="text-xs text-ink-secondary">{setupSteps[step - 1]?.label} · Step {step} of {setupSteps.length}</p>
            <div className="mt-2 grid grid-cols-4 gap-1.5" aria-hidden="true">
              {setupSteps.map(({ label }, index) => <span key={label} className={cn("h-0.5 rounded-full", index < step ? "bg-accent" : "bg-hairline")} />)}
            </div>
          </div>
        </aside>
        <div className="flex min-w-0 flex-col md:max-h-[min(750px,calc(100dvh-82px))] md:min-h-[535px]">
          <div ref={stage} className="flex-1 overflow-auto px-5 py-7 sm:px-8 md:px-10 md:py-9">
            <h1 ref={heading} id="onboarding-title" tabIndex={-1} className="text-[clamp(1.6rem,3vw,2.25rem)] font-semibold leading-[1.15] tracking-[-0.035em] text-ink outline-none">{titles[step]}</h1>
            <p className="mt-2.5 max-w-[48ch] text-sm leading-relaxed text-ink-secondary">{subtitles[step]}</p>

            {step === 1 && <form id="alpha-profile" className="mt-7 max-w-[510px] space-y-5" onSubmit={(event) => { event.preventDefault(); if (profileValid) void saveProfile(); }}>
              <Field label="Display name"><input className={inputClass} autoComplete="name" required maxLength={80} value={name} onChange={(event) => update({ name: event.target.value })} /></Field>
              <Field label="Email (optional)"><input className={inputClass} type="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => update({ email: event.target.value })} aria-describedby="alpha-email-help" /></Field>
              <p id="alpha-email-help" className="-mt-3 text-xs text-ink-secondary">{ONBOARDING_EMAIL_HELPER}</p>
              {email.trim() && !isValidOnboardingEmail(email) && <p className="text-xs text-warning">Enter a valid address or leave email blank.</p>}
              <p className="rounded-lg border border-hairline/70 bg-inset px-3.5 py-3 text-xs leading-relaxed text-ink-secondary">{ONBOARDING_LOCAL_GUARANTEE}</p>
            </form>}

            {step === 2 && <div className="mt-5 space-y-3">
              <button type="button" className={secondary} disabled={checking} onClick={() => void checkEngines(true)}><RefreshCw size={15} className={checking ? "animate-spin" : ""} /> Recheck engines</button>
              {checking && <p role="status" className="text-sm text-ink-secondary">Checking engines…</p>}
              {checkError && <p role="alert" className="text-sm text-warning">Studio couldn’t complete the check. Try again or continue with your workspace setup.</p>}
              {engines?.length === 0 && <p className="text-sm text-ink-secondary">No engines are configured.</p>}
              {engines?.map((engine) => <EngineCard key={engine.instanceId} engine={engine} />)}
            </div>}

            {step === 3 && <div className="mt-5 space-y-4">
              <div className="grid gap-2.5 min-[460px]:grid-cols-2">
                {purposes.map((purpose) => {
                  const selected = focus.includes(purpose);
                  const { icon: Icon, copy } = purposeDetails[purpose];
                  return <button type="button" key={purpose} aria-pressed={selected} aria-label={purpose} onClick={() => changePurpose(purpose)} className={cn(
                    "flex min-w-0 items-center gap-3 rounded-xl border px-3.5 py-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                    selected ? "border-accent/70 bg-accent/10" : "border-hairline/75 bg-inset hover:border-hairline hover:bg-raised/50",
                  )}>
                    <Icon size={19} className={selected ? "shrink-0 text-accent-border" : "shrink-0 text-ink-secondary"} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-ink">{purpose}</span>
                      <span className="block text-xs leading-relaxed text-ink-secondary">{copy}</span>
                    </span>
                    {selected && <Check size={16} className="shrink-0 text-accent-border" />}
                  </button>;
                })}
              </div>
              {focus.includes("Custom") && <Field label="What do you want to accomplish?"><textarea className={inputClass} maxLength={500} rows={3} value={custom} onChange={(event) => update({ custom: event.target.value })} /></Field>}
            </div>}

            {step === 4 && <div className="mt-5 space-y-3">
              {team.map((buddy, index) => {
                const value = buddy.modelSelection ? JSON.stringify([buddy.modelSelection.instanceId, buddy.modelSelection.model]) : "";
                const model = options.find((item) => item.value === value);
                const expanded = activeBuddy === buddy.id;
                return <article key={buddy.id} className={cn("rounded-xl border bg-inset", expanded ? "border-accent/45" : "border-hairline/70")}>
                  <button type="button" aria-expanded={expanded} aria-controls={expanded ? `team-buddy-${buddy.id}` : undefined} aria-label={`Edit ${buddy.name || "new Buddy"}`} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-raised/40 focus-visible:outline-2 focus-visible:outline-accent" onClick={() => setActiveBuddy(expanded ? null : buddy.id)}>
                    <MausAvatar size={34} color={buddyColors[index % buddyColors.length]} state="idle" animated={false} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">{buddy.name || "New Buddy"} <span className="font-normal text-ink-secondary">{buddy.title && `· ${buddy.title}`}</span></span>
                      <span className="mt-0.5 block text-xs leading-snug text-ink-secondary">{buddy.reason}</span>
                    </span>
                    <span className="hidden max-w-[150px] truncate rounded-md border border-hairline/85 px-2 py-1 text-[11px] text-ink-secondary min-[560px]:block">{model?.label ?? (value ? "Unavailable model" : "Unassigned")}</span>
                    <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", expanded && "rotate-180")} />
                  </button>
                  {expanded && <div id={`team-buddy-${buddy.id}`} className="space-y-3 border-t border-hairline/75 px-3 py-4 sm:p-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Name"><input className={inputClass} disabled={saving} maxLength={48} value={buddy.name} onChange={(event) => patchBuddy(buddy.id, { name: event.target.value })} /></Field>
                      <Field label="Role"><input className={inputClass} disabled={saving} maxLength={80} value={buddy.title} onChange={(event) => patchBuddy(buddy.id, { title: event.target.value })} /></Field>
                    </div>
                    <Field label="Responsibilities"><textarea className={inputClass} disabled={saving} maxLength={2400} rows={2} value={buddy.description} onChange={(event) => patchBuddy(buddy.id, { description: event.target.value })} /></Field>
                    <Field label="AI engine and model"><select className={inputClass} disabled={saving} value={value} onChange={(event) => patchBuddy(buddy.id, { modelSelection: options.find((item) => item.value === event.target.value)?.selection ?? null })}>
                      <option value="">Unassigned</option>
                      {value && !model && <option value={value}>Previously selected model (unavailable)</option>}
                      {options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select></Field>
                    <button type="button" className="inline-flex min-h-8 items-center gap-2 rounded-md px-2 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-40" disabled={team.length < 2 || saving} onClick={() => update({ edited: true, team: team.filter((item) => item.id !== buddy.id) })}><Trash2 size={14} /> Remove Buddy</button>
                  </div>}
                </article>;
              })}
              <div className="flex flex-wrap gap-2">
                <button type="button" className={secondary} disabled={saving || team.length >= 8} onClick={addBuddy}><Plus size={15} /> Add Buddy</button>
                <button type="button" className={secondary} disabled={saving} onClick={() => edited ? setRegenerating(true) : generate()}><RefreshCw size={15} /> Regenerate</button>
              </div>
              {regenerating && <div className="rounded-lg border border-warning/40 p-3 text-sm text-ink">
                Regenerating replaces your team edits.
                <div className="mt-2 flex flex-wrap gap-2"><button type="button" className={secondary} onClick={() => setRegenerating(false)}>Keep edits</button><button type="button" className={primary} onClick={generate}>Replace proposal</button></div>
              </div>}
              {!teamValid && <p className="text-xs text-warning">Give each Buddy a unique name, role, and responsibilities.</p>}
            </div>}

            {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
          </div>
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-hairline/65 bg-panel px-5 py-3.5 sm:px-8 md:px-10">
            {step > 0 && <button type="button" className={secondary} onClick={previous} disabled={saving}><ArrowLeft size={15} /> Back</button>}
            {step === 1 && <button type="submit" form="alpha-profile" className={primary} disabled={saving || !profileValid}>{saving && <Loader2 size={15} className="animate-spin" />} Continue</button>}
            {step === 2 && <button type="button" className={primary} onClick={() => update({ step: 3 })}>Continue <ArrowRight size={15} /></button>}
            {step === 3 && <button type="button" className={primary} disabled={!purposeValid} onClick={reviewTeam}>{team.length && draft.proposalGoal === proposalGoal ? "Review saved proposal" : "Suggest my team"} <ArrowRight size={15} /></button>}
            {step === 4 && <button type="button" className={primary} disabled={!teamValid || saving} onClick={() => void approve()}>{saving && <Loader2 size={15} className="animate-spin" />} Approve and create workspace</button>}
          </footer>
        </div>
      </section>
    </main>
  );
}
