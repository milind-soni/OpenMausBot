import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { CONFIG_PATCH_FIELDS, DATA_DIR } from "../config.ts";
import type { RequestAuth } from "../request-auth.ts";
import { patchMayChangeEngineStatus } from "./config-engine-effect.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./config.ts";

describe("which config patches can change an engine's status", () => {
  it("is none of what the app shows, or the names and text that go into prompts", () => {
    for (const patch of [
      { onboarding: { hintsSeen: ["welcome"], reelSeen: true, completedAt: "2026-11-20", version: 3, firstTurnAt: "2026-11-20" } },
      { profile: { name: "Ada", email: "ada@example.test", aboutMe: "I write compilers", avatarUrl: "" } },
      { features: { showToolCalls: true } },
      { language: "de" },
      { computerName: "Desk" },
      { everyBotRules: "Be brief." },
      { language: "de", onboarding: { reelSeen: true }, features: { showToolCalls: false, browser: undefined }, tts: undefined },
      {},
    ]) expect(patchMayChangeEngineStatus(patch), JSON.stringify(patch)).toBe(false);
  });

  it("is every other field a patch can carry, whatever it holds", () => {
    const quiet = new Set(["language", "computerName", "everyBotRules", "onboarding", "profile", "features"]);
    const others = Object.keys(CONFIG_PATCH_FIELDS).filter((field) => !quiet.has(field));
    expect(others).toEqual(expect.arrayContaining(["anthropic", "openai", "openaiCompat", "xai", "opencodeGo", "composio", "box", "vps", "tts", "decider", "imageGen", "live", "signIn",
      "defaultModelSelection", "automaticRecovery", "localVm", "browserEngine", "browserProfiles", "threads", "context", "mcp"]));
    for (const field of others) {
      expect(patchMayChangeEngineStatus({ [field]: {} }), field).toBe(true);
      expect(patchMayChangeEngineStatus({ onboarding: { reelSeen: true }, [field]: "" }), `${field} beside a quiet field`).toBe(true);
    }
  });

  it("is a field or a flag nobody has listed yet", () => {
    expect(patchMayChangeEngineStatus({ somethingNew: true })).toBe(true);
    expect(patchMayChangeEngineStatus({ instances: {} })).toBe(true);
    expect(patchMayChangeEngineStatus({ features: { showToolCalls: true, somethingNew: true } })).toBe(true);
    expect(patchMayChangeEngineStatus({ onboarding: { somethingNew: 1 } })).toBe(true);
    expect(patchMayChangeEngineStatus({ profile: { name: "Ada", shell: "/bin/zsh" } })).toBe(true);
    expect(patchMayChangeEngineStatus({ toString: 1 })).toBe(true);
  });

  it("is every engine-facing feature flag", () => {
    for (const flag of ["browser", "claudeUserMcp", "claudeUserSkills", "acpPlanLines", "agentsToolBridge", "skillsLibrary", "sharedComputers"]) {
      expect(patchMayChangeEngineStatus({ features: { [flag]: true } }), flag).toBe(true);
    }
  });

  it("is a quiet field holding something other than its own shape", () => {
    expect(patchMayChangeEngineStatus({ onboarding: null })).toBe(true);
    expect(patchMayChangeEngineStatus({ features: ["showToolCalls"] })).toBe(true);
    expect(patchMayChangeEngineStatus({ profile: "Ada" })).toBe(true);
  });
});

describe("saving config and the engines' status", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });

  const auth = { kind: "owner", via: "loopback", scopes: ["admin", "client"] } as unknown as RequestAuth;

  function routes() {
    let forgotten = 0, broadcasts = 0;
    const busy = () => ({ get: () => false, set: () => {} });
    const deps = {
      store: { bots: [], patchBot: () => null, clearVoiceSelections: () => {} },
      cfg: {},
      registry: { get: () => undefined, forgetSnapshots: () => { forgotten += 1; } },
      sessions: { revalidateEmailSessions: () => {} },
      browserCleanup: { hasPendingProfile: () => false, prepare: () => { throw new Error("no profile is removed here"); }, abort: () => {}, commit: () => { throw new Error("no profile is removed here"); }, ensure: async () => true },
      browserLive: { closeAll: () => {}, closeForSession: () => {} },
      browserRuntime: { heldBy: () => undefined },
      usedBrowserSessions: new Map(),
      closeBrowser: async () => true,
      browserEngineSwitched: () => {},
      decider: { testKey: async () => ({ ok: true }) },
      sharedComputers: { close: () => {} },
      sharedComputerControl: { close: () => {} },
      hostedModels: false,
      cloudHome: false,
      sharedMembership: () => false,
      lendingEnabled: () => true,
      providerConfigs: () => ({}),
      localVmIdleMs: () => 0,
      localVmIdles: new Map(),
      localVmActiveThreads: new Set(),
      localVmLifecycleBusy: new Set(),
      localVmImageBusy: busy(),
      localVmModeChangeBusy: busy(),
      localVmModeChanging: () => () => {},
      providerConfigBusy: busy(),
      computerProviderConfigTransitions: new Set(),
      managedBoatOwners: () => [],
      providerOperationConflict: () => null,
      perBotLocalVmCountForModeChange: async () => 0,
      checkedModelSelection: () => ({ ok: false, status: 400, error: "no engines here" }),
      policyModelRefusal: () => undefined,
      browserSessionSpec: () => ({ command: "", env: {} }),
      configStatus: () => ({}),
      configForAccess: (status: unknown) => status,
      resyncOpenCodeProviderKeys: () => {},
      revokeEngineCapabilities: () => {},
      reloadProviders: async () => {},
      broadcast: () => { broadcasts += 1; },
      drainQueuedSends: () => {},
    } as unknown as ConfigRouteDeps;
    const route = createConfigRoutes(deps);
    const save = async (body: Record<string, unknown>) => {
      const replies: number[] = [];
      await route({
        req: {}, res: {}, url: new URL("http://host/api/config"), path: "/api/config", method: "PUT", auth,
        json: (_res: unknown, status: number) => { replies.push(status); },
        readBody: async () => body,
      } as unknown as Parameters<typeof route>[0]);
      return replies;
    };
    return { save, forgotten: () => forgotten, broadcasts: () => broadcasts, cfg: deps.cfg };
  }

  it("keeps every engine's status through a save of what the app shows", async () => {
    const { save, forgotten, broadcasts, cfg } = routes();
    expect(await save({ onboarding: { hintsSeen: ["welcome"] } })).toEqual([200]);
    expect(await save({ features: { showToolCalls: true } })).toEqual([200]);
    expect(await save({ profile: { name: "Ada" }, language: "de" })).toEqual([200]);
    expect(cfg).toMatchObject({ onboarding: { hintsSeen: ["welcome"] }, features: { showToolCalls: true }, profile: { name: "Ada" }, language: "de" });
    expect(broadcasts()).toBe(3);
    expect(forgotten()).toBe(0);
  });

  it("reads every engine again after a save that can reach one, alone or beside what the app shows", async () => {
    const { save, forgotten } = routes();
    expect(await save({ groq: { url: "http://127.0.0.1:9/v1" } })).toEqual([200]);
    expect(forgotten()).toBe(1);
    expect(await save({ onboarding: { reelSeen: true }, features: { showToolCalls: false, claudeUserMcp: true } })).toEqual([200]);
    expect(forgotten()).toBe(2);
    expect(await save({ context: { autoCompact: false } })).toEqual([200]);
    expect(forgotten()).toBe(3);
  });
});
