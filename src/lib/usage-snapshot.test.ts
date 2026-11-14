import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigStatus, InstanceInfo } from "@/state/store";
import {
  APP, CLOUD_COMPUTER_SOURCE, CLOUD_PLAN, CONNECTORS_MODE, DECIDER, EDITION, ENGINE, KEY_PROVIDER, LOCAL_VM_MODE, PLATFORM,
  TRIAL_CREDIT, VOICE,
} from "./analytics-allowlist";
import {
  buildUsageSnapshot, cloudPlanFromAccount, cloudPlanFromSnapshot, type SnapshotState, type UsageInput, type UsageSources,
} from "./usage-snapshot";

const HOSTILE = "sk-ant-api03-HOSTILE-0123456789";
const DAY = Date.parse("2026-10-15T09:00:00.000Z");
const NEXT_DAY = Date.parse("2026-10-16T00:00:01.000Z");

const ph = vi.hoisted(() => ({
  captured: [] as Array<{ event: string; props: Record<string, unknown> }>,
  module: () => ({
    default: {
      init: () => {},
      has_opted_out_capturing: () => false,
      opt_in_capturing: () => {},
      opt_out_capturing: () => {},
      register: () => {},
      unregister: () => {},
      capture: (event: string, props?: Record<string, unknown>) => void ph.captured.push({ event, props: props ?? {} }),
      identify: () => {},
    },
  }),
}));
vi.mock("posthog-js", () => ph.module());

const storage = new Map<string, string>();
const memoryStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
};

beforeEach(() => {
  storage.clear();
  ph.captured = [];
  vi.stubGlobal("localStorage", memoryStorage);
});
afterEach(() => vi.unstubAllGlobals());

const DOCUMENTED = [
  "key_providers", "key_count", "has_boat_key", "cloud_computer_source", "cloud_computers", "team_computers", "bots_cloud_boat",
  "bots_cloud_vps", "bots", "bots_local_vm", "bots_this_computer", "bots_browser", "bots_off", "bots_auto", "rooms", "bot_channels",
  "teams", "routines", "routines_enabled", "routines_cloud", "routines_room_goal", "routines_once", "routines_daily",
  "routines_interval", "routines_cron", "webhooks", "engines", "engine_count", "custom_endpoints", "trial_credit", "apps",
  "apps_connected", "connectors_mode", "local_vm_mode", "vps_configured", "voice", "voice_included", "decider", "decider_included",
  "live_calls", "phones_paired", "paired_devices", "phone_paired", "members", "cloud_home", "cloud_plan", "cloud_trial", "edition",
  "org_managed", "onboarded", "first_turn", "platform", "remote_client",
];

const WORDS: Record<string, readonly string[]> = {
  key_providers: KEY_PROVIDER, cloud_computer_source: CLOUD_COMPUTER_SOURCE, engines: [...ENGINE, "other"], trial_credit: TRIAL_CREDIT,
  apps: [...APP, "other"], connectors_mode: [...CONNECTORS_MODE, "other"], local_vm_mode: [...LOCAL_VM_MODE, "other"],
  voice: [...VOICE, "other"], decider: [...DECIDER, "other"], cloud_plan: CLOUD_PLAN, edition: [...EDITION, "other"], platform: PLATFORM,
};

function expectOnlyCountsFlagsAndWords(props: Record<string, unknown>) {
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "number") expect(Number.isInteger(value) && value >= 0, key).toBe(true);
    else if (typeof value === "string") expect(WORDS[key], key).toContain(value);
    else if (Array.isArray(value)) for (const word of value) expect(WORDS[key], key).toContain(word);
    else expect(typeof value, key).toBe("boolean");
  }
}

const instance = (instanceId: string, driverKind: string, extra: Record<string, unknown> = {}) => ({
  instanceId, driverKind, displayName: HOSTILE,
  snapshot: { state: "available", authenticated: true, account: { email: `${HOSTILE}@example.com`, organization: HOSTILE }, version: HOSTILE },
  models: { default: HOSTILE, options: [{ id: HOSTILE, label: HOSTILE }] },
  ...extra,
}) as unknown as InstanceInfo;

const hostileBot = (computer?: string, cloudBackend?: string) =>
  ({ id: HOSTILE, threadId: HOSTILE, name: HOSTILE, title: HOSTILE, description: HOSTILE, soul: HOSTILE, cwd: `/Users/${HOSTILE}`, computer, cloudBackend });

