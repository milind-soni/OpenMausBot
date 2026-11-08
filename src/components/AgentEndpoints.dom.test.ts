// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ posts: [] as Array<{ path: string; body: Record<string, string> }> }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { instances: [], bots: [] }, dispatch: () => {} }),
  api: async (path: string, init: { body: string }) => { fixture.posts.push({ path, body: JSON.parse(init.body) }); return {}; },
}));
import { ClaudeEndpoints, CodexEndpoints } from "./ClaudeEndpoints";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.posts = [];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(button => button.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function input(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(field).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("starts the Claude form empty, with Anthropic's URL only as a placeholder", async () => {
  await act(async () => root.render(createElement(ClaudeEndpoints)));
  await click("Add endpoint");
  expect(container.querySelector("select")).toBeNull();
  const baseUrl = container.querySelector<HTMLInputElement>('input[aria-label="Base URL"]')!;
  expect(baseUrl.value).toBe("");
  expect(baseUrl.placeholder).toBe("https://api.anthropic.com");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!.value).toBe("");
  await input("Name", "Fixture host");
  await input("Token", "fixture-api-key");
  const save = [...container.querySelectorAll("button")].find(button => button.textContent === "Save")!;
  expect(save.disabled).toBe(true);
  expect(fixture.posts).toHaveLength(0);
});
it("saves OpenAI for Codex when the URL is left empty, without an OAuth step", async () => {
  await act(async () => root.render(createElement(CodexEndpoints)));
  await click("Add endpoint");
  const baseUrl = container.querySelector<HTMLInputElement>('input[aria-label="Base URL"]')!;
  expect(baseUrl.value).toBe("");
  expect(baseUrl.placeholder).toBe("https://api.openai.com/v1");
  await input("Name", "OpenAI");
  await input("Token", "fixture-api-key");
  await click("Save");
  expect(fixture.posts).toEqual([{ path: "/api/instances/codex-endpoint", body: { displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", token: "fixture-api-key" } }]);
});
it.each([
  { Component: ClaudeEndpoints, path: "/api/instances/claude-endpoint" },
  { Component: CodexEndpoints, path: "/api/instances/codex-endpoint" },
])("sends a typed model for a host without a model list ($path)", async ({ Component, path }) => {
  await act(async () => root.render(createElement(Component)));
  await click("Add endpoint");
  await input("Name", "Fixture host");
  await input("Base URL", "https://host.example/anthropic");
  await input("Token", "fixture-api-key");
  await input("Model", "fixture-model");
  await click("Save");
  expect(fixture.posts).toEqual([{ path, body: { displayName: "Fixture host", baseUrl: "https://host.example/anthropic", token: "fixture-api-key", model: "fixture-model" } }]);
});
it.each([
  { Component: ClaudeEndpoints, path: "/api/instances/claude-endpoint" },
  { Component: CodexEndpoints, path: "/api/instances/codex-endpoint" },
])("saves a custom URL directly from $path", async ({ Component, path }) => {
  await act(async () => root.render(createElement(Component)));
  await click("Add endpoint");
  await input("Name", "My CLIProxyAPI");
  await input("Base URL", "https://gateway.example/v1");
  await input("Token", "fixture-proxy-key");
  await click("Save");
  expect(fixture.posts).toEqual([{ path, body: { displayName: "My CLIProxyAPI", baseUrl: "https://gateway.example/v1", token: "fixture-proxy-key" } }]);
});
