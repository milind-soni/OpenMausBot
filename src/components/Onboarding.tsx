import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowRight,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Cpu,
  ExternalLink,
  LayoutTemplate,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { MausAvatar } from "./Avatar";
import { OnboardingWelcome } from "./OnboardingWelcome";
import { ProviderMark } from "./ProviderIcons";
import { cn } from "@/lib/cn";
import { setEmailGateDone, track } from "@/lib/analytics";
import { stateForBot } from "@/lib/mascot";
import {
  describeOnboardingEngine,
  isValidOnboardingEmail,
  ONBOARDING_EMAIL_HELPER,
  ONBOARDING_LOCAL_GUARANTEE,
  resolveOnboardingProfile,
  type OnboardingEngineKind,
  type OnboardingInstanceRow,
} from "@/lib/onboardingCopy";
import { proposeTeam, purposes, type ProposedBuddy, type Purpose } from "@/lib/workspaceOnboarding";
import { api, useStore, type AppState } from "@/state/store";
import "./Onboarding.css";

const inputClass =
  "w-full rounded-xl border border-white/[0.1] bg-panel px-4 py-3 text-[14px] text-ink placeholder:text-ink-secondary/45 transition-colors hover:border-white/[0.18] focus:border-accent/70 focus:bg-inset focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50";

const primaryPill =
  "gbs-onboard-cta inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-full bg-accent px-6 py-2.5 text-[14px] font-semibold text-white transition-all duration-150 hover:brightness-110 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40";

const ghostButton =
  "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-full px-4 py-2.5 text-[14px] font-medium text-ink-secondary transition-colors hover:bg-white/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40";

const toolbarButton =
  "inline-flex min-h-9 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-white/[0.1] bg-panel px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:border-white/[0.18] hover:bg-raised/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40";

const setupSteps = [
  { label: "Personal details", icon: UserRound },
  { label: "AI engines", icon: Cpu },
  { label: "Purpose", icon: LayoutTemplate },
  { label: "Your team", icon: Users },
] as const;

const purposeDetails: Record<
  Purpose,
  {
    icon: typeof Code2;
    copy: string;
    iconBg: string;
    iconText: string;
  }
> = {
  Development: {
    icon: Code2,
    copy: "Build, debug, and ship software projects.",
    iconBg: "bg-sky-500/12 border-sky-400/25",
    iconText: "text-sky-300",
  },
  Design: {
    icon: LayoutTemplate,
    copy: "Craft interfaces, flows, and visual systems.",
    iconBg: "bg-violet-500/12 border-violet-400/25",
    iconText: "text-violet-300",
  },
  Research: {
    icon: Search,
    copy: "Investigate topics and compare primary evidence.",
    iconBg: "bg-teal-500/12 border-teal-400/25",
    iconText: "text-teal-300",
  },
  Finance: {
    icon: ChartNoAxesCombined,
    copy: "Model budgets, forecasts, and key trade-offs.",
    iconBg: "bg-amber-500/12 border-amber-400/25",
    iconText: "text-amber-300",
  },
  Custom: {
    icon: Settings2,
    copy: "Describe your own workflow or goal in your own words.",
    iconBg: "bg-white/[0.06] border-white/[0.12]",
    iconText: "text-ink",
  },
};

const buddyColors = ["purple", "blue", "green", "orange", "mint", "teal", "coral", "cyan"] as const;

type Engine = OnboardingInstanceRow & {
  models?: { default: string; options: Array<{ id: string; label: string }> };
};

type Draft = {
  step: number;
  name: string;
  email: string;
  focus: Purpose[];
  custom: string;
  team: ProposedBuddy[];
  edited: boolean;
  proposalGoal: string;
};

const initialDraft: Draft = {
  step: 0,
  name: "",
  email: "",
  focus: [],
  custom: "",
  team: [],
  edited: false,
  proposalGoal: "",
};

function loadDraft(key: string, profile: { name: string; email: string }): Draft {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return { ...initialDraft, ...JSON.parse(stored) };
  } catch {}
  return { ...initialDraft, ...profile, step: profile.name ? 2 : 0 };
}

function Field({ label, optional, children }: { label: string; optional?: boolean; children: ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink/90">
        {label}
        {optional && <span className="font-normal text-ink-secondary/70">(optional)</span>}
      </span>
      {children}
    </label>
  );
}

const featuredEngines = ["claudeAgent", "codex", "grokAgent", "antigravityAgent"] as const;

