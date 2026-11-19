export type OnboardingEngineKind =
  | "claudeAgent"
  | "codex"
  | "grokAgent"
  | "antigravityAgent";

export type OnboardingInstanceSnapshot = {
  state: "available" | "unavailable";
  reason?: string;
  version?: string | null;
  authenticated?: boolean;
  subscriptionPlan?: string;
};

export type OnboardingInstanceRow = {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: OnboardingInstanceSnapshot;
};

export type OnboardingEnginePresentation = {
  kind: OnboardingEngineKind;
  ok: boolean;
  warn: boolean;
  title: string;
  detail: string;
  command?: string;
  docsUrl?: string;
};

export const ONBOARDING_WELCOME_TITLE = "Welcome to Gerer Build Studio";
export const ONBOARDING_WELCOME_SUBTITLE =
  "Buddies that do real work on your computer. Tell us who you are to personalize your workspace.";
export const ONBOARDING_LOCAL_GUARANTEE =
  "Studio stores your chats and project folders on the computer running Studio. When you message a Buddy, the connected AI app receives your messages and the relevant content needed for the requested work under that service's policy.";
export const ONBOARDING_EMAIL_HELPER =
  "Optional — only used if you want occasional product updates.";
export const ONBOARDING_CONTINUE_WITHOUT_EMAIL = "Continue without email";

export const ONBOARDING_ENGINES_TITLE = "Your AI apps";
export function onboardingEnginesSubtitle(hostLabel: string): string {
  return `Buddies run on the AI apps already installed on ${hostLabel} — here’s what we found.`;
}

export const ONBOARDING_PERMISSIONS_TITLE = "Studio permissions";
export const ONBOARDING_PERMISSIONS_SUBTITLE =
  "Optional device access used only when you start the feature. You can change these anytime in Settings.";
export const ONBOARDING_MIC_DETAIL =
  "Speak your messages instead of typing. Speech is transcribed on your computer when on-device recognition is available, or may fall back to your system speech service when unavailable.";

export function isValidOnboardingEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

export function resolveOnboardingProfile(input: {
  name: string;
  email: string;
  includeEmail: boolean;
}): { name: string; email: string } {
  const sanitizedName = input.name.trim().replace(/\s+/g, " ");
  const validEmail = input.includeEmail && isValidOnboardingEmail(input.email);
  const cleanEmail = validEmail ? input.email.trim().toLowerCase() : "";
  const cleanName =
    sanitizedName || (cleanEmail ? cleanEmail.split("@")[0]! : "Local User");
  return {
    name: cleanName,
    email: cleanEmail,
  };
}

export function describeOnboardingEngine(
  kind: OnboardingEngineKind,
  row: OnboardingInstanceRow | undefined,
  noEngines: boolean,
): OnboardingEnginePresentation {
  const available = row?.snapshot.state === "available";
  const ready = available && row?.snapshot.authenticated !== false;
  const needsSignIn = available && row?.snapshot.authenticated === false;
  const version = row?.snapshot.version?.trim() || "";

  switch (kind) {
    case "claudeAgent": {
      const versionTag = version ? ` · ${version.split(" ")[0]}` : "";
      if (available) {
        return {
          kind,
          ok: ready,
          warn: needsSignIn,
          title: `Claude Code${versionTag}`,
          detail: ready
            ? "Installed and ready to power your Buddies."
            : "Installed. Sign in to your Claude account to connect.",
          command: ready ? undefined : "claude",
        };
      }
      return {
        kind,
        ok: false,
        warn: noEngines,
        title: "Claude Code",
        detail:
          "Not installed yet. Claude gives your Buddies deep writing and reasoning capabilities.",
        command: "npm i -g @anthropic-ai/claude-code",
      };
    }

    case "codex": {
      const versionTag = version ? ` · ${version.replace("codex-cli ", "")}` : "";
      if (available) {
        return {
          kind,
          ok: ready,
          warn: needsSignIn,
          title: `Codex${versionTag}`,
          detail: "Installed — your Buddies can use OpenAI Codex models.",
        };
      }
      return {
        kind,
        ok: false,
        warn: false,
        title: "Codex",
        detail: "Optional. Gives your Buddies access to OpenAI models.",
        command: "npm i -g @openai/codex",
      };
    }

    case "grokAgent": {
      const parts = version.split(" ").filter(Boolean);
      const versionTag = parts.length > 0 ? ` · ${parts[1] ?? parts[0]}` : "";
      if (available) {
        return {
          kind,
          ok: ready,
          warn: needsSignIn,
          title: `Grok Build${versionTag}`,
          detail: ready
            ? "Installed and ready — your Buddies can use xAI Grok."
            : "Installed. Sign in to your xAI account to connect.",
          command: ready ? undefined : "grok login",
        };
      }
      return {
        kind,
        ok: false,
        warn: false,
        title: "Grok Build",
        detail: "Optional. Gives your Buddies access to xAI Grok models.",
        command: "curl -fsSL https://x.ai/cli/install.sh | bash",
      };
    }

    case "antigravityAgent": {
      const versionTag = version ? ` · ${version.split(" ")[0]}` : "";
      if (available) {
        return {
          kind,
          ok: ready,
          warn: needsSignIn,
          title: `Antigravity${versionTag}`,
          detail: "Installed — your Buddies can use Google Antigravity.",
        };
      }
      return {
        kind,
        ok: false,
        warn: false,
        title: "Antigravity",
        detail: "Optional. Advanced multi-agent models from Google.",
        docsUrl: "https://antigravity.google/docs/cli",
      };
    }
  }
}