function hostileState(): SnapshotState {
  return {
    config: {
      anthropic: { configured: true, everyClaudeBot: false }, openai: { configured: false }, openrouter: { configured: false },
      openaiCompat: { configured: true, url: `https://${HOSTILE}.example.com/v1` }, xai: { configured: false },
      composio: { configured: true, mode: "self-hosted" }, box: { configured: true },
      vps: { configured: true, sshAlias: HOSTILE }, rooms: { turnTimeoutMinutes: 30 }, localVm: { mode: "per-bot", maxInstances: 2 },
      opencodeGo: { configured: true, providerKeys: [HOSTILE] },
      tts: { configured: true, ready: true, voice: HOSTILE, provider: "fish" },
      decider: { provider: "jev", model: HOSTILE, configured: true, enabled: true, jobs: { roomRouting: true } },
      live: { configured: true, keySource: "live", voice: HOSTILE, readTypedReplies: false, idleMinutes: 5 },
      imageGen: { configured: true, provider: "custom", model: HOSTILE, customUrl: `https://${HOSTILE}.example.com`, customModel: HOSTILE, customKeyConfigured: true },
      profile: { name: HOSTILE, email: `${HOSTILE}@example.com`, aboutMe: HOSTILE },
      language: "ja",
      edition: { edition: "enterprise", features: [HOSTILE] },
      managedPolicy: { organizationName: HOSTILE, version: 1, companyModelsOnly: false, allowedEngines: [HOSTILE], mcp: { allowCustom: false, allowlist: [HOSTILE] }, computers: { thisComputer: true, localVm: true, box: true, vps: true }, remoteAccess: true },
      browserProfiles: [{ id: HOSTILE, name: HOSTILE }],
      onboarding: { completedAt: "2026-10-01T00:00:00.000Z", version: 1, reelSeen: true, hintsSeen: [HOSTILE], firstTurnAt: "2026-10-01T00:05:00.000Z" },
    } as unknown as ConfigStatus,
    instances: [
      instance("claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c", "claudeAgent"),
      instance("claude", "claudeAgent"),
      instance("openai-compat-0a3a6f1e-2b7c-4c55-8a51-3f0c2b1e9d1a", "openai-compat", { url: `https://${HOSTILE}.example.com/v1` }),
      instance(HOSTILE, HOSTILE, { trialCredit: "used_up" }),
      instance("codex", "codex", { snapshot: { state: "unavailable", reason: HOSTILE } }),
    ],
    bots: [
      hostileBot("cloud"), hostileBot("cloud", "box"), hostileBot("cloud", "vps"), hostileBot("vm"), hostileBot("local"), hostileBot("browser"),
      hostileBot("off"), hostileBot(), hostileBot(),
    ] as unknown as SnapshotState["bots"],
    groups: [{ id: HOSTILE, name: HOSTILE, bulletin: HOSTILE, dm: false }, { id: HOSTILE, name: HOSTILE, dm: true }, { id: HOSTILE, name: HOSTILE }] as unknown as SnapshotState["groups"],
    sections: [HOSTILE, "Ops"],
    routines: [
      { name: HOSTILE, prompt: HOSTILE, enabled: true, runOn: "cloud", target: "bot", schedule: { type: "cron", expression: HOSTILE, timeZone: HOSTILE } },
      { name: HOSTILE, prompt: HOSTILE, enabled: false, runOn: "maus", target: "room-goal", schedule: { type: "daily", time: "09:00", weekdays: [1] } },
      { name: HOSTILE, prompt: HOSTILE, enabled: true, runOn: "maus", target: "bot", schedule: { type: "once", at: 1 } },
      { name: HOSTILE, prompt: HOSTILE, enabled: true, runOn: "maus", target: "bot", schedule: { type: "interval", everyMinutes: 60, anchorAt: 0 } },
    ] as unknown as SnapshotState["routines"],
    routinesLoadState: "ready",
    webhooks: [{ id: HOSTILE, name: HOSTILE }] as unknown as SnapshotState["webhooks"],
    webhookIngress: { url: `https://${HOSTILE}.example.com/hooks` } as unknown as SnapshotState["webhookIngress"],
  };
}

