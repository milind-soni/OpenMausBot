import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = f.index++;
    if (!(index in f.values)) f.values[index] = initial;
    return [f.values[index], (next: unknown) => { f.values[index] = next; }];
  },
}));
const store = vi.hoisted(() => ({ instances: [] as unknown[], dispatch: vi.fn(), refreshInstances: vi.fn() }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { instances: store.instances }, dispatch: store.dispatch, refreshInstances: store.refreshInstances }),
}));
// The sign-in cards themselves have their own tests (ClaudeSignIn, CodexDeviceSignIn, EngineSetup).
vi.mock("@/components/EngineSetup", () => ({
  EngineSetup: ({ instance }: { instance: InstanceInfo }) => createElement("div", { "data-engine-setup": instance.instanceId }),
}));
import { CloudEngineSignIn, cloudEngine } from "./CloudEngineSignIn";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; "data-cloud-choice"?: string }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function render() {
  f.index = 0;
  let tree: ReactNode;
  function Capture() { tree = CloudEngineSignIn(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const choose = (id: string) => {
  const choice = render().nodes.find((node) => node.props["data-cloud-choice"] === id)!;
  nodes(choice).find((node) => node.type === "button")!.props.onClick!();
};

const engine = (instanceId: string, driverKind: string, method: "paste-code" | "device-code", extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind, displayName: driverKind === "codex" ? "Codex" : "Claude", access: "subscription",
  snapshot: { state: "available", authenticated: false }, models: { default: "", options: [] }, authentication: { method },
  ...extra,
} as InstanceInfo);
const claude = engine("claude", "claudeAgent", "paste-code");
const codex = engine("codex", "codex", "device-code");

beforeEach(() => {
  f.values = [];
  store.instances = [claude, codex];
  store.dispatch.mockReset();
  store.refreshInstances.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("window", {});
  setLocale("en");
});

it("offers the three ways in and says plainly whose plan limits apply", () => {
  const { html } = render();
  expect(html).toContain("data-cloud-sign-in");
  for (const label of ["Sign in to Claude", "Sign in to ChatGPT (Codex)", "Use an API key"]) expect(html).toContain(label);
  expect(html).toContain("plan limits apply to bots running 24/7");
  // OMB sells a plan called Max too: the recommendation names Anthropic's.
  expect(html).toContain("Anthropic&#x27;s Claude Max subscription or an API key is recommended");
  expect(html).not.toMatch(/included/i);
  // nothing is opened on the person's behalf
  expect(html).not.toContain("data-engine-setup");
});

it("opens the existing paste-code and device-code sign-ins on this server's own engines", () => {
  choose("claude");
  expect(render().html).toContain('data-engine-setup="claude"');
  choose("codex");
  const { html } = render();
  expect(html).toContain('data-engine-setup="codex"');
  expect(html).not.toContain('data-engine-setup="claude"');
  expect(store.dispatch).not.toHaveBeenCalled();
});

it("sends an API key to the existing model-provider keys in Settings → API keys", () => {
  choose("api-key");
  expect(store.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleAppSettings", open: true, section: "connections" });
});

it("picks the person's own engine, never a local-model or read-only one, and says when there is none", () => {
  const local = engine("claude-local", "claudeAgent", "paste-code", { access: "custom" });
  const company = engine("company.acme.anthropic", "claudeAgent", "paste-code", { readOnly: true });
  expect(cloudEngine([local, company, claude], "claudeAgent")).toBe(claude);
  expect(cloudEngine([local, company], "claudeAgent")).toBeUndefined();
  store.instances = [codex];
  choose("claude");
  expect(render().html).toContain("not available on your Cloud yet");
});
