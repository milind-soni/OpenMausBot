import { describe, expect, it, vi } from "vitest";
import type { InstanceInfo, ModelSelection } from "@/state/store";
import { modelName, simpleModelMenu, SIMPLE_SEARCH_AFTER } from "./simple-model-menu";

vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});

type Menu = ReturnType<typeof simpleModelMenu>;
type Option = InstanceInfo["models"]["options"][number];

const claudeModels: Option[] = [
  { id: "sonnet-5", label: "Claude Sonnet 5" },
  { id: "fable-5-1", label: "Claude Fable 5.1" },
  { id: "fable-5", label: "Claude Fable 5" },
  { id: "opus-5-5", label: "Claude Opus 5.5" },
  { id: "opus-5", label: "Claude Opus 5" },
  { id: "haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "haiku-5", label: "Claude Haiku 5" },
  { id: "sonnet-4-5", label: "Claude Sonnet 4.5" },
];
const engine = (instanceId: string, driverKind: string, displayName: string, access: InstanceInfo["access"], options: Option[], extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind, displayName, access,
  snapshot: { state: "available", version: "1.0.0", authenticated: true },
  models: { default: options.find((option) => !option.custom)?.id ?? "", options },
  ...extra,
});
const claude = (extra: Partial<InstanceInfo> = {}, options = claudeModels) => engine("claude", "claudeAgent", "Claude", "subscription", options, { ...extra, models: { default: "sonnet-5", options } });
const codex = engine("codex", "codex", "Codex", "subscription", [{ id: "gpt-5.6", label: "GPT-5.6" }, { id: "gpt-5.6-mini", label: "GPT-5.6 mini" }, { id: "gpt-5.5", label: "GPT-5.5" }]);
const cursor = engine("cursor", "cursorAgent", "Cursor", "subscription", [{ id: "auto", label: "Auto" }]);
const openaiKey = engine("openai", "openai-compat", "OpenAI", "api", [{ id: "gpt-5.6", label: "GPT-5.6" }]);
const claudeKey = engine("claudeApi", "claudeAgent", "Claude (API key)", "api", claudeModels.slice(0, 2));
const pi = engine("pi", "piAgent", "pi", "custom", [
  { id: "llama", label: "Llama 4", custom: true },
  { id: "gemma", label: "Gemma 4", custom: true, loaded: true },
]);
const sonnet: ModelSelection = { instanceId: "claude", model: "sonnet-5" };

function menu(listed: InstanceInfo[], options: Partial<Parameters<typeof simpleModelMenu>[0]> = {}): Menu {
  return simpleModelMenu({
    instances: listed, listed, selection: sonnet,
    bot: { name: "Pepper", selection: sonnet },
    query: "", expanded: new Set(), probing: new Set(), loading: false,
    ...options,
  });
}
const rows = (built: Menu, index = 0) => {
  const body = built.groups[index]!.body;
  return body.kind === "models" ? body.rows.map((row) => row.label) : [];
};
const body = (built: Menu, index = 0) => built.groups[index]!.body;

