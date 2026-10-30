// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSearchSettings } from "./WebSearchSettings";
const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { config: { webSearch: { searxngUrl: "https://search.example", braveConfigured: true } } }, dispatch: fixture.dispatch }) }));
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.clearAllMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  flushSync(() => root.render(createElement(WebSearchSettings)));
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });
it("shows only a blank password field and removes a saved key explicitly", async () => {
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  fixture.api.mockResolvedValue({ webSearch: { braveConfigured: false } });
  flushSync(() => host.querySelectorAll("button")[1]!.click());
  await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalled());
  expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ webSearch: { searxngUrl: "https://search.example", braveApiKey: "" } }) });
});
it("preserves a saved key when saving only the URL and hides raw server errors", async () => {
  fixture.api.mockRejectedValue(new Error("synthetic-secret-must-not-display"));
  flushSync(() => host.querySelector("button")!.click());
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(host.textContent).not.toContain("synthetic-secret-must-not-display");
  expect(JSON.parse(fixture.api.mock.calls[0][1].body)).toEqual({ webSearch: { searxngUrl: "https://search.example" } });
});

it("explains Brave result retention and storage rights with a terms link", () => {
  expect(host.textContent).toContain("OpenMausBot stores Brave results for as long as conversation history.");
  expect(host.textContent).toContain("Choose a Brave API plan with storage rights that permit this retention.");
  const terms = host.querySelector<HTMLAnchorElement>("a")!;
  expect(terms.textContent).toBe("Brave API terms");
  expect(terms.href).toBe("https://api-dashboard.search.brave.com/terms-of-service");
});
