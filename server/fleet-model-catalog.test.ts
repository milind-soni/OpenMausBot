import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ModelOption } from "./contracts.ts";
import {
  DEFAULT_AOS_MODEL_CATALOG_PATH,
  FleetModelCatalogRegistry,
  parseFleetModelCatalog,
  projectFleetModels,
  type FleetModelCatalogSnapshot,
  type ParsedFleetModelCatalog,
} from "./fleet-model-catalog.ts";

interface ProjectionStatus {
  configured: boolean;
  reachable: boolean;
  verified: boolean;
  admitted: boolean;
  busy: boolean;
  reason: string | null;
  last_verification_receipt: string | null;
}

interface ProjectionModel {
  id: string;
  display_name: string;
  kind: "model" | "route_group";
  provider_id: string;
  native_model_id: string | null;
  capabilities: string[];
  host: "hosted" | "mac" | "windows";
  cost_class: "paid_subscription" | "paid_metered" | "free" | "local";
  manual_only: boolean;
  is_default: boolean;
  selectable: boolean;
  status: ProjectionStatus;
  translations: {
    litellm: string | null;
    hermes: string | null;
    opencode: string | null;
    telegram: string | null;
    openmausbot: string | null;
  };
  route_members: string[];
}

interface ProjectionFixture {
  schema_version: "openmausbot-models/v1";
  catalog_version: number;
  generated_at: string;
  source: {
    registry_schema_version: string;
    registry_version: number;
    registry_sha256: string;
  };
  provider_candidates: Array<{
    provider_id: string;
    display_name: string;
    configured: boolean;
    selectable: boolean;
    reason: "unverified_provider_or_model";
  }>;
  default_model_id: string;
  models: ProjectionModel[];
}

function concreteModel(id: string, overrides: Partial<ProjectionModel> = {}): ProjectionModel {
  return {
    id,
    display_name: id,
    kind: "model",
    provider_id: "minimax",
    native_model_id: id,
    capabilities: ["chat"],
    host: "hosted",
    cost_class: "paid_subscription",
    manual_only: true,
    is_default: false,
    selectable: false,
    status: {
      configured: true,
      reachable: false,
      verified: false,
      admitted: false,
      busy: false,
      reason: "fresh admission receipt required",
      last_verification_receipt: null,
    },
    translations: {
      litellm: id,
      hermes: `litellm-local:${id}`,
      opencode: `litellm-local/${id}`,
      telegram: id,
      openmausbot: id,
    },
    route_members: [],
    ...overrides,
  };
}

function baseCatalog(): ProjectionFixture {
  const group = concreteModel("MiniMax-M3", {
    display_name: "MiniMax M3",
    kind: "route_group",
    native_model_id: "MiniMax-M3",
    capabilities: ["chat", "tool_use"],
    manual_only: false,
    is_default: true,
    selectable: true,
    status: {
      configured: true,
      reachable: true,
      verified: true,
      admitted: true,
      busy: false,
      reason: null,
      last_verification_receipt: "/receipt/group.json",
    },
    route_members: ["minimax-m3-light"],
  });
  const light = concreteModel("minimax-m3-light", {
    display_name: "MiniMax M3 — Lightcloud007",
    native_model_id: "MiniMax-M3",
  });
  return {
    schema_version: "openmausbot-models/v1",
    catalog_version: 7,
    generated_at: "2026-08-22T05:00:00Z",
    source: {
      registry_schema_version: "aos-model-registry/v1",
      registry_version: 12,
      registry_sha256: "a".repeat(64),
    },
    provider_candidates: [{
      provider_id: "candidate-provider",
      display_name: "Candidate Provider",
      configured: true,
      selectable: false,
      reason: "unverified_provider_or_model",
    }],
    default_model_id: "MiniMax-M3",
    models: [group, light],
  };
}

function projection(mutate?: (catalog: ProjectionFixture) => void): string {
  const catalog = baseCatalog();
  mutate?.(catalog);
  return JSON.stringify(catalog);
}

function readySnapshot(parsed: ParsedFleetModelCatalog): FleetModelCatalogSnapshot {
  return {
    schema: "openmausbot-models/v1",
    source: { path: "/fixture", state: "ready", refreshedAt: "now" },
    models: parsed.models,
    providerCandidates: parsed.providerCandidates,
  };
}

