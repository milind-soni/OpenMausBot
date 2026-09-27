import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { NationAdminPage } from "../components/NationAdminPage";
import { api, ApiError } from "../lib/api-client";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each([null, {}, { isProductOwner: false }])("does not show admin controls without a confirmed owner: %j", config => {
  vi.stubGlobal("window", {});
  vi.stubEnv("BASE_URL", "/swarm/");
  vi.stubGlobal("sessionStorage", { getItem: () => "1" });
  const html = renderToStaticMarkup(createElement(NationAdminPage, { config }));
  expect(html).toContain("Admin access required");
  expect(html).toContain('href="/swarm/sign-in"');
  expect(html).toContain("Sign in as owner");
  expect(html).not.toContain("Test connection");
  expect(html).not.toContain("Credits</button>");
});

it("renders authorized controls in a standalone page", () => {
  vi.stubGlobal("window", {});
  const html = renderToStaticMarkup(createElement(NationAdminPage, { config: {
    isProductOwner: true, nationOpenrouter: { configured: true, model: "configured-model" },
  } }));
  expect(html).toContain("NATION / ADMIN");
  expect(html).toContain('href="/swarm/"');
  expect(html).toContain("Test connection");
  expect(html).not.toMatch(/Bots and navigation|Message actions|New bot/);
});

it("keeps the PIN gate on top of confirmed admin access", () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  const html = renderToStaticMarkup(createElement(NationAdminPage, { config: {
    isProductOwner: true, adminGate: { pinRequired: true },
  } }));
  expect(html).toContain("Admin access required");
  expect(html).not.toContain("Sign in as owner");
  expect(html).not.toContain("Test connection");
});

it("preserves the shared API authorization error and base path", async () => {
  vi.stubEnv("BASE_URL", "/swarm/");
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }));
  vi.stubGlobal("fetch", fetcher);
  const request = api("/api/admin/credits");
  await expect(request).rejects.toBeInstanceOf(ApiError);
  await expect(request).rejects.toMatchObject({ status: 403 });
  expect(fetcher.mock.calls[0][0]).toBe("/swarm/api/admin/credits");
});
