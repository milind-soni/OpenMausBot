import type { EffortLevel } from "../../shared/wire";
import type { ModelVariantOption } from "../../shared/runtime-events";

export interface EngineInstall {
  platform?: "darwin" | "win32" | "linux";
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  docsUrl?: string;
  signInCommand?: string;
  needsNode?: boolean;
  managed?: { label: string; downloadBytes: number };
  server?: { package: string };
  settings?: "connections";
}

export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  url?: string;
  icon?: import("../../shared/provider-icon").ProviderIcon;
  readOnly?: boolean;
  trialCredit?: "active" | "used_up" | "ended";
  managed?: { organizationId: string; organizationName: string };
  policy?: { organizationName: string; reason: string };
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    chatgptPlan?: boolean;
    authenticationUnavailableReason?: string;
    account?: { email?: string; organization?: string; method?: "login" | "api-key" };
    version?: string | null;
    update?: {
      title: string;
      message: string;
      command: string;
    };
    billing?: "metered" | "subscription";
    warning?: {
      title: string;
      message: string;
    };
  };
  models: { default: string; options: Array<{ id: string; label: string; custom?: boolean; loaded?: boolean; provider?: string; variants?: ModelVariantOption[] }> };
  capabilities?: {
    computerMcp?: boolean;
    agentsMcp?: boolean;
    composioMcp?: boolean;
    /** the engine can mount the native HighLevel tools (a connected app without Composio) */
    highlevelMcp?: boolean;
    browserMcp?: boolean;
    images?: boolean;
    effortLevels?: readonly EffortLevel[];
    modelVariants?: boolean;
    queueing?: boolean;
    localComputerMcp?: boolean;
    approvalReview?: boolean;
    backgroundText?: boolean;
  };
  access?: "subscription" | "custom" | "api";
  authentication?: { method: "device-code" | "paste-code" | "browser" | "browser-pkce"; signOut?: boolean };
  install?: EngineInstall;
  cli?: string;
  cliDefault?: string;
  cliCandidates?: string[];
  claudeAccount?: { configDir: string; signInCommand: string; signInShell: "powershell" | "sh"; isDefault: boolean };
  freeUpSpace?: boolean;
}