function emptyOptions(): ModelOption[] {
  return [];
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseFleetModelCatalog", () => {
  it("accepts the locked v1 projection and maps Hermes/OpenCode ids", () => {
    const catalog = parseFleetModelCatalog(projection());
    expect(catalog).toMatchObject({
      catalogVersion: 7,
      registrySchemaVersion: "aos-model-registry/v1",
      registryVersion: 12,
    });
    expect(catalog.models[0]).toMatchObject({
      canonicalId: "MiniMax-M3",
      kind: "route_group",
      costClass: "paid_subscription",
      default: true,
      translations: [
        { driverKind: "hermesAgent", modelId: "litellm-local:MiniMax-M3" },
        { driverKind: "opencodeGo", modelId: "litellm-local/MiniMax-M3" },
      ],
      routeMembers: ["minimax-m3-light"],
    });
    expect(catalog.providerCandidates).toEqual([{
      providerId: "candidate-provider",
      label: "Candidate Provider",
      configured: true,
      selectable: false,
      reason: "unverified_provider_or_model",
    }]);
  });

  it("rejects contradictory selectability, missing group members, and default drift", () => {
    expect(() => parseFleetModelCatalog(projection((catalog) => {
      catalog.models[1]!.selectable = true;
    }))).toThrow("selectable contradicts");
    expect(() => parseFleetModelCatalog(projection((catalog) => {
      catalog.models[0]!.route_members = ["absent"];
    }))).toThrow("route member");
    expect(() => parseFleetModelCatalog(projection((catalog) => {
      catalog.models[0]!.is_default = false;
      catalog.models[1]!.is_default = true;
    }))).toThrow("single is_default row must agree");
    expect(() => parseFleetModelCatalog(projection((catalog) => {
      catalog.provider_candidates[0]!.selectable = true;
    }))).toThrow("must remain false");
  });

  it("accepts a null provider-native id for a disabled inventory-only row", () => {
    const catalog = parseFleetModelCatalog(projection((source) => {
      source.models[1]!.native_model_id = null;
    }));
    expect(catalog.models[1]?.nativeModelId).toBeNull();
  });

  it("rejects divergent schemas, extra credential fields, secret-looking values, and duplicate ids", () => {
    const divergent = Object.assign(baseCatalog(), { schema: "openmausbot-models.v1" });
    expect(() => parseFleetModelCatalog(JSON.stringify(divergent))).toThrow("schema");

    const withKey = Object.assign(baseCatalog(), { api_key: "should-never-be-here" });
    expect(() => parseFleetModelCatalog(JSON.stringify(withKey))).toThrow("api_key");
    const withReference = Object.assign(baseCatalog(), { credential_ref: "logical-name" });
    expect(() => parseFleetModelCatalog(JSON.stringify(withReference))).toThrow("credential_ref");

    const withValue = baseCatalog();
    withValue.models[0]!.display_name = "Bearer definitely-a-secret-value";
    expect(() => parseFleetModelCatalog(JSON.stringify(withValue))).toThrow("credential value");

    const duplicate = baseCatalog();
    duplicate.models.push({ ...duplicate.models[0]! });
    expect(() => parseFleetModelCatalog(JSON.stringify(duplicate))).toThrow("duplicate canonical model id");
  });
});

