import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";

const instances = vi.hoisted(() => [] as InstanceInfo[]);
const recovery = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, instances, config: { automaticRecovery: recovery } }, dispatch: vi.fn() }) };
});

vi.mock("../ModelPicker", () => ({
  ModelPicker: ({ label }: { label: ReactNode }) => label,
  EffortRow: () => null,
}));

const { FallbackChain, ModelSection } = await import("./ModelSection");
const { BotEditorContext } = await import("./BotEditorContext");

const engine = (instanceId: string, displayName: string, options: string[], authenticated = true) => ({
  instanceId, displayName, driverKind: "openai-compat", enabled: true,
  snapshot: { state: "available", version: "1", authenticated },
  models: { default: options[0], options: options.map((id) => ({ id, label: id.toUpperCase() })) },
}) as unknown as InstanceInfo;

const bot = (fallback: Bot["fallback"]) => ({ id: "bot-1", modelSelection: { instanceId: "primary", model: "p" }, fallback }) as unknown as Bot;

describe("a bot's backup models", () => {
  instances.splice(0, instances.length, engine("primary", "Primary", ["p"]), engine("codex", "Codex", ["gpt-a", "gpt-b"]));

  it("lets each backup choose any model its engine offers, not only the default", () => {
    const markup = renderToStaticMarkup(createElement(FallbackChain, { bot: bot([{ instanceId: "codex", model: "gpt-a" }]), onChange: vi.fn() }));
    const picker = markup.match(/<select[^>]*aria-label="Model for Codex"[^>]*>(.*?)<\/select>/)?.[1];
    expect(picker).toBeDefined();
    expect(picker).toContain('<option value="gpt-a" selected="">GPT-A</option>');
    expect(picker).toContain('<option value="gpt-b">GPT-B</option>');
  });

  it("saves the model chosen for a backup and leaves the other backups as they were", () => {
    instances.push(engine("grok", "Grok", ["grok-4"]));
    const onChange = vi.fn();
    const tree = FallbackChain({ bot: bot([{ instanceId: "codex", model: "gpt-a" }, { instanceId: "grok", model: "grok-4" }]), onChange });
    const find = (node: ReactNode): { props: { onChange(event: { target: { value: string } }): void } } | undefined => {
      if (Array.isArray(node)) return node.map(find).find(Boolean);
      if (!isValidElement(node)) return undefined;
      const props = node.props as { "aria-label"?: string; children?: ReactNode };
      return props["aria-label"] === "Model for Codex" ? node as never : find(props.children);
    };
    find(tree)!.props.onChange({ target: { value: "gpt-b" } });
    expect(onChange).toHaveBeenCalledWith([{ instanceId: "codex", model: "gpt-b" }, { instanceId: "grok", model: "grok-4" }]);
    instances.pop();
  });

  it("says the list works on its own, with Automatic recovery off as well as on", () => {
    for (const enabled of [true, false]) {
      recovery.enabled = enabled;
      const markup = renderToStaticMarkup(createElement(FallbackChain, { bot: bot([{ instanceId: "codex", model: "gpt-a" }]), onChange: vi.fn() }));
      expect(markup).toContain("Used in order, with no other setting, when this bot&#x27;s AI is at its usage limit or the provider proves a request never started.");
      expect(markup).not.toMatch(/Automatic recovery|inactive/);
    }
    recovery.enabled = true;
  });

  const control = (node: ReactNode, label: string): { props: { onChange(event: { target: { value: string } }): void } } | undefined => {
    if (Array.isArray(node)) return node.map((child) => control(child, label)).find(Boolean);
    if (!isValidElement(node)) return undefined;
    const props = node.props as { "aria-label"?: string; children?: ReactNode };
    return props["aria-label"] === label ? node as never : control(props.children, label);
  };

  it("offers the main AI's own account for another of its models, never the main model itself", () => {
    instances.splice(0, 1, engine("primary", "Primary", ["p", "q"]));
    const markup = renderToStaticMarkup(createElement(FallbackChain, { bot: bot([]), onChange: vi.fn() }));
    expect(markup).toContain('<option value="primary">Primary · Same account as the main AI: it shares the usage limit.</option>');
    expect(markup).toContain('<option value="codex">Codex</option>');
    const onChange = vi.fn();
    control(FallbackChain({ bot: bot([]), onChange }), "Add a backup AI")!.props.onChange({ target: { value: "primary" } });
    expect(onChange).toHaveBeenCalledWith([{ instanceId: "primary", model: "q" }]);
    instances.splice(0, 1, engine("primary", "Primary", ["p"]));
  });

  it("keeps two backups on one account apart, each offering only models no other backup uses", () => {
    const chain = [{ instanceId: "codex", model: "gpt-a" }, { instanceId: "codex", model: "gpt-b" }];
    const markup = renderToStaticMarkup(createElement(FallbackChain, { bot: bot(chain), onChange: vi.fn() }));
    const pickers = [...markup.matchAll(/<select[^>]*aria-label="Model for Codex"[^>]*>(.*?)<\/select>/g)].map((match) => match[1]);
    expect(pickers).toHaveLength(2);
    expect(pickers[0]).toContain('value="gpt-a" selected=""');
    expect(pickers[0]).not.toContain('value="gpt-b"');
    expect(markup).not.toContain('<option value="codex">');
    const onChange = vi.fn();
    const tree = FallbackChain({ bot: bot(chain), onChange });
    const removes: Array<{ props: { onClick(): void } }> = [];
    const collect = (node: ReactNode): void => {
      if (Array.isArray(node)) return node.forEach(collect);
      if (!isValidElement(node)) return;
      const props = node.props as { "aria-label"?: string; children?: ReactNode };
      if (props["aria-label"] === "Remove Codex from the fallback list") removes.push(node as never);
      collect(props.children);
    };
    collect(tree);
    removes[1]!.props.onClick();
    expect(onChange).toHaveBeenCalledWith([{ instanceId: "codex", model: "gpt-a" }]);
  });

  it("keeps showing a saved model the engine no longer lists", () => {
    const markup = renderToStaticMarkup(createElement(FallbackChain, { bot: bot([{ instanceId: "codex", model: "gpt-old" }]), onChange: vi.fn() }));
    expect(markup).toMatch(/aria-label="Model for Codex"[^>]*>.*<option value="gpt-old" selected="">gpt-old<\/option>/);
  });
});

describe("the bot's model in Bot settings", () => {
  const hint = "A new bot starts on this installation&#x27;s default model unless you pick another here. To switch automatically when this model is at its usage limit, add backup models below.";
  const render = (draft: boolean) => renderToStaticMarkup(createElement(BotEditorContext.Provider, { value: { request: vi.fn() as never, draft } },
    createElement(ModelSection, { bot: bot(undefined) })));

  it("says where a new bot's model comes from and points to backup models", () => {
    expect(render(false)).toContain(hint);
  });

  it("leaves the hint out while a bot is still being made", () => {
    expect(render(true)).not.toContain(hint);
  });
});
