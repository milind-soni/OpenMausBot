import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  DeepSeekHarnessSettingsView,
  buildDeepSeekHarnessModelProfile,
  createDeepSeekHarnessActionFeedbackMachine,
  createDeepSeekHarnessModelRequestGuard,
  createDeepSeekHarnessSubmissionGate,
  deepSeekHarnessErrorMessage,
  deepSeekHarnessErrorImpact,
  deepSeekHarnessModelScope,
  deepSeekHarnessRecovery,
  filterDeepSeekHarnessModels,
  fromDshReasoningEfforts,
  modelDraftFromCandidate,
  runDeepSeekHarnessInitialLoad,
  toDshReasoningEfforts,
  upsertDeepSeekHarnessModelAndRefresh,
  type DeepSeekHarnessSettingsViewProps,
} from "./DeepSeekHarnessSettings";
import { deepSeekHarnessSettingsInstances } from "./EnginesSettings";
import {
  ApiError,
  DeepSeekHarnessApiError,
  createDeepSeekHarnessActions,
  type DeepSeekHarnessSettingsSnapshot,
  type InstanceInfo,
} from "@/state/store";

const instance: InstanceInfo = {
  instanceId: "deepseekHarness",
  driverKind: "deepseekHarness",
  displayName: "DeepSeek Harness",
  snapshot: { state: "available", authenticated: true },
  models: {
    default: "dsh:b3BlbnJvdXRlcg:Y3VycmVudA",
    options: [
      {
        id: "dsh:b3BlbnJvdXRlcg:Y3VycmVudA",
        label: "OpenRouter: Current Reasoner",
        effortLevels: ["none", "low"],
      },
      { id: "dsh:ZGVlcHNlZWs:Y2hhdA", label: "DeepSeek: Chat" },
    ],
  },
  capabilities: { effortLevels: ["low", "medium", "high"] },
};

const directSettings: DeepSeekHarnessSettingsSnapshot = {
  connection: {
    instanceId: "deepseekHarness",
    transport: "direct",
    baseUrl: "https://backsight-homelab.example.ts.net:10443",
    paired: false,
    hasDeviceCredential: false,
  },
  modelManagement: {
    available: true,
    supported: true,
    providers: [{ provider: "openrouter", displayName: "OpenRouter" }],
  },
};

const noop = () => {};

function props(overrides: Partial<DeepSeekHarnessSettingsViewProps> = {}): DeepSeekHarnessSettingsViewProps {
  return {
    instance,
    settings: directSettings,
    transport: "direct",
    baseUrl: directSettings.connection.baseUrl,
    agentPreset: "",
    pairingLink: "",
    provider: "openrouter",
    search: "",
    candidates: [],
    modelId: "",
    modelName: "",
    contextWindow: "",
    maxTokens: "",
    reasoningLevels: [],
    loading: false,
    pending: null,
    notice: null,
    error: null,
    actionErrorCode: null,
    onTransportChange: noop,
    onBaseUrlChange: noop,
    onAgentPresetChange: noop,
    onPairingLinkChange: noop,
    onProviderChange: noop,
    onSearchChange: noop,
    onModelIdChange: noop,
    onModelNameChange: noop,
    onContextWindowChange: noop,
    onMaxTokensChange: noop,
    onReasoningLevelToggle: noop,
    onSaveConnection: noop,
    onPair: noop,
    onDiscover: noop,
    onChooseCandidate: noop,
    onUpsert: noop,
    onReload: noop,
    ...overrides,
  };
}

function view(overrides: Partial<DeepSeekHarnessSettingsViewProps> = {}) {
  return renderToStaticMarkup(createElement(DeepSeekHarnessSettingsView, props(overrides)));
}

interface InteractiveProps {
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
  "aria-label"?: string;
}

function elements(node: ReactNode): Array<ReactElement<InteractiveProps>> {
  if (!isValidElement<InteractiveProps>(node)) return [];
  return [node, ...Children.toArray(node.props.children).flatMap(elements)];
}