function EngineCard({ engine }: { engine: Engine }) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const known = featuredEngines.find((kind) => kind === engine.driverKind);
  const help = known ? describeOnboardingEngine(known as OnboardingEngineKind, engine, false) : undefined;
  const { state, reason, authenticated, version, subscriptionPlan } = engine.snapshot;

  const ready = state === "available" && authenticated === true;
  const needsSignIn = state === "available" && authenticated === false;
  const unverified = state === "available" && authenticated === undefined;
  const notInstalled = state !== "available" && /CLI not found/i.test(reason ?? "");

  const installation = state === "available" ? "Installed" : notInstalled ? "Not installed" : "Unknown";
  const signIn = authenticated === true ? "Signed in" : authenticated === false ? "Sign-in required" : "Sign-in unknown";
  const plan = subscriptionPlan?.trim() ? subscriptionPlan.trim() : "Plan unavailable";

  const statusTone = ready
    ? { label: "Ready", pill: "border-success/30 bg-success/10 text-success", dot: "bg-success" }
    : needsSignIn
      ? { label: "Sign-in required", pill: "border-warning/30 bg-warning/10 text-warning", dot: "bg-warning" }
      : unverified
        ? { label: "Unverified", pill: "border-white/[0.15] bg-white/[0.06] text-ink", dot: "bg-sky-400" }
        : { label: notInstalled ? "Not installed" : "Unavailable", pill: "border-white/[0.1] bg-inset text-ink-secondary", dot: "bg-ink-secondary/50" };

  const cleanVersion = (() => {
    const raw = version?.trim();
    if (!raw) return null;
    const semver = raw.match(/\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?/);
    return semver ? semver[0] : raw.split(" ")[0];
  })();
  const titleBase = help?.title ? help.title.split(" · ")[0] : engine.displayName;
  const hasSetup = Boolean(help?.command || help?.docsUrl);

  const copyCommand = async () => {
    if (!help?.command) return;
    try {
      await navigator.clipboard.writeText(help.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  return (
    <article className="gbs-engine-card rounded-2xl border px-4 py-3.5 transition-colors sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-3.5 sm:flex-nowrap sm:gap-4">
        {/* Circular provider brand mark matching wireframe */}
        <div
          className="flex size-11 shrink-0 items-center justify-center rounded-full border border-white/[0.09] bg-inset shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
          aria-hidden="true"
        >
          <ProviderMark driverKind={engine.driverKind} size={21} />
        </div>

        {/* Name, version, and truthful status metadata */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold text-ink">{titleBase}</h3>
            {cleanVersion && (
              <span className="rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary/80">
                {cleanVersion}
              </span>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-secondary">
            <span>{installation}</span>
            <span aria-hidden="true" className="text-white/20">·</span>
            <span>{signIn}</span>
            <span aria-hidden="true" className="text-white/20">·</span>
            <span className="first-letter:uppercase">{plan}</span>
          </p>
        </div>

        {/* Right-aligned status pill + optional setup action */}
        <div className="flex w-full shrink-0 items-center justify-between gap-2 sm:w-auto sm:justify-end">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
              statusTone.pill,
            )}
          >
            <span className={cn("size-1.5 rounded-full", statusTone.dot)} aria-hidden="true" />
            {statusTone.label}
          </span>
          {hasSetup && !ready && (
            <button
              type="button"
              aria-expanded={setupOpen}
              onClick={() => setSetupOpen((open) => !open)}
              className="inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-full border border-white/[0.12] bg-raised/70 px-2.5 py-1 text-[11px] font-medium text-ink transition-colors hover:border-white/[0.22] hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent"
            >
              {state === "available" ? "Sign in" : "Set up"}
              <ChevronDown size={12} className={cn("transition-transform", setupOpen && "rotate-180")} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {setupOpen && hasSetup && (
        <div className="mt-3.5 space-y-2.5 border-t border-white/[0.07] pt-3.5 text-xs">
          {help?.detail && <p className="text-ink-secondary">{help.detail}</p>}
          {help?.command && (
            <div className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-inset px-3 py-2">
              <Terminal size={13} className="shrink-0 text-ink-secondary/70" aria-hidden="true" />
              <code className="min-w-0 flex-1 select-all break-all font-mono text-[12px] text-ink">{help.command}</code>
              <button
                type="button"
                onClick={() => void copyCommand()}
                className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg bg-white/[0.07] px-2 py-1 text-[11px] font-medium text-ink transition-colors hover:bg-white/[0.13] focus-visible:outline-2 focus-visible:outline-accent"
              >
                {copied ? <Check size={12} className="text-success" aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
          {help?.docsUrl && (
            <a
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-accent-border hover:underline"
              href={help.docsUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open setup guide <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
        </div>
      )}
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

  // Close expanded Buddy editor on Escape for crisp keyboard ergonomics
  useEffect(() => {
    if (!activeBuddy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveBuddy(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeBuddy]);

  async function checkEngines(refresh = false) {
    setChecking(true);
    setCheckError(false);
    try {
      const response = await api(`/api/instances?setup=1${refresh ? "&refresh=1" : ""}`, {
        signal: AbortSignal.timeout(15_000),
      });
      setEngines(response.instances);
    } catch {
      setCheckError(true);
    } finally {
      setChecking(false);
    }
  }

  const engineStepReached = step >= 2;
  useEffect(() => {
    if (engineStepReached) void checkEngines();
  }, [engineStepReached]);

  const options = (engines ?? []).flatMap((engine) => {
    if (engine.snapshot.state !== "available" || engine.snapshot.authenticated === false) return [];
    return (engine.models?.options ?? []).map((model) => ({
      value: JSON.stringify([engine.instanceId, model.id]),
      selection: { instanceId: engine.instanceId, model: model.id },
      driverKind: engine.driverKind,
      shortLabel: `${engine.displayName} · ${model.label}`,
      label: `${engine.displayName} · ${model.label}${engine.snapshot.authenticated === undefined ? " (sign-in unverified)" : ""}`,
      recommended: engine.snapshot.authenticated === true && model.id === engine.models?.default,
    }));
  });

  const preferredModel = options.find((item) => item.recommended)?.selection ?? null;
  // A custom goal needs a working AI engine to turn it into a team, so the
  // Custom purpose is only offered once one is available.
  const customAvailable = options.length > 0;
  const readyEngineCount = (engines ?? []).filter(
    (engine) => engine.snapshot.state === "available" && engine.snapshot.authenticated === true,
  ).length;

  const previous = () => {
    setError("");
    setRegenerating(false);
    setActiveBuddy(null);
    update({ step: step - 1 });
  };

  const jumpToStep = (targetStep: number) => {
    if (saving || targetStep >= step || targetStep < 1) return;
    setError("");
    setRegenerating(false);
    setActiveBuddy(null);
    update({ step: targetStep });
  };

  async function saveProfile() {
    if (saving) return;
    const resolved = resolveOnboardingProfile({ name, email, includeEmail: true });
    setSaving(true);
    setError("");
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ profile: resolved }),
        signal: AbortSignal.timeout(12_000),
      });
      dispatch({ type: "configStatus", config });
      track("profile_saved", { hasEmail: Boolean(resolved.email) });
      update({ ...resolved, step: 2 });
    } catch {
      setError("Studio couldn’t save your details. Your entries are still here — please try again.");
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

  function patchBuddy(buddyId: string, patch: Partial<ProposedBuddy>) {
    update({ edited: true, team: team.map((buddy) => (buddy.id === buddyId ? { ...buddy, ...patch } : buddy)) });
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

  useEffect(() => {
    if (engines && !customAvailable && focus.includes("Custom")) update({ focus: focus.filter((value) => value !== "Custom") });
  }, [engines, customAvailable, focus]);

  function changePurpose(purpose: Purpose) {
    if (purpose === "Custom" && !customAvailable) return;
    update({ focus: focus.includes(purpose) ? focus.filter((value) => value !== purpose) : [...focus, purpose] });
  }

  const purposeValid = focus.length > 0 && (!focus.includes("Custom") || Boolean(custom.trim()));

  const normalizedNames = team.map((buddy) => buddy.name.trim().toLowerCase());
  const duplicateNames = new Set(
    normalizedNames.filter((item, idx) => item && normalizedNames.indexOf(item) !== idx),
  );
  const isBuddyInvalid = (buddy: ProposedBuddy) =>
    !buddy.name.trim() ||
    !buddy.title.trim() ||
    !buddy.description.trim() ||
    duplicateNames.has(buddy.name.trim().toLowerCase());

  const teamValid = team.length > 0 && team.every((buddy) => !isBuddyInvalid(buddy));

  function reviewTeam() {
    if (team.length && draft.proposalGoal === proposalGoal) update({ step: 4 });
    else if (team.length && edited) {
      update({ step: 4 });
      setRegenerating(true);
    } else {
      generate();
    }
  }

  function addBuddy() {
    const buddy: ProposedBuddy = {
      id: crypto.randomUUID(),
      name: "",
      title: "",
      description: "",
      reason: "Added by you.",
      modelSelection: preferredModel,
    };
    update({ edited: true, team: [...team, buddy] });
    setActiveBuddy(buddy.id);
  }

  const focusLabel = new Intl.ListFormat("en", { type: "conjunction" }).format(
    focus.map((purpose) => (purpose === "Custom" ? "your custom goal" : purpose.toLowerCase())),
  );

  const titles = [
    "Gérer Build Studio (v0.1 Alpha)",
    "Personal details",
    `Hi, ${name}. Let’s set up your AI engines.`,
    "What will you use Studio for?",
    "Review your team",
  ];

  const subtitles = [
    "Bring AI Buddies together to plan, build, and review work in one workspace.",
    "Choose the name your Buddies will use when collaborating with you.",
    "Studio checks the integrated AI engines on this computer. You can finish setup now and connect an engine anytime.",
    "Pick one or more areas. Your first choice becomes your primary focus.",
    `Tailored for ${focusLabel}. Click any Buddy to customize their role, responsibilities, or AI model.`,
  ];

  if (step === 0) {
    return <OnboardingWelcome heading={heading} reducedMotion={reducedMotion} onStart={() => update({ step: 1 })} />;
  }

  const unassignedCount = team.filter((buddy) => !buddy.modelSelection).length;

  return (
    <main className="fixed inset-0 z-50 flex flex-col bg-app md:flex-row">
      {/* Left vertical stepper rail — faithful to the wireframe's connected circular nodes */}
      <aside className="gbs-onboard-rail shrink-0 border-b border-white/[0.07] px-5 py-4 sm:px-7 md:flex md:w-[272px] md:flex-col md:border-r md:border-b-0 md:px-6 md:py-8 lg:w-[292px]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img src="/app-icon.svg" alt="" className="size-9 rounded-[10px] shadow-sm" />
            <div className="min-w-0">
              <div className="truncate text-[14px] font-semibold tracking-[-0.015em] text-ink">Gérer Build Studio</div>
              <div className="text-[11px] font-medium text-ink-secondary/75">v0.1 Alpha</div>
            </div>
          </div>
          <span className="text-[12px] font-medium text-ink-secondary md:hidden">
            Step {step} of {setupSteps.length}
          </span>
        </div>

        {/* Desktop vertical connected stepper */}
        <nav aria-label="Workspace setup progress" className="mt-10 hidden flex-1 md:block">
          <ol className="space-y-0">
            {setupSteps.map(({ icon: Icon, label }, index) => {
              const stepNumber = index + 1;
              const current = stepNumber === step;
              const complete = stepNumber < step;
              const isLast = index === setupSteps.length - 1;

              return (
                <li key={label} aria-current={current ? "step" : undefined} className="relative">
                  <button
                    type="button"
                    disabled={!complete || saving}
                    onClick={() => jumpToStep(stepNumber)}
                    className={cn(
                      "flex w-full items-center gap-3.5 rounded-xl border border-transparent px-3 py-2.5 text-left transition-all focus-visible:outline-2 focus-visible:outline-accent",
                      current && "gbs-step-card-active text-ink",
                      complete && "cursor-pointer text-ink/90 hover:bg-white/[0.04]",
                      !current && !complete && "cursor-default text-ink-secondary/70",
                    )}
                  >
                    <span
                      className={cn(
                        "relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border transition-all",
                        current && "border-accent bg-accent text-white shadow-[0_0_0_4px_rgba(16,132,254,0.18)]",
                        complete && "border-success/40 bg-success/15 text-success",
                        !current && !complete && "border-white/[0.14] bg-inset text-ink-secondary/75",
                      )}
                      aria-hidden="true"
                    >
                      {complete ? <Check size={15} strokeWidth={2.5} /> : <Icon size={15} />}
                    </span>
                    <span className={cn("text-[13.5px]", current ? "font-semibold text-ink" : "font-medium")}>
                      {label}
                    </span>
                  </button>

                  {/* Vertical connector line between step nodes */}
                  {!isLast && (
                    <div className="ml-[27px] flex h-6 items-stretch" aria-hidden="true">
                      <span
                        className={cn(
                          "w-0",
                          complete
                            ? "border-l-[1.5px] border-success/45"
                            : "border-l border-dashed border-white/[0.16]",
                        )}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>

        {/* Compact horizontal connected progress strip for narrow windows */}
        <div className="mt-4 md:hidden" aria-label="Workspace setup progress">
          <div className="flex items-center">
            {setupSteps.map(({ label }, index) => {
              const stepNumber = index + 1;
              const current = stepNumber === step;
              const complete = stepNumber < step;
              const isLast = index === setupSteps.length - 1;
              return (
                <div key={label} className={cn("flex items-center", !isLast && "flex-1")}>
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                      current && "border-accent bg-accent text-white",
                      complete && "border-success/40 bg-success/15 text-success",
                      !current && !complete && "border-white/[0.14] bg-inset text-ink-secondary",
                    )}
                  >
                    {complete ? <Check size={12} strokeWidth={2.5} /> : stepNumber}
                  </span>
                  {!isLast && (
                    <span
                      className={cn(
                        "mx-2 h-px flex-1",
                        complete ? "bg-success/50" : "border-t border-dashed border-white/[0.16]",
                      )}
                      aria-hidden="true"
                    />
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs font-medium text-ink">{setupSteps[step - 1]?.label}</p>
        </div>
      </aside>

      {/* Right main stage + clean bottom-right action footer */}
      <section aria-labelledby="onboarding-title" className="gbs-onboard-stage flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={stage} className="flex-1 overflow-auto">
          <div key={step} className="gbs-step-enter mx-auto w-full max-w-[780px] px-5 pt-8 pb-10 sm:px-9 md:px-12 md:pt-14">
            {/* Step header */}
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <h1
                  ref={heading}
                  id="onboarding-title"
                  tabIndex={-1}
                  className="text-[clamp(1.6rem,2.7vw,2.15rem)] font-semibold leading-[1.15] tracking-[-0.03em] text-ink outline-none"
                >
                  {titles[step]}
                </h1>
                <p className="mt-2.5 max-w-[56ch] text-[14px] leading-relaxed text-ink-secondary">
                  {subtitles[step]}
                </p>
              </div>
              {step === 2 && (
                <button
                  type="button"
                  className={cn(toolbarButton, "mt-1 rounded-full px-3.5")}
                  disabled={checking}
                  onClick={() => void checkEngines(true)}
                >
                  <RefreshCw size={13} className={checking ? "animate-spin" : ""} aria-hidden="true" />
                  {checking ? "Checking…" : "Recheck"}
                </button>
              )}
            </header>

            {/* STEP 1 — Personal details */}
            {step === 1 && (
              <form
                id="alpha-profile"
                aria-labelledby="onboarding-title"
                className="mt-9 max-w-[560px] space-y-6"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (profileValid) void saveProfile();
                }}
              >
                <Field label="Display name">
                  <input
                    name="displayName"
                    className={inputClass}
                    autoComplete="name"
                    placeholder="How should Buddies address you?"
                    required
                    maxLength={80}
                    value={name}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                </Field>

                <div>
                  <Field label="Email" optional>
                    <input
                      name="email"
                      className={inputClass}
                      type="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      maxLength={254}
                      value={email}
                      onChange={(event) => update({ email: event.target.value })}
                      aria-describedby="alpha-email-help"
                    />
                  </Field>
                  <p id="alpha-email-help" className="mt-2 text-[12px] text-ink-secondary/80">
                    {ONBOARDING_EMAIL_HELPER}
                  </p>
                  {email.trim() && !isValidOnboardingEmail(email) && (
                    <p role="alert" className="mt-1.5 flex items-center gap-1.5 text-[12px] text-warning">
                      <AlertCircle size={13} aria-hidden="true" />
                      Enter a valid address or leave email blank.
                    </p>
                  )}
                </div>

                <div className="flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-panel/60 px-3.5 py-3 text-[12px] leading-relaxed text-ink-secondary/85">
                  <ShieldCheck size={15} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />
                  <p>{ONBOARDING_LOCAL_GUARANTEE}</p>
                </div>
              </form>
            )}

            {/* STEP 2 — AI Engines */}
            {step === 2 && (
              <div className="mt-8 space-y-3">
                {checking && !engines && (
                  <div role="status" aria-label="Checking installed AI engines" className="space-y-3">
                    {[0, 1, 2].map((item) => (
                      <div
                        key={item}
                        className="gbs-skeleton-pulse flex items-center gap-4 rounded-2xl border border-white/[0.06] bg-panel/80 px-5 py-4"
                      >
                        <div className="size-11 rounded-full bg-raised/70" />
                        <div className="flex-1 space-y-2">
                          <div className="h-3.5 w-36 rounded bg-raised/80" />
                          <div className="h-2.5 w-56 rounded bg-raised/50" />
                        </div>
                        <div className="h-6 w-20 rounded-full bg-raised/60" />
                      </div>
                    ))}
                  </div>
                )}

                {checkError && (
                  <div role="alert" className="flex items-start gap-2.5 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-[13px] text-warning">
                    <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>Studio couldn’t complete the check. Try rechecking or continue with your workspace setup.</span>
                  </div>
                )}

                {engines?.length === 0 && !checking && (
                  <p className="rounded-2xl border border-white/[0.07] bg-panel px-5 py-4 text-sm text-ink-secondary">
                    No AI engines are configured yet.
                  </p>
                )}

                {engines?.map((engine) => <EngineCard key={engine.instanceId} engine={engine} />)}

                {engines && engines.length > 0 && readyEngineCount === 0 && !checking && (
                  <p className="pt-1 text-[12.5px] leading-relaxed text-ink-secondary/85">
                    No ready engine detected yet. You can continue exploring and setting up your team now — connect an AI engine in Settings whenever you’re ready to run a Buddy.
                  </p>
                )}
              </div>
            )}

            {/* STEP 3 — Workspace Purpose (2-column generous icon-top cards matching wireframe) */}
            {step === 3 && (
              <div className="mt-8 space-y-4">
                <div className="grid gap-3.5 sm:grid-cols-2">
                  {purposes.map((purpose) => {
                    const selected = focus.includes(purpose);
                    const isPrimary = focus[0] === purpose;
                    const { icon: Icon, copy, iconBg, iconText } = purposeDetails[purpose];
                    const isCustom = purpose === "Custom";
                    const unavailable = isCustom && !customAvailable;

                    return (
                      <button
                        type="button"
                        key={purpose}
                        aria-pressed={selected}
                        aria-label={purpose}
                        aria-describedby={unavailable ? "custom-purpose-unavailable" : undefined}
                        disabled={unavailable}
                        onClick={() => changePurpose(purpose)}
                        className={cn(
                          "gbs-purpose-card group flex min-w-0 cursor-pointer flex-col rounded-2xl border p-5 text-left transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50",
                          isCustom && "sm:col-span-2",
                        )}
                      >
                        <div className="flex w-full items-start justify-between gap-3">
                          <span
                            className={cn(
                              "flex size-10 items-center justify-center rounded-xl border transition-colors",
                              selected ? "border-accent/40 bg-accent/15 text-accent-border" : cn(iconBg, iconText),
                            )}
                            aria-hidden="true"
                          >
                            <Icon size={19} />
                          </span>

                          <div className="flex items-center gap-2">
                            {isPrimary && (
                              <span className="rounded-full border border-accent/35 bg-accent/15 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-accent-border">
                                Primary
                              </span>
                            )}
                            <span
                              className={cn(
                                "flex size-5 items-center justify-center rounded-full border transition-all",
                                selected
                                  ? "border-accent bg-accent text-white"
                                  : "border-white/[0.16] bg-inset group-hover:border-white/[0.28]",
                              )}
                              aria-hidden="true"
                            >
                              {selected && <Check size={12} strokeWidth={3} />}
                            </span>
                          </div>
                        </div>

                        <span className="mt-4 block text-[15px] font-semibold text-ink">{purpose}</span>
                        <span className="mt-1 block text-[13px] leading-relaxed text-ink-secondary">{copy}</span>
                        {unavailable && (
                          <span id="custom-purpose-unavailable" className="mt-2 block text-[12px] leading-relaxed text-ink-secondary">
                            {engines ? "Connect an AI engine in the previous step to suggest a team for a custom goal." : "Checking your AI engines…"}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {focus.includes("Custom") && (
                  <div className="rounded-2xl border border-accent/25 bg-panel/90 p-4 sm:p-5">
                    <Field label="What do you want to accomplish?">
                      <textarea
                        name="customGoal"
                        className={inputClass}
                        placeholder="e.g. Plan a product launch, write technical specs, manage client deliverables…"
                        maxLength={500}
                        rows={3}
                        value={custom}
                        onChange={(event) => update({ custom: event.target.value })}
                      />
                    </Field>
                  </div>
                )}
              </div>
            )}

            {/* STEP 4 — Your Team (Top-right Add/Regenerate + 2-column Buddy card grid matching wireframe) */}
            {step === 4 && (
              <div className="mt-7 space-y-4">
                {/* Compact toolbar directly above the Buddy grid */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-secondary">
                    <span className="font-medium text-ink">{team.length} {team.length === 1 ? "Buddy" : "Buddies"}</span>
                    {unassignedCount > 0 && (
                      <>
                        <span aria-hidden="true" className="text-white/20">·</span>
                        <span>{unassignedCount} unassigned — you can pick models anytime</span>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={toolbarButton}
                      disabled={saving || team.length >= 8}
                      onClick={addBuddy}
                    >
                      <Plus size={14} aria-hidden="true" />
                      Add Buddy
                    </button>
                    <button
                      type="button"
                      className={toolbarButton}
                      disabled={saving}
                      onClick={() => (edited ? setRegenerating(true) : generate())}
                    >
                      <RefreshCw size={13} aria-hidden="true" />
                      Regenerate
                    </button>
                  </div>
                </div>

                {regenerating && (
                  <div
                    role="alert"
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-warning/35 bg-warning/10 px-4 py-3 text-[13px] text-ink"
                  >
                    <span>Regenerating will replace your manual team edits.</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="cursor-pointer rounded-full border border-white/[0.14] bg-panel px-3 py-1.5 text-xs font-medium text-ink hover:bg-raised"
                        onClick={() => setRegenerating(false)}
                      >
                        Keep edits
                      </button>
                      <button
                        type="button"
                        className="cursor-pointer rounded-full bg-warning px-3 py-1.5 text-xs font-semibold text-black hover:brightness-110"
                        onClick={generate}
                      >
                        Replace proposal
                      </button>
                    </div>
                  </div>
                )}

                {/* 2-column Buddy cards grid; clicking a card smoothly expands it across both columns to edit */}
                <div className="grid gap-3.5 sm:grid-cols-2">
                  {team.map((buddy, index) => {
                    const value = buddy.modelSelection
                      ? JSON.stringify([buddy.modelSelection.instanceId, buddy.modelSelection.model])
                      : "";
                    const model = options.find((item) => item.value === value);
                    const expanded = activeBuddy === buddy.id;
                    const invalid = isBuddyInvalid(buddy);
                    const color = buddyColors[index % buddyColors.length];
                    const avatarState = stateForBot({
                      name: buddy.name,
                      title: buddy.title,
                      description: buddy.description,
                    });

                    if (expanded) {
                      return (
                        <article
                          key={buddy.id}
                          id={`team-buddy-${buddy.id}`}
                          className="gbs-team-card--expanded rounded-2xl border p-5 sm:col-span-2"
                        >
                          <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] pb-4">
                            <div className="flex min-w-0 items-center gap-3.5">
                              <MausAvatar
                                size={46}
                                color={color}
                                state={avatarState}
                                animated={!reducedMotion}
                                trackPointer={!reducedMotion}
                              />
                              <div className="min-w-0">
                                <h3 className="truncate text-[15px] font-semibold text-ink">
                                  {buddy.name || "New Buddy"}
                                </h3>
                                <p className="truncate text-[12px] text-accent-border">
                                  {buddy.title || "Define role and responsibilities"}
                                </p>
                              </div>
                            </div>
                            <button
                              type="button"
                              aria-label="Close editor"
                              onClick={() => setActiveBuddy(null)}
                              className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-white/[0.08] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                            >
                              <X size={16} aria-hidden="true" />
                            </button>
                          </div>

                          <div className="mt-4 space-y-4">
                            <div className="grid gap-3.5 sm:grid-cols-2">
                              <Field label="Name">
                                <input
                                  name={`buddy-name-${buddy.id}`}
                                  className={inputClass}
                                  disabled={saving}
                                  maxLength={48}
                                  placeholder="e.g. Kit"
                                  value={buddy.name}
                                  onChange={(event) => patchBuddy(buddy.id, { name: event.target.value })}
                                />
                              </Field>
                              <Field label="Role">
                                <input
                                  name={`buddy-role-${buddy.id}`}
                                  className={inputClass}
                                  disabled={saving}
                                  maxLength={80}
                                  placeholder="e.g. Developer"
                                  value={buddy.title}
                                  onChange={(event) => patchBuddy(buddy.id, { title: event.target.value })}
                                />
                              </Field>
                            </div>

                            <Field label="Responsibilities">
                              <textarea
                                name={`buddy-desc-${buddy.id}`}
                                className={inputClass}
                                disabled={saving}
                                maxLength={2400}
                                rows={10}
                                placeholder="Describe what this Buddy owns and how it should help."
                                value={buddy.description}
                                onChange={(event) => patchBuddy(buddy.id, { description: event.target.value })}
                              />
                            </Field>

                            <Field label="AI engine and model">
                              <select
                                name={`buddy-model-${buddy.id}`}
                                className={cn(inputClass, "gbs-select cursor-pointer")}
                                disabled={saving}
                                value={value}
                                onChange={(event) =>
                                  patchBuddy(buddy.id, {
                                    modelSelection:
                                      options.find((item) => item.value === event.target.value)?.selection ?? null,
                                  })
                                }
                              >
                                <option value="">Unassigned (set later)</option>
                                {value && !model && (
                                  <option value={value}>Previously selected model (unavailable)</option>
                                )}
                                {options.map((item) => (
                                  <option key={item.value} value={item.value}>
                                    {item.label}
                                  </option>
                                ))}
                              </select>
                            </Field>

                            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] pt-3.5">
                              <button
                                type="button"
                                className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-danger transition-colors hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
                                disabled={team.length < 2 || saving}
                                onClick={() => {
                                  update({ edited: true, team: team.filter((item) => item.id !== buddy.id) });
                                  setActiveBuddy(null);
                                }}
                              >
                                <Trash2 size={14} aria-hidden="true" />
                                Remove Buddy
                              </button>
                              <button
                                type="button"
                                className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full bg-raised px-4 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent"
                                onClick={() => setActiveBuddy(null)}
                              >
                                <Check size={14} aria-hidden="true" />
                                Done
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    }

                    return (
                      <article
                        key={buddy.id}
                        className={cn(
                          "gbs-team-card group rounded-2xl border transition-all duration-150",
                          invalid && "border-warning/55",
                        )}
                      >
                        <button
                          type="button"
                          aria-expanded={false}
                          aria-label={`Edit ${buddy.name || "new Buddy"}`}
                          onClick={() => setActiveBuddy(buddy.id)}
                          className="flex h-full w-full cursor-pointer items-start gap-3.5 rounded-2xl p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          <div className="relative mt-0.5 shrink-0">
                            <MausAvatar
                              size={50}
                              color={color}
                              state={avatarState}
                              animated={!reducedMotion}
                              trackPointer={!reducedMotion}
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate text-[15px] font-semibold text-ink">
                                  {buddy.name || "New Buddy"}
                                </div>
                                <div className="truncate text-[12px] font-medium text-accent-border">
                                  {buddy.title || "Needs a role"}
                                </div>
                              </div>
                              <span
                                className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary/65 transition-colors group-hover:bg-white/[0.07] group-hover:text-ink"
                                aria-hidden="true"
                              >
                                <Pencil size={13} />
                              </span>
                            </div>
                            <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-ink-secondary">
                              {buddy.reason || buddy.description || "Add responsibilities for this Buddy."}
                            </p>
                            <div className="mt-3 flex flex-wrap items-center gap-1.5">
                              <span
                                className={cn(
                                  "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                                  model
                                    ? "border-white/[0.09] bg-inset text-ink-secondary"
                                    : value
                                      ? "border-warning/35 bg-warning/10 text-warning"
                                      : "border-white/[0.08] bg-inset/70 text-ink-secondary/75",
                                )}
                              >
                                {model && <ProviderMark driverKind={model.driverKind} size={11} />}
                                <span className="truncate">
                                  {model?.shortLabel ?? (value ? "Unavailable model" : "Unassigned")}
                                </span>
                              </span>
                            </div>
                          </div>
                        </button>
                      </article>
                    );
                  })}
                </div>

                {!teamValid && (
                  <p role="alert" className="flex items-center gap-1.5 text-[12.5px] text-warning">
                    <AlertCircle size={14} aria-hidden="true" />
                    Give each Buddy a unique name, role, and responsibilities before creating your workspace.
                  </p>
                )}
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="mt-5 flex items-start gap-2.5 rounded-2xl border border-danger/35 bg-danger/10 px-4 py-3 text-[13px] text-danger"
              >
                <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>

        {/* Bottom-right action cluster matching every wireframe panel (Back + pill CTA) */}
        <footer className="shrink-0 border-t border-white/[0.07] bg-app/90 backdrop-blur-md">
          <div className="mx-auto flex w-full max-w-[780px] flex-wrap items-center justify-end gap-3 px-5 py-4 sm:px-9 md:px-12">
            {step > 0 && (
              <button type="button" className={ghostButton} onClick={previous} disabled={saving}>
                Back
              </button>
            )}
            {step === 1 && (
              <button type="submit" form="alpha-profile" className={primaryPill} disabled={saving || !profileValid}>
                {saving && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
                Continue
                {!saving && <ArrowRight size={15} aria-hidden="true" />}
              </button>
            )}
            {step === 2 && (
              <button type="button" className={primaryPill} onClick={() => update({ step: 3 })}>
                Continue
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            )}
            {step === 3 && (
              <button type="button" className={primaryPill} disabled={!purposeValid} onClick={reviewTeam}>
                {team.length && draft.proposalGoal === proposalGoal ? "Review saved proposal" : "Suggest my team"}
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            )}
            {step === 4 && (
              <button type="button" className={primaryPill} disabled={!teamValid || saving} onClick={() => void approve()}>
                {saving && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
                Approve and create workspace
              </button>
            )}
          </div>
        </footer>
      </section>
    </main>
  );
}
