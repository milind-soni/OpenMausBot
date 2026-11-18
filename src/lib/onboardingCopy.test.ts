import { describe, expect, it } from "vitest";
import {
  ONBOARDING_CONTINUE_WITHOUT_EMAIL,
  ONBOARDING_EMAIL_HELPER,
  ONBOARDING_ENGINES_TITLE,
  ONBOARDING_LOCAL_GUARANTEE,
  ONBOARDING_MIC_DETAIL,
  ONBOARDING_PERMISSIONS_SUBTITLE,
  ONBOARDING_PERMISSIONS_TITLE,
  ONBOARDING_WELCOME_SUBTITLE,
  describeOnboardingEngine,
  isValidOnboardingEmail,
  onboardingEnginesSubtitle,
  resolveOnboardingProfile,
  type OnboardingInstanceRow,
} from "./onboardingCopy";

function makeInstance(
  driverKind: string,
  state: "available" | "unavailable",
  options: { version?: string; authenticated?: boolean } = {},
): OnboardingInstanceRow {
  return {
    instanceId: driverKind,
    driverKind,
    displayName: driverKind,
    snapshot: {
      state,
      version: options.version ?? null,
      authenticated: options.authenticated,
    },
  };
}

describe("onboarding copy and profile helpers", () => {
  it("distinguishes local storage from connected AI processing and qualifies speech transcription", () => {
    expect(ONBOARDING_LOCAL_GUARANTEE).toContain("stores your chats and project folders on the computer running Studio");
    expect(ONBOARDING_LOCAL_GUARANTEE).toContain("connected AI app receives your messages and the relevant content needed");
    expect(ONBOARDING_LOCAL_GUARANTEE).not.toContain("100% Local-First");
    expect(ONBOARDING_WELCOME_SUBTITLE).toContain("real work on your computer");
    expect(ONBOARDING_EMAIL_HELPER).toContain("Optional");
    expect(ONBOARDING_EMAIL_HELPER).toContain("product updates");
    expect(ONBOARDING_CONTINUE_WITHOUT_EMAIL).toBe("Continue without email");
    expect(ONBOARDING_ENGINES_TITLE).toBe("Your AI apps");
    expect(onboardingEnginesSubtitle("this Mac")).toBe(
      "Buddies run on the AI apps already installed on this Mac — here’s what we found.",
    );
    expect(ONBOARDING_PERMISSIONS_TITLE).toBe("Studio permissions");
    expect(ONBOARDING_PERMISSIONS_SUBTITLE).toContain("Optional device access");
    expect(ONBOARDING_PERMISSIONS_SUBTITLE).not.toContain("stays private on this computer");
    expect(ONBOARDING_MIC_DETAIL).toContain("when on-device recognition is available");
    expect(ONBOARDING_MIC_DETAIL).toContain("system speech service");
    expect(ONBOARDING_MIC_DETAIL).not.toContain("transcribed privately on your computer");
  });

  it("supports continuing with or without email", () => {
    expect(isValidOnboardingEmail("alex@example.com")).toBe(true);
    expect(isValidOnboardingEmail("not-an-email")).toBe(false);

    expect(
      resolveOnboardingProfile({
        name: "  Alex   Doe ",
        email: "ALEX@EXAMPLE.COM",
        includeEmail: true,
      }),
    ).toEqual({
      name: "Alex Doe",
      email: "alex@example.com",
    });

    expect(
      resolveOnboardingProfile({
        name: "Alex",
        email: "alex@example.com",
        includeEmail: false,
      }),
    ).toEqual({
      name: "Alex",
      email: "",
    });

    expect(
      resolveOnboardingProfile({
        name: "",
        email: "",
        includeEmail: false,
      }),
    ).toEqual({
      name: "Local User",
      email: "",
    });
  });

  it("describes AI apps with neutral optional wording and hidden command metadata", () => {
    const claudeReady = describeOnboardingEngine(
      "claudeAgent",
      makeInstance("claudeAgent", "available", { version: "1.0.24 (Claude Code)", authenticated: true }),
      false,
    );
    expect(claudeReady).toMatchObject({
      ok: true,
      warn: false,
      title: "Claude Code · 1.0.24",
      detail: "Installed and ready to power your Buddies.",
      command: undefined,
    });

    const claudeSignedOut = describeOnboardingEngine(
      "claudeAgent",
      makeInstance("claudeAgent", "available", { version: "1.0.24", authenticated: false }),
      false,
    );
    expect(claudeSignedOut).toMatchObject({
      ok: false,
      warn: true,
      detail: "Installed. Sign in to your Claude account to connect.",
      command: "claude",
    });

    const claudeMissing = describeOnboardingEngine("claudeAgent", undefined, true);
    expect(claudeMissing).toMatchObject({
      ok: false,
      warn: true,
      detail: "Not installed yet. Claude gives your Buddies deep writing and reasoning capabilities.",
      command: "npm i -g @anthropic-ai/claude-code",
    });

    const codexMissing = describeOnboardingEngine("codex", undefined, false);
    expect(codexMissing).toMatchObject({
      ok: false,
      warn: false,
      detail: "Optional. Gives your Buddies access to OpenAI models.",
      command: "npm i -g @openai/codex",
    });

    const grokMissing = describeOnboardingEngine("grokAgent", undefined, false);
    expect(grokMissing).toMatchObject({
      ok: false,
      warn: false,
      detail: "Optional. Gives your Buddies access to xAI Grok models.",
      command: "curl -fsSL https://x.ai/cli/install.sh | bash",
    });

    const agyMissing = describeOnboardingEngine("antigravityAgent", undefined, false);
    expect(agyMissing).toMatchObject({
      ok: false,
      warn: false,
      detail: "Optional. Advanced multi-agent models from Google.",
      docsUrl: "https://antigravity.google/docs/cli",
    });
  });
});
