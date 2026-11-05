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
it.each([
  { Component: ClaudeEndpoints, provider: "Anthropic", url: "https://api.anthropic.com", path: "/api/instances/claude-endpoint" },
  { Component: CodexEndpoints, provider: "OpenAI", url: "https://api.openai.com/v1", path: "/api/instances/codex-endpoint" },
])("saves an official $provider API key without an OAuth step", async ({ Component, provider, url, path }) => {
  await act(async () => root.render(createElement(Component)));
  await click("Add endpoint");
  expect(container.querySelector("select")?.textContent).toContain(provider);
  await input("Token", "fixture-api-key");
  await click("Save");
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.posts[0]).toMatchObject({ path, body: { baseUrl: url, token: "fixture-api-key" } });
  expect(fixture.posts[0].body.model).toBeTruthy();
});
it("saves a CLIProxyAPI endpoint with its own model", async () => {
  await act(async () => root.render(createElement(CodexEndpoints)));
  await click("Add endpoint");
  const select = container.querySelector("select")!;
  await act(async () => { select.value = "custom"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await input("Name", "My CLIProxyAPI");
  await input("Base URL", "https://gateway.example/v1");
  await input("Token", "fixture-proxy-key");
  await input("Model", "gateway-model");
  await click("Save");
  expect(fixture.posts).toEqual([{ path: "/api/instances/codex-endpoint", body: { displayName: "My CLIProxyAPI", baseUrl: "https://gateway.example/v1", token: "fixture-proxy-key", model: "gateway-model" } }]);
});
