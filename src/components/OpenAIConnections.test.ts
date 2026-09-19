import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { connectionInput, requiresConnectionKey, OpenAIConnectionEditor, type OpenAIConnection, type OpenAIConnectionDraft } from "./OpenAIConnections";

const saved: OpenAIConnection = { instanceId: "api-work", displayName: "Work", url: "https://work.example/v1", auth: "bearer", configured: true, model: "shared-model", tools: true };
const draft: OpenAIConnectionDraft = { ...saved, key: "" };
afterEach(() => { setLocale("en"); vi.unstubAllGlobals(); });

describe("independent API connections", () => {
  it("reuses an existing credential only for the same authenticated endpoint", () => {
    expect(requiresConnectionKey(draft, saved)).toBe(false);
    expect(requiresConnectionKey(draft, saved, true)).toBe(true);
    expect(requiresConnectionKey({ ...draft, key: "   " }, saved, true)).toBe(true);
    expect(requiresConnectionKey(draft)).toBe(true);
    expect(requiresConnectionKey({ ...draft, url: "https://other.example/v1" }, saved)).toBe(true);
    expect(requiresConnectionKey(draft, { ...saved, configured: false })).toBe(true);
    expect(requiresConnectionKey(draft, { ...saved, auth: "none" })).toBe(true);
    expect(requiresConnectionKey({ ...draft, key: "replacement" }, saved)).toBe(false);
  });

  it("omits blank keys and strips a typed key when authentication is disabled", () => {
    expect(connectionInput(draft)).not.toHaveProperty("key");
    expect(connectionInput({ ...draft, auth: "none", key: "previous-draft" })).not.toHaveProperty("key");
    expect(connectionInput({ ...draft, key: " separate-key " }).key).toBe("separate-key");
    expect(requiresConnectionKey({ ...draft, auth: "none" })).toBe(false);
  });

  it("keeps keys write-only and distinguishes catalog access from billable model checks", () => {
    const markup = renderToStaticMarkup(createElement(OpenAIConnectionEditor, { connection: saved, onSaved: vi.fn(), onCancel: vi.fn() }));
    expect(markup).toContain('type="password"');
    expect(markup).toContain('placeholder="Leave blank to keep the saved key" value=""');
    expect(markup).toContain("Check model catalog");
    expect(markup).toContain("Test model response");
    expect(markup).toContain("may incur charges");
    expect(markup).toContain("Catalog access does not prove");
  });

  it("localizes the connection form without rebuilding its module", () => {
    setLocale("pt-br");
    const markup = renderToStaticMarkup(createElement(OpenAIConnectionEditor, { onSaved: vi.fn(), onCancel: vi.fn() }));
    expect(markup).toContain("Adicionar conexão");
    expect(markup).toContain("Chave de API");
    expect(markup).toContain("pode gerar cobrança");
  });
});