describe("the Simple model menu", () => {
  it("puts the current model on top, then the rest of its provider under a heading, in short names", () => {
    const built = menu([claude()]);
    expect(built.current).toMatchObject({ label: "Claude Sonnet 5", title: "Claude · Claude Sonnet 5", warning: false, pending: false });
    expect(built.current!.meta).toBeUndefined();
    expect(built.groups.map((group) => group.label)).toEqual(["Claude"]);
    expect(rows(built)).toEqual(["Fable 5.1", "Fable 5", "Opus 5.5", "Opus 5"]);
    expect(body(built)).toMatchObject({ kind: "models", total: 8, toggle: "more" });
    expect(built.search).toBe(false);
  });

  it("opens a group's whole list in place, keeping its suggestions first, and folds it back", () => {
    const opened = menu([claude()], { expanded: new Set(["claude"]) });
    expect(rows(opened)).toEqual(["Fable 5.1", "Fable 5", "Opus 5.5", "Opus 5", "Haiku 5.5", "Haiku 5", "Sonnet 4.5"]);
    expect(body(opened)).toMatchObject({ toggle: "less" });
  });

  it("shows the one model a toggle would hide instead of the toggle", () => {
    const built = menu([claude({}, claudeModels.slice(0, 6))]);
    expect(rows(built)).toEqual(["Fable 5.1", "Fable 5", "Opus 5.5", "Opus 5", "Haiku 5.5"]);
    expect(body(built)).toMatchObject({ toggle: null });
  });

  it("lists every ready provider at once: the current one first, then sign-ins, API keys and local engines", () => {
    const built = menu([codex, openaiKey, pi, claude(), claudeKey]);
    expect(built.groups.map((group) => group.label)).toEqual(["Claude", "OpenAI", "OpenAI · API key", "Claude · API key", "pi"]);
    expect(rows(built, 1)).toEqual(["GPT-5.6", "GPT-5.6 mini", "GPT-5.5"]);
    expect(rows(built, 3)).toEqual(["Sonnet 5", "Fable 5.1"]);
  });

  it("offers three suggestions in a provider that does not hold the current model", () => {
    const built = menu([claude(), engine("other", "codex", "Codex", "subscription", claudeModels.slice(0, 5))]);
    expect(rows(built, 1)).toHaveLength(3);
    expect(body(built, 1)).toMatchObject({ toggle: "more", total: 5 });
  });

  it("leaves out a provider whose only model is the current one", () => {
    expect(menu([cursor], { selection: { instanceId: "cursor", model: "auto" } }).groups).toEqual([]);
  });

  it("names each signed-in account of one family, and keeps a signed-out sibling one click from signing in", () => {
    const work = engine("claude-work", "claudeAgent", "Work", "subscription", claudeModels.slice(0, 2));
    const home = { ...engine("claude-home", "claudeAgent", "Home", "subscription", claudeModels.slice(0, 2)),
      snapshot: { state: "available" as const, authenticated: false } };
    const built = menu([claude(), work, home]);
    expect(built.groups.map((group) => [group.label, group.body.kind])).toEqual([
      ["Claude", "models"], ["Claude · Work", "models"], ["Claude · Home", "signIn"],
    ]);
    expect(built.groups[1]).toMatchObject({ provider: "Claude", account: "Work" });
    expect(built.current!.meta).toBe("Claude");
  });

  it("says why a provider cannot run: set up, sign in, managed, or nothing listed yet", () => {
    const missing = { ...cursor, snapshot: { state: "unavailable" as const, reason: "not found" } };
    const signedOut = { ...codex, snapshot: { state: "available" as const, authenticated: false } };
    const managed = { ...openaiKey, policy: { organizationName: "Acme", reason: "Company models only." } };
    const plan = engine("chatgpt", "codex", "ChatGPT plan", "subscription", [], { snapshot: { state: "available", authenticated: true, chatgptPlan: true } });
    const built = menu([claude(), missing, signedOut, managed, plan]);
    expect(Object.fromEntries(built.groups.map((group) => [group.instance.instanceId, group.body]))).toMatchObject({
      cursor: { kind: "setUp" }, codex: { kind: "signIn" }, openai: { kind: "policy", organization: "Acme" }, chatgpt: { kind: "empty", loading: false },
    });
  });

  it("says a provider is loading its models while it lists them, and offers to check again once it lists none", () => {
    const unlisted = claude({}, []);
    const loading = menu([unlisted], { refreshing: "claude" });
    expect(loading.current).toMatchObject({ label: "sonnet-5", pending: true });
    expect(body(loading)).toEqual({ kind: "empty", loading: true });
    expect(body(menu([unlisted]))).toEqual({ kind: "empty", loading: false });
    expect(menu([unlisted]).current).toMatchObject({ pending: false });
  });

  it("keeps a signed-out engine's local models with a way to sign in for its own", () => {
    const signedOut = claude({ snapshot: { state: "available", authenticated: false } }, [...claudeModels, { id: "ollama::qwen3", label: "qwen3 (Ollama)", custom: true }]);
    const built = menu([signedOut], { selection: { instanceId: "claude", model: "ollama::qwen3" } });
    expect(built.current).toMatchObject({ label: "qwen3 (Ollama)", warning: false });
    expect(body(built)).toMatchObject({ kind: "models", rows: [], signInForOwn: true });
    const onOfficial = menu([signedOut]);
    expect(onOfficial.current).toMatchObject({ meta: "Sign-in required", warning: true });
    expect(rows(onOfficial)).toEqual(["qwen3 (Ollama)"]);
  });

  it("marks local models apart only where a provider mixes them with its own", () => {
    const withLocal = claude({}, [...claudeModels.slice(0, 2), { id: "ollama::qwen3", label: "qwen3 (Ollama)", custom: true }]);
    expect(body(menu([withLocal]))).toMatchObject({ localFrom: 1 });
    expect(body(menu([claude(), pi]), 1)).toMatchObject({ localFrom: null });
    expect(rows(menu([claude(), pi]), 1)).toEqual(["Gemma 4", "Llama 4"]);
  });

  it("says it is looking for local models while a provider with none yet is probed", () => {
    expect(body(menu([claude()], { probing: new Set(["claude"]) }))).toMatchObject({ probing: true });
    const withLocal = claude({}, [...claudeModels, { id: "ollama::qwen3", label: "qwen3 (Ollama)", custom: true }]);
    expect(body(menu([withLocal], { probing: new Set(["claude"]) }))).toMatchObject({ probing: false });
  });

  it("tells same-named models apart by their route", () => {
    const routes = engine("pi", "piAgent", "pi", "custom", [
      { id: "anthropic/sonnet", label: "Claude Sonnet 4.5", custom: true, provider: "anthropic" },
      { id: "bedrock/sonnet", label: "Claude Sonnet 4.5", custom: true, provider: "amazon-bedrock" },
      { id: "openai/gpt", label: "GPT-5.6", custom: true, provider: "openai" },
    ]);
    const piRows = (menu([claude(), routes]).groups[1]!.body as Extract<Menu["groups"][number]["body"], { kind: "models" }>).rows;
    expect(piRows.map((row) => [row.label, row.route])).toEqual([
      ["Claude Sonnet 4.5", "anthropic"], ["Claude Sonnet 4.5", "amazon-bedrock"], ["GPT-5.6", undefined],
    ]);
  });

  it("offers the bot's model to a thread on its own once, in the follow row, not again in its provider", () => {
    const own = menu([claude(), codex], { bot: { name: "Pepper", selection: { instanceId: "codex", model: "gpt-5.6" }, follows: false } });
    expect(own.follow).toBe(true);
    expect(rows(own, 1)).toEqual(["GPT-5.6 mini", "GPT-5.5"]);
    const onlyModel = menu([claude(), cursor], { bot: { name: "Pepper", selection: { instanceId: "cursor", model: "auto" }, follows: false } });
    expect(onlyModel.groups.map((group) => group.label)).toEqual(["Claude"]);
    expect(rows(menu([claude(), codex], { bot: { name: "Pepper", selection: { instanceId: "codex", model: "gpt-5.6" } } }), 1))
      .toEqual(["GPT-5.6", "GPT-5.6 mini", "GPT-5.5"]);
    const router = engine("router", "openai-compat", "OpenRouter", "api", [1, 2, 3, 4].map((index) => ({ id: `r-${index}`, label: `Router ${index}` })));
    const searched = menu([claude(), codex, router], { query: "gpt-5.6", bot: { name: "Pepper", selection: { instanceId: "codex", model: "gpt-5.6" }, follows: false } });
    expect(searched.follow).toBe(false);
    expect(rows(searched)).toEqual(["GPT-5.6", "GPT-5.6 mini"]);
  });

  it("names a model the catalog calls by one bare word with its provider, wherever no heading is beside it", () => {
    const auto = menu([claude(), cursor], { selection: { instanceId: "cursor", model: "auto" } });
    expect(auto.current).toMatchObject({ label: "Cursor Auto", title: "Cursor · Auto" });
    expect(modelName(cursor, "auto")).toBe("Cursor Auto");
    expect(modelName(claude(), "sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelName(codex, "gpt-5.6")).toBe("GPT-5.6");
    expect(modelName(pi, "llama")).toBe("Llama 4");
    expect(modelName(undefined, "gone-model")).toBe("gone-model");
    expect(modelName(cursor, "gone-model")).toBe("gone-model");
  });

  it("is busy while the menu reads its providers or one provider's models", () => {
    expect(menu([claude()]).busy).toBe(false);
    expect(menu([claude()], { loading: true }).busy).toBe(true);
    expect(menu([claude()], { refreshing: "claude" }).busy).toBe(true);
  });

  it("says on the current model when the thread follows its bot, and offers no follow row then", () => {
    const built = menu([claude()], { bot: { name: "Pepper", selection: sonnet, follows: true } });
    expect(built.current!.meta).toBe("Pepper's model");
    expect(built.follow).toBe(false);
    expect(menu([claude()]).follow).toBe(false);
  });

  it("shows a model whose engine has not loaded as waiting, then as unavailable", () => {
    expect(menu([], { loading: true }).current).toMatchObject({ label: "sonnet-5", pending: true });
    expect(menu([], { loading: true }).empty).toBe("loading");
    expect(menu([]).current).toMatchObject({ meta: "Unavailable", warning: true, pending: false });
    expect(menu([]).empty).toBe("none");
  });

  it("counts only models a person can pick toward the search box", () => {
    const missing = engine("cursor", "cursorAgent", "Cursor", "subscription", claudeModels.slice(0, 6), { snapshot: { state: "unavailable", reason: "not found" } });
    const managed = { ...engine("router", "openai-compat", "Router", "api", claudeModels), policy: { organizationName: "Acme", reason: "No." } };
    expect(menu([claude(), missing, managed]).search).toBe(false);
  });

  it("searches only past twelve models, across every provider, with the current model checked in place", () => {
    expect(menu([claude(), codex]).search).toBe(false);
    const many = engine("router", "openai-compat", "OpenRouter", "api",
      Array.from({ length: SIMPLE_SEARCH_AFTER }, (_, index) => ({ id: `model-${index}`, label: `Router ${index}` })));
    expect(menu([claude(), many], { query: "sonnet" }).search).toBe(true);
    const found = menu([claude(), codex, many], { query: "sonnet 5" });
    expect(found.current).toBeNull();
    expect(found.groups.map((group) => group.label)).toEqual(["Claude"]);
    expect((found.groups[0]!.body as Extract<Menu["groups"][number]["body"], { kind: "models" }>).rows.map((row) => [row.label, row.current]))
      .toEqual([["Sonnet 5", true]]);
    expect(found.results).toBe(1);
    expect(menu([claude(), codex, many], { query: "zzz" })).toMatchObject({ groups: [], results: 0 });
  });
});