describe("FleetModelCatalogRegistry", () => {
  it("derives the default catalog path from XDG data home or the current user home", () => {
    const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
    expect(DEFAULT_AOS_MODEL_CATALOG_PATH).toBe(join(
      dataHome,
      "aos-model-catalog",
      "current",
      "openmausbot-models.v1.json",
    ));
  });

  it("keeps the last inventory visible but fail-closes it after an invalid refresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-fleet-catalog-"));
    dirs.push(dir);
    const path = join(dir, "catalog.json");
    writeFileSync(path, projection());
    const registry = new FleetModelCatalogRegistry(path);
    expect(registry.snapshot().source.state).toBe("ready");
    writeFileSync(path, "not json");
    const failed = registry.refresh();
    expect(failed.source.state).toBe("invalid");
    expect(failed.models).toHaveLength(2);
    expect(failed.models.every((model) => model.status.admitted === false)).toBe(true);
  });

  it("applies a registry-bound shared default without mutating active tasks", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-fleet-default-"));
    dirs.push(dir);
    const path = join(dir, "openmausbot-models.v1.json");
    const defaultPath = join(dir, "default-model.v1.json");
    const raw = projection((catalog) => {
      const light = catalog.models[1]!;
      light.selectable = true;
      light.status = {
        configured: true,
        reachable: true,
        verified: true,
        admitted: true,
        busy: false,
        reason: null,
        last_verification_receipt: "/receipt/light.json",
      };
    });
    writeFileSync(path, raw);
    writeFileSync(defaultPath, JSON.stringify({
      schema_version: "aos-model-default/v1",
      canonical_model_id: "minimax-m3-light",
      catalog_sha256: createHash("sha256").update(raw).digest("hex"),
      registry_sha256: "a".repeat(64),
      applies_to_new_sessions_only: true,
      active_sessions_rewritten: false,
    }));

    const snapshot = new FleetModelCatalogRegistry(path, defaultPath).snapshot();

    expect(snapshot.source.defaultState).toBe("shared");
    expect(snapshot.source.defaultModelId).toBe("minimax-m3-light");
    expect(snapshot.models.find((model) => model.canonicalId === "MiniMax-M3")?.default).toBe(false);
    expect(snapshot.models.find((model) => model.canonicalId === "minimax-m3-light")?.default).toBe(true);
  });

  it("keeps the catalog default when the shared default is stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-fleet-default-stale-"));
    dirs.push(dir);
    const path = join(dir, "openmausbot-models.v1.json");
    const defaultPath = join(dir, "default-model.v1.json");
    const raw = projection();
    writeFileSync(path, raw);
    writeFileSync(defaultPath, JSON.stringify({
      schema_version: "aos-model-default/v1",
      canonical_model_id: "MiniMax-M3",
      catalog_sha256: createHash("sha256").update(raw).digest("hex"),
      registry_sha256: "c".repeat(64),
      applies_to_new_sessions_only: true,
      active_sessions_rewritten: false,
    }));

    const snapshot = new FleetModelCatalogRegistry(path, defaultPath).snapshot();

    expect(snapshot.source.defaultState).toBe("invalid");
    expect(snapshot.source.defaultReason).toContain("hash is stale");
    expect(snapshot.source.defaultModelId).toBe("MiniMax-M3");
  });
});

