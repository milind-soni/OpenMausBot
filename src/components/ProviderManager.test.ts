import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isManagedApiInstance, ProviderManager, requiresExplicitBaseUrl } from "./ProviderManager";

describe("ProviderManager", () => {
  it("renders without requiring StoreProvider context", () => {
    const html = renderToStaticMarkup(<ProviderManager />);
    expect(html).toContain("AI Providers");
    expect(html).toContain("Add provider");
  });

  it("only treats generated OpenAI-compatible ids as managed API connections", () => {
    expect(isManagedApiInstance({ driverKind: "openai-compat", instanceId: "api-openai-personal" })).toBe(true);
    expect(isManagedApiInstance({ driverKind: "openai-compat", instanceId: "openaiCompat" })).toBe(false);
    expect(isManagedApiInstance({ driverKind: "claudeAgent", instanceId: "api-claude" })).toBe(false);
  });

  it("requires explicit base URLs for deployment-specific presets", () => {
    expect(requiresExplicitBaseUrl("openai")).toBe(false);
    expect(requiresExplicitBaseUrl("nvidia-nim")).toBe(true);
    expect(requiresExplicitBaseUrl("custom-openai-compatible")).toBe(true);
  });
});
