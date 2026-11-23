import { afterEach, describe, expect, it } from "vitest";

import { configureFeatures, describeFeatures, editionStatus, featureEnabled, FEATURE_IDS, parseFeatureList, resolveFeatures } from "./features.ts";
import { parseConfigPatch, parseStoredConfig } from "./config.ts";

afterEach(() => {
  configureFeatures({}, undefined);
});

describe("feature registry", () => {
  it("turns nothing on by default", () => {
    expect(configureFeatures({}, undefined)).toEqual({ features: [], source: "none", unknown: [] });
    for (const id of FEATURE_IDS) expect(featureEnabled(id)).toBe(false);
    expect(editionStatus()).toEqual({ edition: "oss", features: [] });
  });

  it("reads config.json edition.features, sorted and without repeats", () => {
    const resolution = configureFeatures({}, ["budgets", "admin", "budgets"]);
    expect(resolution).toEqual({ features: ["admin", "budgets"], source: "config", unknown: [] });
    expect(featureEnabled("admin")).toBe(true);
    expect(featureEnabled("billing")).toBe(false);
    expect(editionStatus()).toEqual({ edition: "oss", features: ["admin", "budgets"] });
  });

  it("lets APP_FEATURES decide alone when set, even when empty", () => {
    expect(resolveFeatures({ APP_FEATURES: " billing , branding,," }, ["admin"])).toEqual({ features: ["billing", "branding"], source: "env", unknown: [] });
    expect(resolveFeatures({ APP_FEATURES: "" }, ["admin"])).toEqual({ features: [], source: "env", unknown: [] });
  });

  it("reports unknown ids without turning anything on for them", () => {
    configureFeatures({ APP_FEATURES: "billing,whitelabel,sso,whitelabel" }, undefined);
    expect(editionStatus().features).toEqual(["billing"]);
    expect(resolveFeatures({ APP_FEATURES: "billing,whitelabel,sso,whitelabel" }, undefined).unknown).toEqual(["whitelabel", "sso"]);
  });

  it("names what is on and where it came from", () => {
    expect(describeFeatures(resolveFeatures({}, undefined))).toBe("openmausbot features: none");
    expect(describeFeatures(resolveFeatures({ APP_FEATURES: "admin" }, undefined))).toBe("openmausbot features: admin (from APP_FEATURES)");
    expect(describeFeatures(resolveFeatures({}, ["billing"]))).toBe("openmausbot features: billing (from config.json edition.features)");
  });

  it("refuses an unknown id on the fleet command line", () => {
    expect(parseFeatureList("admin,budgets")).toEqual(["admin", "budgets"]);
    expect(() => parseFeatureList("admin,whitelabel")).toThrow(/unknown feature ids: whitelabel/);
  });
});

describe("edition in config.json", () => {
  it("accepts known ids and rejects anything else", () => {
    expect(parseStoredConfig({ edition: { features: ["admin", "billing"] } }).edition).toEqual({ features: ["admin", "billing"] });
    expect(() => parseStoredConfig({ edition: { features: ["whitelabel"] } })).toThrow();
    expect(() => parseStoredConfig({ edition: { features: ["admin"], licenseKey: "x" } })).toThrow();
  });

  it("is not part of the settings patch, so only the operator can change it", () => {
    expect(parseConfigPatch({ edition: { features: ["admin"] } })).not.toHaveProperty("edition");
  });
});
