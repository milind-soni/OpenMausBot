import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, bots: [] as unknown[], instances: [] as unknown[], dispatch: vi.fn(),
  // Bot ids whose PATCH the server keeps; any other switch is refused and rolled back.
  kept: new Set<string>(), flushBotPatches: vi.fn() }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next; }];
  },
  useEffect: () => {},
}));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: fixture.bots, instances: fixture.instances }, dispatch: fixture.dispatch, flushBotPatches: fixture.flushBotPatches, refreshInstances: vi.fn(), refreshModels: vi.fn() }),
}));
import { CompanyModels } from "./CompanyModels";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
const providers = [
  { id: "anthropic", configured: true, models: ["company-claude"] },
  { id: "openai", configured: true, models: ["company-gpt"] },
  { id: "openrouter", configured: false, models: [] },
];
function render() {
  fixture.index = 0;
  let tree: ReactNode;
  function Capture() { tree = CompanyModels({ providers }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const buttons = () => render().nodes.filter((node) => node.type === "button");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

const managed = { organizationId: "fixture-org", organizationName: "Fixture Company" };
const companyClaude: InstanceInfo = { instanceId: "company.fixture.anthropic", driverKind: "claudeAgent", displayName: "Company · Fixture Company · Claude",
  readOnly: true, managed, snapshot: { state: "available", authenticated: true }, models: { default: "company-claude", options: [{ id: "company-claude", label: "company-claude (Company)" }] } };
const companyCodex: InstanceInfo = { instanceId: "company.fixture.openai", driverKind: "codex", displayName: "Company · Fixture Company · Codex",
  readOnly: true, managed, snapshot: { state: "unavailable", reason: "codex CLI not found" }, models: { default: "company-gpt", options: [] } };
const personalClaude: InstanceInfo = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
  snapshot: { state: "available", authenticated: false }, models: { default: "sonnet", options: [{ id: "sonnet", label: "Sonnet" }] } };
const personalCodex: InstanceInfo = { instanceId: "codex", driverKind: "codex", displayName: "Codex",
  snapshot: { state: "unavailable", reason: "codex CLI not found" }, models: { default: "gpt", options: [] }, install: { command: { darwin: "npm i -g @openai/codex", linux: "npm i -g @openai/codex", win32: "npm i -g @openai/codex" } } };
const workingGrok: InstanceInfo = { instanceId: "grok", driverKind: "grokAgent", displayName: "Grok",
  snapshot: { state: "available", authenticated: true }, models: { default: "grok-4", options: [{ id: "grok-4", label: "Grok 4" }] } };
function bot(id: string, name: string, instanceId: string): Bot {
  return { id, threadId: `${id}-thread`, name, title: "", description: "", notifications: true, color: "green", unread: false, messages: [],
    modelSelection: { instanceId, model: "saved-model" } } as unknown as Bot;
}

beforeEach(() => {
  fixture.values = []; fixture.index = 0; fixture.dispatch = vi.fn();
  fixture.kept = new Set(["b1", "b2", "b3"]);
  fixture.flushBotPatches = vi.fn(async (botId: string) => ({ id: botId,
    modelSelection: fixture.kept.has(botId) ? { instanceId: "company.fixture.anthropic", model: "company-claude" } : { instanceId: "claude", model: "saved-model" } }));
  fixture.instances = [personalClaude, personalCodex, workingGrok, companyClaude, companyCodex];
  fixture.bots = [bot("b1", "Scout", "claude"), bot("b2", "Writer", "grok"), bot("b3", "Maus", "removed-instance")];
  vi.stubGlobal("window", { ogb: { platform: "darwin" } });
  setLocale("en");
});

describe("Company models in the connected Organisation panel", () => {
  it("lists each Company engine's readiness and reuses the engine install action without a personal sign-in", () => {
    const html = render().html;
    expect(html).toContain("Approved models: 1");
    expect(html).toContain("Ready on this computer");
    expect(html).toContain("Install Codex");
    expect(html).toContain("npm i -g @openai/codex");
    expect(html).toContain("run through the Codex app on this computer");
    expect(html).toContain("you don’t need to sign in to a personal account");
    expect(html).not.toMatch(/Sign in to Codex/);
    expect(html).toContain("Not configured");
  });

  it("counts only bots that cannot run, names them, and changes nothing until clicked", async () => {
    const view = render();
    expect(view.html).toContain("Can’t run now: Scout, Maus");
    expect(view.html).not.toContain("Writer");
    const action = view.nodes.find((node) => node.type === "button" && node.props.children === "Use Company · Fixture Company · Claude for 2 bots that can’t run");
    expect(action).toBeDefined();
    expect(view.html).not.toMatch(/role="dialog"/);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    action!.props.onClick!(); await flush();
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "setModel", botId: "b1", selection: { instanceId: "company.fixture.anthropic", model: "company-claude" } }],
      [{ type: "setModel", botId: "b3", selection: { instanceId: "company.fixture.anthropic", model: "company-claude" } }],
    ]);
    expect(render().html).toContain("Now using Company · Fixture Company · Claude: Scout, Maus");
  });

  it("names only bots the server kept on the Company model", async () => {
    fixture.kept = new Set(["b3"]);
    const use = () => render().nodes.find((node) => node.type === "button" && String(node.props.children).startsWith("Use "))!;
    use().props.onClick!(); await flush();
    expect(fixture.flushBotPatches.mock.calls).toEqual([["b1"], ["b3"]]);
    const html = render().html;
    expect(html).toContain("Now using Company · Fixture Company · Claude: Maus");
    expect(html).not.toContain("Now using Company · Fixture Company · Claude: Scout");
    fixture.values = []; fixture.kept = new Set(); fixture.flushBotPatches.mockClear();
    use().props.onClick!(); await flush();
    expect(fixture.flushBotPatches).toHaveBeenCalledTimes(2);
    expect(render().html).not.toContain("Now using");
  });

  it("offers nothing when every bot already runs", () => {
    fixture.bots = [bot("b2", "Writer", "grok"), bot("b4", "Clerk", "company.fixture.anthropic")];
    expect(render().html).not.toContain("bots that can’t run");
    expect(buttons().some((node) => String(node.props.children).startsWith("Use "))).toBe(false);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("follows a company-models-only policy: personal bots count and the target is never a refused engine", async () => {
    const refused = { organizationName: "Fixture Company", reason: "Fixture Company allows only company models on this computer. Choose a Company model for this bot." };
    const router: InstanceInfo = { ...companyClaude, instanceId: "company.fixture.openrouter", driverKind: "openai-compat", displayName: "Company · Fixture Company · OpenRouter", models: { default: "fixture/router", options: [] } };
    fixture.instances = [{ ...workingGrok, policy: refused }, { ...companyClaude, policy: { ...refused, reason: "Fixture Company does not allow the Claude engine on this computer." } }, router];
    fixture.bots = [bot("b2", "Writer", "grok")];
    const view = render();
    expect(view.html).toContain("does not allow the Claude engine");
    const action = view.nodes.find((node) => node.type === "button" && node.props.children === "Use Company · Fixture Company · OpenRouter for 1 bot that can’t run");
    action!.props.onClick!(); await flush();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "setModel", botId: "b2", selection: { instanceId: "company.fixture.openrouter", model: "fixture/router" } });
  });
});