function hostileSources(overrides: Partial<UsageSources> = {}): UsageSources & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    request: async <T,>(path: string) => {
      calls.push(path);
      if (path === "/api/auth/sessions") {
        return {
          current: "this-session",
          sessions: [
            { id: "this-session", label: HOSTILE, email: "Owner@Example.com" },
            { id: HOSTILE, label: HOSTILE },
            { id: "s3", label: HOSTILE, email: `${HOSTILE}@example.com` },
            { id: "s4", label: HOSTILE, email: "owner@example.com" },
            { id: "s5", label: HOSTILE, email: `${HOSTILE}@example.com` },
            { id: "s6", label: `${HOSTILE}'s iPhone` },
            null,
          ],
        } as T;
      }
      if (path === "/api/computers/usage") return { cloudComputers: 3, teamComputers: 1 } as T;
      throw new Error(`unexpected ${path}`);
    },
    connectedApps: async () => {
      calls.push("connectedApps");
      return {
        authoritative: true,
        services: JSON.parse(JSON.stringify({
          gmail: { connected: true, accounts: [{ id: HOSTILE, alias: HOSTILE, status: "ACTIVE" }] },
          "evil.example.com": { connected: true },
          [HOSTILE]: { connected: true },
          slack: { connected: true, accounts: [{ id: HOSTILE, status: "EXPIRED" }] },
          notion: { connected: false },
        }).replace("{", '{"__proto__":{"connected":true},')),
      };
    },
    companion: { state: async () => { calls.push("companion"); return { devices: [{ id: HOSTILE, name: HOSTILE }, { id: "p2", name: "Ada's iPhone" }] }; } },
    cloudAccount: {
      state: async () => {
        calls.push("cloudAccount");
        return {
          status: "connected", account: { id: HOSTILE, email: `${HOSTILE}@example.com` }, deviceId: HOSTILE,
          entitlement: { plan: "pro", tier: "max", status: "active", expiresAt: null, version: 1 },
          trial: { state: "active", tier: "max", endsAt: 1, amount: 9900, chargeAt: 1, holdUntil: null },
          machine: { status: "ready", origin: `https://${HOSTILE}.mausbot.cloud` },
        } as never;
      },
    },
    cloudPlan: { state: async () => { calls.push("cloudPlan"); return { status: "none" }; } },
    platform: "desktop",
    remoteClient: false,
    ...overrides,
  };
}

async function freshModules() {
  vi.resetModules();
  vi.doMock("posthog-js", () => ph.module());
  const analytics = await import("./analytics");
  const snapshot = await import("./usage-snapshot");
  await analytics.initAnalytics();
  return { analytics, snapshot };
}

const snapshots = () => ph.captured.filter(({ event }) => event === "app_snapshot").map(({ props }) => props);