describe("projectFleetModels", () => {
  it("preserves historical custom rows for installations with no AOS catalog", () => {
    const [instance] = projectFleetModels(
      [{
        instanceId: "claude",
        driverKind: "claudeAgent",
        models: { default: "", options: [{ id: "omlx::local", label: "Local", custom: true }] },
      }],
      {
        schema: "openmausbot-models/v1",
        source: { path: "/missing", state: "missing", refreshedAt: "now" },
        models: [],
        providerCandidates: [],
      },
    );
    expect(instance.models.options).toContainEqual(expect.objectContaining({ id: "omlx::local" }));
  });

  it("uses driver-native ids and disables busy, non-chat, and unverified rows", () => {
    const parsed = parseFleetModelCatalog(projection((catalog) => {
      catalog.models.push(
        concreteModel("windows-qwen", {
          display_name: "Qwen on Windows",
          provider_id: "ollama",
          native_model_id: "qwen3:14b",
          host: "windows",
          cost_class: "local",
          status: {
            configured: true,
            reachable: true,
            verified: true,
            admitted: true,
            busy: true,
            reason: "GPU is busy",
            last_verification_receipt: "/receipt/windows.json",
          },
          translations: {
            litellm: "windows-qwen",
            hermes: "litellm-local:windows-qwen",
            opencode: "litellm-local/windows-qwen",
            telegram: "windows-qwen",
            openmausbot: "ollama-windows/qwen3:14b",
          },
        }),
        concreteModel("nomic-embed", {
          display_name: "Nomic Embed",
          provider_id: "ollama",
          native_model_id: "nomic-embed-text",
          capabilities: ["embedding"],
          host: "mac",
          cost_class: "local",
          status: {
            configured: true,
            reachable: true,
            verified: true,
            admitted: true,
            busy: false,
            reason: null,
            last_verification_receipt: "/receipt/mac.json",
          },
          translations: {
            litellm: "nomic-embed",
            hermes: "litellm-local:nomic-embed",
            opencode: "litellm-local/nomic-embed",
            telegram: null,
            openmausbot: "ollama-mac/nomic-embed-text",
          },
        }),
      );
    }));
    const projected = projectFleetModels(
      [
        {
          instanceId: "hermes",
          driverKind: "hermesAgent",
          models: {
            default: "raw-local-model",
            options: [{ id: "raw-local-model", label: "Unclassified raw row", custom: true }],
          },
        },
        { instanceId: "opencode", driverKind: "opencodeGo", models: { default: "go", options: emptyOptions() } },
      ],
      readySnapshot(parsed),
    );
    expect(projected[0]?.models.default).toBe("litellm-local:MiniMax-M3");
    expect(projected[0]?.models.options).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "litellm-local:MiniMax-M3",
        canonicalId: "MiniMax-M3",
        isDefault: true,
        selectable: true,
      }),
      expect.objectContaining({ id: "litellm-local:windows-qwen", selectable: false, reason: "GPU is busy" }),
      expect.objectContaining({ id: "litellm-local:nomic-embed", selectable: false, reason: "Not chat-capable" }),
      expect.objectContaining({ id: "litellm-local:minimax-m3-light", selectable: false }),
    ]));
    expect(projected[1]?.models.options).toContainEqual(expect.objectContaining({
      id: "litellm-local/MiniMax-M3",
      canonicalId: "MiniMax-M3",
      selectable: true,
    }));
    expect(projected[0]?.models.options.some((option) => option.id === "raw-local-model")).toBe(false);
  });

  it("keeps Mac and Windows direct-local translations on disjoint instances", () => {
    const parsed = parseFleetModelCatalog(projection((source) => {
      const local = (id: string, host: "mac" | "windows", selector: string, busy: boolean) => concreteModel(id, {
        display_name: `${id} on ${host}`,
        provider_id: "ollama",
        native_model_id: "qwen3:14b",
        host,
        cost_class: "local",
        selectable: !busy,
        status: {
          configured: true,
          reachable: true,
          verified: true,
          admitted: true,
          busy,
          reason: busy ? "GPU is busy" : null,
          last_verification_receipt: "/receipt/local.json",
        },
        translations: {
          litellm: null,
          hermes: null,
          opencode: null,
          telegram: null,
          openmausbot: selector,
        },
      });
      source.models.push(
        local("mac-qwen", "mac", "ollama-mac/qwen3:14b", false),
        local("windows-qwen", "windows", "ollama-windows/qwen3:14b", true),
      );
    }));
    const projected = projectFleetModels(
      [
        { instanceId: "localMac", driverKind: "local", models: { default: "", options: emptyOptions() } },
        { instanceId: "localWindows", driverKind: "local", models: { default: "", options: emptyOptions() } },
      ],
      readySnapshot(parsed),
    );
    expect(projected[0]?.models.options).toContainEqual(expect.objectContaining({
      canonicalId: "mac-qwen",
      id: "ollama-mac/qwen3:14b",
      selectable: true,
    }));
    expect(projected[0]?.models.options.some((option) => option.canonicalId === "windows-qwen")).toBe(false);
    expect(projected[1]?.models.options).toContainEqual(expect.objectContaining({
      canonicalId: "windows-qwen",
      id: "ollama-windows/qwen3:14b",
      selectable: false,
      reason: "GPU is busy",
    }));
  });

  it("keeps unsupported models and provider candidates visible but disabled on one rail", () => {
    const parsed = parseFleetModelCatalog(projection((source) => {
      source.models.push(concreteModel("unsupported-candidate", {
        display_name: "Unsupported candidate",
        provider_id: "candidate-provider",
        native_model_id: null,
        cost_class: "free",
        status: {
          configured: true,
          reachable: false,
          verified: false,
          admitted: false,
          busy: false,
          reason: "Provider model discovery did not verify this candidate",
          last_verification_receipt: null,
        },
        translations: { litellm: null, hermes: null, opencode: null, telegram: null, openmausbot: null },
      }));
    }));
    const [hermes, opencode] = projectFleetModels(
      [
        { instanceId: "hermes", driverKind: "hermesAgent", models: { default: "", options: emptyOptions() } },
        { instanceId: "opencode", driverKind: "opencodeGo", models: { default: "", options: emptyOptions() } },
      ],
      readySnapshot(parsed),
    );
    expect(hermes.models.options).toContainEqual(expect.objectContaining({
      canonicalId: "unsupported-candidate",
      selectable: false,
      reason: "Provider model discovery did not verify this candidate",
    }));
    expect(opencode.models.options.some((option) => option.canonicalId === "unsupported-candidate")).toBe(false);
    expect(hermes.models.options).toContainEqual(expect.objectContaining({
      canonicalId: "provider-candidate:candidate-provider",
      provider: "candidate-provider",
      selectable: false,
      reason: "unverified_provider_or_model",
    }));
  });
});