function elementText(node: ReactNode): string {
  if (!isValidElement<InteractiveProps>(node)) return node == null ? "" : String(node);
  return Children.toArray(node.props.children).map(elementText).join("");
}

describe("DeepSeek Harness settings", () => {
  it("selects only DeepSeek Harness instances for driver-specific settings", () => {
    expect(deepSeekHarnessSettingsInstances([
      instance,
      { ...instance, instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude" },
    ])).toEqual([instance]);
  });

  it("renders accessible Direct and Paired controls for an explicit remote origin", () => {
    const markup = view();

    expect(markup).toContain("DeepSeek Harness");
    expect(markup).toContain('aria-label="DeepSeek Harness connection mode"');
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Direct/);
    expect(markup).toMatch(/aria-pressed="false"[^>]*>Paired/);
    expect(markup).toContain('aria-label="DeepSeek Harness base URL"');
    expect(markup).toContain("https://backsight-homelab.example.ts.net:10443");
    expect(markup).toContain("Tailscale");
    expect(markup).not.toMatch(/tunnel|127\.0\.0\.1/i);
  });

  it("prioritizes runtime availability over a reachable management endpoint and recovers", () => {
    const unavailable = view({
      instance: { ...instance, snapshot: { state: "unavailable", reason: "DeepSeek Harness host is unavailable" } },
    });
    expect(unavailable).toContain("Provider runtime unavailable");
    expect(unavailable).toContain("DeepSeek Harness host is unavailable");
    expect(unavailable).not.toContain("Host API connected");

    const recovered = view();
    expect(recovered).toContain("Host API connected");
    expect(recovered).not.toContain("Provider runtime unavailable");

    const unsafeReason = view({
      instance: { ...instance, snapshot: { state: "unavailable", reason: "api_key=must-not-render" } },
    });
    expect(unsafeReason).toContain("DeepSeek Harness cannot run agent turns right now.");
    expect(unsafeReason).not.toContain("must-not-render");
  });

  it("keeps pairing credentials out of rendered success and revoked states", () => {
    const revoked: DeepSeekHarnessSettingsSnapshot = {
      connection: {
        instanceId: "deepseekHarness",
        transport: "paired",
        baseUrl: "https://dsh.example.test:10443",
        paired: true,
        hasDeviceCredential: true,
      },
      modelManagement: {
        available: false,
        supported: true,
        providers: [],
        reasonCode: "paired-device-unauthorized",
        reason: "Pair this DeepSeek Harness again to restore model management.",
      },
    };
    const markup = view({
      settings: revoked,
      transport: "paired",
      pairingLink: "",
    });

    expect(markup).toContain('aria-label="DeepSeek Harness pairing link"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain("Pair again");
    expect(markup).toContain("Device access was revoked");
    expect(markup).not.toMatch(/deviceCookie|dsh_pair|pair=secret/i);
  });

  it("explains the older paired plugin without disabling chat", () => {
    const settings: DeepSeekHarnessSettingsSnapshot = {
      connection: { ...directSettings.connection, transport: "paired", paired: true, hasDeviceCredential: true },
      modelManagement: {
        available: false,
        supported: false,
        providers: [],
        reasonCode: "paired-plugin-update-required",
        reason: "Update @linxin666/dsh-remote-web-ui to manage models.",
      },
    };
    const markup = view({ settings, transport: "paired" });

    expect(markup).toContain("Update the paired web UI plugin");
    expect(markup).toContain("Chat and configured models still work");
    expect(markup).toContain("@linxin666/dsh-remote-web-ui");
  });

  it("shows configured models, exact effort metadata, discovery search, and custom-id fallback", () => {
    const candidates = [
      { id: "deepseek/deepseek-v3.1", name: "DeepSeek V3.1" },
      { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
    ];
    const markup = view({
      candidates: filterDeepSeekHarnessModels(candidates, "deepseek"),
      search: "deepseek",
      modelId: "openrouter/new-model",
      modelName: "New model",
      contextWindow: "131072",
      maxTokens: "8192",
      reasoningLevels: ["none", "low"],
    });

    expect(markup).toContain("Configured models");
    expect(markup).toContain("OpenRouter: Current Reasoner");
    expect(markup).toContain("DeepSeek V3.1");
    expect(markup).not.toContain("Claude Sonnet 4");
    expect(markup).toContain('aria-label="Search discovered models"');
    expect(markup).toContain('aria-label="Custom model ID"');
    expect(markup).toContain('aria-label="Context window tokens"');
    expect(markup).toContain('aria-label="Maximum output tokens"');
    expect(markup).toContain('aria-label="Reasoning level None"');
    expect(markup).toContain('aria-label="Reasoning level Low"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain("Only select levels this model actually supports");
  });

  it("explains zero eligible pi-ai providers instead of showing a green dead form", () => {
    const settings: DeepSeekHarnessSettingsSnapshot = {
      connection: directSettings.connection,
      modelManagement: { available: true, supported: true, providers: [] },
    };
    const markup = view({ settings, provider: "" });

    expect(markup).toContain("No configurable pi-ai provider");
    expect(markup).toContain("Configure and activate a pi-ai provider in DSH");
    expect(markup).not.toContain("Host API connected");
    expect(markup).not.toContain('aria-label="DeepSeek Harness model provider"');
  });

  it("reuses a retained paired credential and supports keyboard pairing", () => {
    const onSaveConnection = vi.fn();
    const reusable = { ...directSettings, connection: { ...directSettings.connection, hasDeviceCredential: true } };
    const tree = DeepSeekHarnessSettingsView(props({
      settings: reusable,
      transport: "paired",
      pairingLink: "https://dsh.example.test/m/?pair=one-time",
      onSaveConnection,
    }));
    const controls = elements(tree);
    const save = controls.find((element) => element.type === "button" && elementText(element).includes("Save settings"));
    save!.props.onClick!();
    expect(onSaveConnection).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(tree)).toContain("Reuse the existing paired device");

    const onPair = vi.fn();
    const pairingTree = DeepSeekHarnessSettingsView(props({ transport: "paired", pairingLink: "https://dsh.example.test/m/?pair=one-time", onPair }));
    const input = elements(pairingTree).find((element) => element.type === "input" && element.props["aria-label"] === "DeepSeek Harness pairing link");
    const pairingLabel = elements(pairingTree).find((element) => element.type === "label" && elementText(element).includes("Pairing link"));
    const preventDefault = vi.fn();
    input!.props.onKeyDown!({ key: "Enter", preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onPair).toHaveBeenCalledOnce();
    expect(elements(pairingLabel).some((element) => element.type === "button")).toBe(false);
  });

  it("blocks invalid numeric metadata with accessible field errors", () => {
    const tree = DeepSeekHarnessSettingsView(props({ modelId: "custom/model", contextWindow: "1.5", maxTokens: "10000001" }));
    const markup = renderToStaticMarkup(tree);
    const save = elements(tree).find((element) => element.type === "button" && elementText(element).includes("Save model"));

    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain("Context window must be a whole number from 1 to 10,000,000.");
    expect(markup).toContain("Maximum output must be a whole number from 1 to 10,000,000.");
    expect(save?.props.disabled).toBe(true);
  });

  it.each([
    ["paired-device-unauthorized", "Device access was revoked"],
    ["paired-plugin-update-required", "Update the paired web UI plugin"],
    ["provider-not-eligible", "Provider is no longer eligible"],
    ["model-update-conflict", "Model catalog changed"],
  ] as const)("does not leave a stale green status after %s", (code, copy) => {
    const markup = view({ actionErrorCode: code });
    expect(markup).toContain(copy);
    expect(markup).not.toContain("Host API connected");
  });

  it.each([
    ["model-update-rejected", "DSH rejected this model update"],
    ["request-failed", "DeepSeek Harness request failed"],
    ["host-unavailable", "DeepSeek Harness is unreachable"],
  ] as const)("preserves the healthy model editor after local %s action feedback", (code, copy) => {
    const markup = view({ actionErrorCode: code, error: deepSeekHarnessErrorMessage(code) });

    expect(markup).toContain("Host API connected");
    expect(markup).toContain('aria-label="DeepSeek Harness model provider"');
    expect(markup).toContain('aria-label="Custom model ID"');
    expect(markup).toContain(copy);
  });

  it("gates model actions when paired mode has no approved device", () => {
    const markup = view({ actionErrorCode: "pairing-required", error: deepSeekHarnessErrorMessage("pairing-required") });

    expect(markup).toContain("Connection needs attention");
    expect(markup).toContain("No approved paired device is stored");
    expect(markup).not.toContain('aria-label="DeepSeek Harness model provider"');
    expect(markup).toContain('aria-label="DeepSeek Harness base URL"');
  });

  it("renders bounded progress, catalog-refresh, and error feedback", () => {
    expect(view({ pending: "discover" })).toContain("Discovering models…");
    expect(view({ notice: "Model catalog refreshed." })).toContain('role="status"');
    expect(view({ notice: "Model catalog refreshed." })).toContain("Model catalog refreshed.");
    expect(view({ error: "DeepSeek Harness is offline." })).toContain('role="alert"');
    expect(view({ error: "DeepSeek Harness is offline." })).toContain("DeepSeek Harness is offline.");
  });
});

describe("DeepSeek Harness settings actions", () => {
  it("branches on stable error codes and refreshes invalidating transitions", () => {
    expect(deepSeekHarnessErrorMessage("provider-not-eligible")).toMatch(/not eligible.*refresh/i);
    expect(deepSeekHarnessErrorMessage("model-update-conflict")).toMatch(/catalog was refreshed/i);
    for (const code of ["paired-device-unauthorized", "paired-plugin-update-required", "provider-not-eligible", "model-update-conflict"] as const) {
      expect(deepSeekHarnessRecovery(code)).toEqual({ invalidateModels: true, refreshSettings: true });
    }
  });

  it("keeps rejected upserts and transient discovery failures local to the editor", () => {
    const feedback = createDeepSeekHarnessActionFeedbackMachine();

    const upsert = feedback.begin();
    expect(feedback.fail(upsert, "model-update-rejected")).toBe(true);
    expect(feedback.snapshot()).toMatchObject({ code: "model-update-rejected" });
    expect(deepSeekHarnessErrorImpact("model-update-rejected")).toEqual({
      blocksModelEditor: false,
      refreshSettings: false,
      invalidateModels: false,
    });

    const discover = feedback.begin();
    expect(feedback.fail(discover, "request-failed")).toBe(true);
    expect(feedback.snapshot()).toMatchObject({ code: "request-failed" });
    expect(deepSeekHarnessErrorImpact("request-failed").blocksModelEditor).toBe(false);
  });

  it.each(["provider-not-eligible", "model-update-conflict"] as const)(
    "clears stale %s feedback after refresh and rejects the old action completion",
    (code) => {
      const feedback = createDeepSeekHarnessActionFeedbackMachine();
      const action = feedback.begin();
      expect(deepSeekHarnessErrorImpact(code)).toMatchObject({
        blocksModelEditor: true,
        refreshSettings: true,
        invalidateModels: true,
      });

      const refresh = feedback.begin();
      expect(feedback.succeed(refresh)).toBe(true);
      expect(feedback.fail(action, code)).toBe(false);
      expect(feedback.snapshot()).toEqual({ code: null, error: null });
    },
  );

  it("gives distinct actionable recovery copy for every pairing failure", () => {
    expect(deepSeekHarnessErrorMessage("pairing-required")).toBe(
      "No approved paired device is stored. Paste a pairing link generated by DSH to connect this device.",
    );
    expect(deepSeekHarnessErrorMessage("pairing-unavailable")).toBe(
      "OpenMausBot could not reach the DSH pairing endpoint. Check the base URL and network or Tailscale access, then retry.",
    );
    expect(deepSeekHarnessErrorMessage("pairing-rejected")).toBe(
      "DSH rejected this pairing link or token because it is invalid or expired. Generate a fresh pairing link and try again.",
    );
  });

  it("invalidates host, provider, and pairing scopes and rejects a stale discovery response", () => {
    const hostA = deepSeekHarnessModelScope(directSettings, "openrouter", 0);
    const hostB = deepSeekHarnessModelScope({
      ...directSettings,
      connection: { ...directSettings.connection, baseUrl: "https://host-b.example.test" },
    }, "openrouter", 0);
    const pairedTransport = deepSeekHarnessModelScope({
      ...directSettings,
      connection: { ...directSettings.connection, transport: "paired", paired: true, hasDeviceCredential: true },
    }, "openrouter", 0);
    const providerB = deepSeekHarnessModelScope(directSettings, "another-provider", 0);
    const repaired = deepSeekHarnessModelScope(directSettings, "openrouter", 1);
    expect(new Set([hostA, hostB, pairedTransport, providerB, repaired]).size).toBe(5);

    const guard = createDeepSeekHarnessModelRequestGuard();
    const requestA = guard.issue(hostA);
    guard.invalidate();
    expect(guard.accept(requestA, hostA)).toBe(false);
    const requestB = guard.issue(hostB);
    expect(guard.accept(requestB, hostB)).toBe(true);
    expect(guard.accept(requestB, providerB)).toBe(false);

    let visibleModels = ["host-b/model"];
    expect(guard.commit(requestA, hostB, () => {
      visibleModels = ["late-host-a/model"];
    })).toBe(false);
    expect(visibleModels).toEqual(["host-b/model"]);
  });

  it("claims a settings write once until the current request settles", () => {
    const gate = createDeepSeekHarnessSubmissionGate();

    expect(gate.claim()).toBe(true);
    expect(gate.claim()).toBe(false);
    gate.release();
    expect(gate.claim()).toBe(true);
  });

  it("lets the surviving Strict Mode effect settle the initial load", async () => {
    const calls: boolean[] = [];
    const settled: string[] = [];
    let firstCurrent = true;
    let releaseFirst = () => {};
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const stale = runDeepSeekHarnessInitialLoad(
      async (showPending) => { calls.push(showPending); await first; return "stale"; },
      () => firstCurrent,
      () => settled.push("stale"),
    );
    firstCurrent = false;
    await runDeepSeekHarnessInitialLoad(
      async (showPending) => { calls.push(showPending); return "success"; },
      () => true,
      () => settled.push("current"),
    );
    releaseFirst();
    await stale;

    expect(calls).toEqual([false, false]);
    expect(settled).toEqual(["current"]);
  });

  it("pairs with the one-time link and never returns or requests a cookie", async () => {
    const request = vi.fn(async () => ({ paired: true as const, deviceCookie: "must-not-reach-react" }));
    const actions = createDeepSeekHarnessActions(request);
    const result = await actions.pair("deepseekHarness", "https://dsh.example.test/m/?pair=secret-once");

    expect(result).toEqual({ paired: true });
    expect(request).toHaveBeenCalledWith(
      "/api/instances/deepseekHarness/deepseek-harness/pair",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ pairingLink: "https://dsh.example.test/m/?pair=secret-once" }),
      }),
    );
    expect(JSON.stringify(result)).not.toMatch(/secret-once|cookie|must-not-reach-react/i);
  });

  it("preserves stable domain error codes while redacting the server message", async () => {
    const actions = createDeepSeekHarnessActions(vi.fn(async () => {
      throw new ApiError("upstream api_key=must-not-render", "paired-device-unauthorized");
    }));

    const failure = await actions.discover("deepseekHarness", "openrouter").catch((error) => error);
    expect(failure).toBeInstanceOf(DeepSeekHarnessApiError);
    expect(failure).toMatchObject({ code: "paired-device-unauthorized" });
    expect(failure.message).not.toContain("must-not-render");
  });

  it("rejects out-of-contract numeric model metadata at the renderer boundary", async () => {
    const actions = createDeepSeekHarnessActions(vi.fn(async () => ({
      models: [{ id: "oversized/model", contextWindow: 10_000_001 }],
    })));

    const failure = await actions.discover("deepseekHarness", "openrouter").catch((error) => error);
    expect(failure).toMatchObject({ code: "invalid-response" });
  });

  it("maps OMB None to DSH off and preserves exact selected levels", () => {
    expect(toDshReasoningEfforts(["none", "minimal", "high"])).toEqual(["off", "minimal", "high"]);
    expect(fromDshReasoningEfforts(["off", "minimal", "high"])).toEqual(["none", "minimal", "high"]);
    expect(toDshReasoningEfforts([])).toBeUndefined();
  });

  it("refreshes the OMB instance catalog only after a successful upsert", async () => {
    const actions = createDeepSeekHarnessActions(vi.fn(async () => ({
      updated: true as const,
      catalog: { groups: [], failures: [] },
    })));
    const refresh = vi.fn(async () => {});

    await upsertDeepSeekHarnessModelAndRefresh(actions, refresh, "deepseekHarness", {
      provider: "openrouter",
      model: { id: "deepseek/deepseek-v3.1", reasoningEfforts: ["off", "high"] },
    });

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("builds bounded optional numeric model metadata and keeps discovered defaults editable", () => {
    expect(buildDeepSeekHarnessModelProfile({
      id: "custom/model",
      name: "Custom",
      contextWindow: "131072",
      maxTokens: "8192",
      reasoningLevels: ["none", "high"],
    })).toEqual({
      ok: true,
      model: {
        id: "custom/model",
        name: "Custom",
        contextWindow: 131_072,
        maxTokens: 8_192,
        reasoningEfforts: ["off", "high"],
      },
    });
    expect(buildDeepSeekHarnessModelProfile({
      id: "custom/model",
      name: "",
      contextWindow: "",
      maxTokens: "",
      reasoningLevels: [],
    })).toEqual({ ok: true, model: { id: "custom/model" } });
    expect(buildDeepSeekHarnessModelProfile({
      id: "custom/model",
      name: "",
      contextWindow: "1.5",
      maxTokens: "10000001",
      reasoningLevels: [],
    })).toMatchObject({ ok: false });
    expect(modelDraftFromCandidate({ id: "live/model", name: "Live", contextWindow: 64_000, maxTokens: 4_096 })).toMatchObject({
      id: "live/model",
      name: "Live",
      contextWindow: "64000",
      maxTokens: "4096",
    });
  });

  it("sends numeric metadata and supports saving retained paired transport", async () => {
    const request = vi.fn(async (path: string) => path.endsWith("/upsert")
      ? { updated: true as const, catalog: { groups: [], failures: [] } }
      : { saved: true, connection: { ...directSettings.connection, transport: "paired", paired: true, hasDeviceCredential: true } });
    const actions = createDeepSeekHarnessActions(request);
    await actions.upsert("deepseekHarness", {
      provider: "openrouter",
      model: { id: "custom/model", contextWindow: 131_072, maxTokens: 8_192 },
    });
    await actions.patch("deepseekHarness", { transport: "paired" });

    expect(request).toHaveBeenCalledWith(
      "/api/instances/deepseekHarness/deepseek-harness/upsert",
      expect.objectContaining({ body: JSON.stringify({ provider: "openrouter", model: { id: "custom/model", contextWindow: 131_072, maxTokens: 8_192 } }) }),
    );
    expect(request).toHaveBeenCalledWith(
      "/api/instances/deepseekHarness/deepseek-harness",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ transport: "paired" }) }),
    );
  });
});