describe("the daily usage snapshot", () => {
  it("counts what is set up from a workspace full of names, keys, ids and addresses, and sends none of them", async () => {
    const { snapshot } = await freshModules();
    expect(await snapshot.sendDailySnapshot(hostileState(), hostileSources(), DAY)).toBe(true);
    const [sent] = snapshots();
    expect(sent).toEqual({
      key_providers: ["anthropic", "openai_compat", "boat", "composio", "opencode_go", "fish_audio", "jev", "custom_image", "openai_live"],
      key_count: 9, has_boat_key: true, cloud_computer_source: "own_key", cloud_computers: 3, team_computers: 1,
      bots_cloud_boat: 2, bots_cloud_vps: 1, bots: 9, bots_local_vm: 1, bots_this_computer: 1, bots_browser: 1, bots_off: 1, bots_auto: 2,
      rooms: 2, bot_channels: 1, teams: 2,
      routines: 4, routines_enabled: 3, routines_cloud: 1, routines_room_goal: 1, routines_once: 1, routines_daily: 1, routines_interval: 1, routines_cron: 1,
      webhooks: 1, engines: ["claude", "openai_compat", "other"], engine_count: 4, custom_endpoints: 1, trial_credit: "used_up",
      apps: ["gmail", "other"], apps_connected: 4, connectors_mode: "self_hosted", local_vm_mode: "per_bot", vps_configured: true,
      voice: "fish", voice_included: false, decider: "jev", decider_included: false, live_calls: true,
      phones_paired: 2, paired_devices: 2, phone_paired: true, members: 1,
      cloud_home: false, cloud_plan: "max", cloud_trial: true, edition: "enterprise", org_managed: true, onboarded: true, first_turn: true,
      platform: "desktop", remote_client: false,
    });
    expect(Object.keys(sent!).sort()).toEqual([...DOCUMENTED].sort());
    expectOnlyCountsFlagsAndWords(sent!);
    const wire = JSON.stringify(ph.captured);
    for (const fragment of [HOSTILE, "HOSTILE", "example.com", "mausbot.cloud", "iPhone", "Owner", "3f0c2b1e", "/Users/"]) expect(wire).not.toContain(fragment);
  });

  it("sends once per UTC day, writing the day before it gathers, and again after midnight", async () => {
    const { snapshot } = await freshModules();
    let release!: () => void;
    const slow = hostileSources({ connectedApps: () => new Promise((resolve) => { release = () => resolve({ services: {}, authoritative: true }); }) });
    const first = snapshot.sendDailySnapshot(hostileState(), slow, DAY);
    expect(storage.get("omb-analytics-snapshot-day")).toBe("2026-10-15");
    expect(await snapshot.sendDailySnapshot(hostileState(), hostileSources(), DAY + 60_000)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await snapshot.sendDailySnapshot(hostileState(), hostileSources(), DAY + 3_600_000)).toBe(false);
    expect(await snapshot.sendDailySnapshot(hostileState(), hostileSources(), NEXT_DAY)).toBe(true);
    expect(snapshots()).toHaveLength(2);
    expect(storage.get("omb-analytics-snapshot-day")).toBe("2026-10-16");
  });

  it("sends nothing on a page that already sent today, as another window of the same app would have", async () => {
    storage.set("omb-analytics-snapshot-day", "2026-10-15");
    const { snapshot } = await freshModules();
    const sources = hostileSources();
    expect(await snapshot.sendDailySnapshot(hostileState(), sources, DAY)).toBe(false);
    expect(sources.calls).toEqual([]);
    expect(snapshots()).toEqual([]);
  });

  it("sends once per page load when storage throws, through the page's own memory", async () => {
    const { snapshot } = await freshModules();
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(await snapshot.sendDailySnapshot(hostileState(), hostileSources(), DAY)).toBe(true);
    expect(await snapshot.sendDailySnapshot(hostileState(), hostileSources(), DAY + 1_000)).toBe(false);
    expect(await snapshot.sendDailySnapshot(hostileState(), hostileSources(), NEXT_DAY)).toBe(true);
    expect(snapshots()).toHaveLength(2);
  });

  it("waits for the config without spending the day", async () => {
    const { snapshot } = await freshModules();
    const sources = hostileSources();
    expect(await snapshot.sendDailySnapshot({ ...hostileState(), config: null }, sources, DAY)).toBe(false);
    expect(sources.calls).toEqual([]);
    expect(await snapshot.sendDailySnapshot(hostileState(), sources, DAY)).toBe(true);
  });

  it("asks no Boat question and counts no cloud computers without a Boat account", async () => {
    const { snapshot } = await freshModules();
    const state = hostileState();
    const sources = hostileSources();
    await snapshot.sendDailySnapshot({ ...state, config: { ...state.config!, box: { configured: false } } }, sources, DAY);
    expect(sources.calls).not.toContain("/api/computers/usage");
    expect(snapshots()[0]).toMatchObject({ cloud_computer_source: "none", cloud_computers: 0, team_computers: 0, has_boat_key: false });
  });

  it("leaves out what a source could not tell, and still sends the rest", async () => {
    const { snapshot } = await freshModules();
    const fail = async () => { throw new Error("unreachable"); };
    await snapshot.sendDailySnapshot(hostileState(), hostileSources({
      request: fail, connectedApps: fail, companion: { state: fail }, cloudAccount: { state: fail },
    }), DAY);
    const [sent] = snapshots();
    for (const key of ["cloud_computers", "team_computers", "apps", "apps_connected", "phones_paired", "paired_devices", "phone_paired", "members", "cloud_trial"]) {
      expect(sent, key).not.toHaveProperty(key);
    }
    expect(sent).toMatchObject({ cloud_plan: "unknown", bots: 9, key_count: 9 });
  });

  it("reads the plan from a Cloud page's own bridge, and leaves out what only this computer knows", async () => {
    const { snapshot } = await freshModules();
    const sources = hostileSources({
      companion: null, cloudAccount: null, platform: "browser",
      cloudPlan: { state: async () => ({ status: "paid", tier: "pro", trial: { state: "ending", endsAt: 1, amount: null, chargeAt: null, holdUntil: null } } as never) },
    });
    await snapshot.sendDailySnapshot({ ...hostileState(), config: { ...hostileState().config!, cloudHome: true, box: { configured: true, included: true } } }, sources, DAY);
    const [sent] = snapshots();
    expect(sent).toMatchObject({ cloud_plan: "pro", cloud_trial: true, cloud_home: true, cloud_computer_source: "included", platform: "browser", paired_devices: 2, phone_paired: true });
    expect(sent).not.toHaveProperty("phones_paired");
    expect((sent!.key_providers as string[])).not.toContain("boat");
  });
});

describe("an opted-out install", () => {
  it("captures nothing and asks no server, bridge or provider anything", async () => {
    storage.set("omb-analytics-opt-out", "1");
    const { snapshot } = await freshModules();
    const sources = hostileSources();
    const spies = [vi.spyOn(sources, "request"), vi.spyOn(sources, "connectedApps"), vi.spyOn(sources.companion!, "state"), vi.spyOn(sources.cloudAccount!, "state"), vi.spyOn(sources.cloudPlan!, "state")];
    expect(await snapshot.sendDailySnapshot(hostileState(), sources, DAY)).toBe(false);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(ph.captured).toEqual([]);
    expect(storage.has("omb-analytics-snapshot-day")).toBe(false);
  });

  it("drops a snapshot when analytics is switched off while it gathers", async () => {
    const { analytics, snapshot } = await freshModules();
    let release!: () => void;
    const sending = snapshot.sendDailySnapshot(hostileState(), hostileSources({
      connectedApps: () => new Promise((resolve) => { release = () => resolve({ services: {}, authoritative: true }); }),
    }), DAY);
    analytics.setAnalyticsEnabled(false);
    release();
    await sending;
    expect(snapshots()).toEqual([]);
  });
});

describe("what counts as a key, a computer source and an app", () => {
  const minimal = (config: Partial<ConfigStatus> = {}, input: Partial<UsageInput> = {}): UsageInput => ({
    config: { composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" }, rooms: { turnTimeoutMinutes: 30 }, localVm: { mode: "shared", maxInstances: 1 }, ...config } as ConfigStatus,
    instances: [], bots: [], groups: [], routines: [], webhooks: 0, apps: null, sessions: null, companionDevices: null, cloud: null,
    computers: null, platform: "browser", remoteClient: false, ...input,
  });

  it("tells an own Boat key from computers included with a Cloud plan", () => {
    expect(buildUsageSnapshot(minimal({ box: { configured: true } }))).toMatchObject({ has_boat_key: true, cloud_computer_source: "own_key", key_providers: ["boat"] });
    expect(buildUsageSnapshot(minimal({ box: { configured: true, included: true } }))).toMatchObject({ has_boat_key: false, cloud_computer_source: "included", key_providers: [], key_count: 0 });
  });

  it("counts a Composio key only for a self-hosted project, and names the mode either way", () => {
    expect(buildUsageSnapshot(minimal({ composio: { configured: true, mode: "managed" } }))).toMatchObject({ key_providers: [], connectors_mode: "managed" });
    expect(buildUsageSnapshot(minimal({ composio: { configured: true, mode: "self-hosted" } }))).toMatchObject({ key_providers: ["composio"], connectors_mode: "self_hosted" });
  });

  it("leaves a Cloud plan's included voice and decisions out of the keys, and says they are included", () => {
    const sent = buildUsageSnapshot(minimal({
      tts: { configured: true, ready: true, voice: "v", provider: "elevenlabs", included: true },
      decider: { provider: "jev", configured: true, included: true, enabled: true, jobs: { roomRouting: true } },
    }));
    expect(sent).toMatchObject({ key_providers: [], voice: "elevenlabs", voice_included: true, decider: "jev", decider_included: true });
  });

  it("leaves out the cloud computer count it was not told, the apps of an inventory it cannot trust, and lists not loaded", () => {
    const services = { gmail: { connected: true } };
    for (const computers of [null, { cloudComputers: null, teamComputers: 2 }]) {
      const sent = buildUsageSnapshot(minimal({}, { computers, apps: { services, authoritative: false }, routines: null, webhooks: null }));
      expect(sent).not.toHaveProperty("cloud_computers");
      expect(sent).not.toHaveProperty("apps");
      expect(sent).not.toHaveProperty("apps_connected");
      expect(sent).not.toHaveProperty("routines");
      expect(sent).not.toHaveProperty("routines_enabled");
      expect(sent).not.toHaveProperty("webhooks");
    }
    expect(buildUsageSnapshot(minimal({}, { apps: { services, authoritative: true } }))).toMatchObject({ apps: ["gmail"], apps_connected: 1 });
  });

  it("counts one xAI key once, though avatar images can use it too", () => {
    const imageGen = { configured: false, provider: "openai" as const, openaiConfigured: false, xaiConfigured: true, customKeyConfigured: false };
    expect(buildUsageSnapshot(minimal({ xai: { configured: true }, imageGen }))).toMatchObject({ key_providers: ["xai"], key_count: 1 });
  });

  it("counts a separate Live key as openai_live, and Live calls on the OpenAI key from API keys as the openai key only", () => {
    const live = { configured: true, voice: "", readTypedReplies: true, idleMinutes: 5 };
    expect(buildUsageSnapshot(minimal({ openai: { configured: true }, live: { ...live, keySource: "openai" } })))
      .toMatchObject({ key_providers: ["openai"], key_count: 1, live_calls: true });
    expect(buildUsageSnapshot(minimal({ openai: { configured: true }, live: { ...live, keySource: "live" } })))
      .toMatchObject({ key_providers: ["openai", "openai_live"], key_count: 2, live_calls: true });
  });

  it("leaves archived bots out of every bot count", () => {
    const bots = [{ computer: "cloud", hidden: true }, { computer: "cloud", cloudBackend: "vps", hidden: true }, { computer: "local", hidden: false }, { computer: "cloud" }] as UsageInput["bots"];
    expect(buildUsageSnapshot(minimal({}, { bots }))).toMatchObject({ bots: 2, bots_cloud_boat: 1, bots_cloud_vps: 0, bots_this_computer: 1 });
  });

  it("never passes a number the server sent unless it is a count", () => {
    const sent = buildUsageSnapshot(minimal({}, { computers: { cloudComputers: -1, teamComputers: "3" }, companionDevices: 1.5 }));
    expect(sent).not.toHaveProperty("cloud_computers");
    expect(sent).not.toHaveProperty("team_computers");
    expect(sent).not.toHaveProperty("phones_paired");
  });
});

describe("the Cloud plan", () => {
  const trial = { state: "active", tier: "pro", endsAt: 1, amount: 4900, chargeAt: 1, holdUntil: null };
  const entitlement = (patch: Record<string, unknown>) => ({ plan: "pro", status: "active", expiresAt: null, version: 1, ...patch });

  it("reads a desktop's Cloud account: unknown while it cannot tell, none when signed out or not paying", () => {
    expect(cloudPlanFromAccount({ status: "signed-out", message: "restoring" })).toEqual({ plan: "unknown" });
    expect(cloudPlanFromAccount({ status: "signed-out" })).toEqual({ plan: "none" });
    for (const status of ["connecting", "reauth-required", "unavailable"] as const) expect(cloudPlanFromAccount({ status }), status).toEqual({ plan: "unknown" });
    expect(cloudPlanFromAccount(null)).toEqual({ plan: "unknown" });
    const connected = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}) => cloudPlanFromAccount({ status: "connected", entitlement: entitlement(patch), ...extra } as never);
    expect(connected({})).toEqual({ plan: "pro", trial: false });
    expect(connected({ tier: "personal" }, { trial })).toEqual({ plan: "personal", trial: true });
    expect(connected({ tier: "a-tier-from-a-newer-admin" })).toEqual({ plan: "other", trial: false });
    expect(connected({ tier: "max", status: "inactive" })).toEqual({ plan: "none", trial: false });
    expect(connected({ plan: "free" }, { trial })).toEqual({ plan: "none", trial: true });
  });

  it("reads a Cloud page's own plan, where a paid plan whose payment needs attention counts as none", () => {
    expect(cloudPlanFromSnapshot({ status: "paid" })).toEqual({ plan: "pro", trial: false });
    expect(cloudPlanFromSnapshot({ status: "paid", tier: "max" })).toEqual({ plan: "max", trial: false });
    expect(cloudPlanFromSnapshot({ status: "paid", tier: "a-tier-from-a-newer-admin" })).toEqual({ plan: "other", trial: false });
    expect(cloudPlanFromSnapshot({ status: "attention", tier: "pro", trial } as never)).toEqual({ plan: "none", trial: true });
    expect(cloudPlanFromSnapshot({ status: "none" })).toEqual({ plan: "none", trial: false });
    for (const status of ["checking", "signin"] as const) expect(cloudPlanFromSnapshot({ status }), status).toEqual({ plan: "unknown" });
    expect(cloudPlanFromSnapshot(undefined)).toEqual({ plan: "unknown" });
  });
});
