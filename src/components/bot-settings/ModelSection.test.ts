import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";

const instances = vi.hoisted(() => [] as InstanceInfo[]);
const recovery = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/state/store-select", async (importOriginal) => (await import("@/testing/plain-store-select")).plainStoreSelect(await importOriginal()));
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

  it("never saves a default the account cannot use now, and takes the next model it offers", () => {
    const blocked = engine("codex", "Codex", ["gpt-a", "gpt-b"]);
    blocked.models.options[0] = { ...blocked.models.options[0]!, orgBlocked: true } as never;
    instances.splice(1, 1, blocked);
    const onChange = vi.fn();
    control(FallbackChain({ bot: bot([]), onChange }), "Add a backup AI")!.props.onChange({ target: { value: "codex" } });
    expect(onChange).toHaveBeenCalledWith([{ instanceId: "codex", model: "gpt-b" }]);
    instances.splice(1, 1, engine("codex", "Codex", ["gpt-a", "gpt-b"], false));
    expect(renderToStaticMarkup(createElement(FallbackChain, { bot: bot([]), onChange: vi.fn() })), "a signed-out account is not offered").not.toContain('<option value="codex">');
    instances.splice(1, 1, engine("codex", "Codex", ["gpt-a", "gpt-b"]));
  });

  it("keeps showing a saved model the engine no longer lists", () => {
    const markup = renderToStaticMarkup(createElement(FallbackChain, { bot: bot([{ instanceId: "codex", model: "gpt-old" }]), onChange: vi.fn() }));
    expect(markup).toMatch(/aria-label="Model for Codex"[^>]*>.*<option value="gpt-old" selected="">gpt-old<\/option>/);
  });

  it("sets, filters per model, and clears reasoning effort or model variant per backup row", () => {
    const agy = {
      instanceId: "agy", displayName: "Antigravity", driverKind: "antigravity", enabled: true,
      snapshot: { state: "available", version: "1", authenticated: true },
      capabilities: { modelVariants: true },
      models: {
        default: "gemini-4-neon",
        options: [
          { id: "gemini-4-neon", label: "Gemini 4 Neon", variants: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }] },
          { id: "gemini-4-lite", label: "Gemini 4 Lite" },
        ],
      },
    } as unknown as InstanceInfo;
    const codexLevels = {
      ...engine("codex", "Codex", ["gpt-a", "gpt-b"]),
      capabilities: { effortLevels: ["low", "medium", "high"] },
      models: {
        default: "gpt-a",
        options: [
          { id: "gpt-a", label: "GPT-A", effortLevels: ["low", "medium", "high"] },
          { id: "gpt-b", label: "GPT-B", effortLevels: ["low", "high"] },
        ],
      },
    } as unknown as InstanceInfo;
    instances.splice(1, 1, codexLevels);
    instances.push(agy);
    try {
      const noReasoningMarkup = renderToStaticMarkup(createElement(FallbackChain, {
        bot: bot([{ instanceId: "agy", model: "gemini-4-lite" }]),
        onChange: vi.fn(),
      }));
      expect(noReasoningMarkup).not.toContain("Reasoning for Antigravity");

      const effortMarkup = renderToStaticMarkup(createElement(FallbackChain, {
        bot: bot([{ instanceId: "codex", model: "gpt-b", effort: "low" }]),
        onChange: vi.fn(),
      }));
      const effortSelect = effortMarkup.match(/<select[^>]*aria-label="Reasoning for Codex"[^>]*>(.*?)<\/select>/)?.[1];
      expect(effortSelect).toContain('<option value="">Provider default</option>');
      expect(effortSelect).toContain('<option value="low" selected="">Low</option>');
      expect(effortSelect).not.toContain('value="medium"');

      const selectControl = (node: ReactNode, label: string): { props: { onChange(event: { target: { value: string } }): void } } | undefined => {
        if (Array.isArray(node)) return node.map((child) => selectControl(child, label)).find(Boolean);
        if (!isValidElement(node)) return undefined;
        const props = node.props as { "aria-label"?: string; children?: ReactNode };
        if (props["aria-label"] === label) return node as never;
        return typeof node.type === "function" && node.type.name === "BackupReasoningSelect"
          ? selectControl((node.type as (p: unknown) => ReactNode)(props), label)
          : selectControl(props.children, label);
      };

      const onVariantChange = vi.fn();
      const variantTree = FallbackChain({
        bot: bot([{ instanceId: "agy", model: "gemini-4-neon" }, { instanceId: "codex", model: "gpt-a", effort: "medium" }]),
        onChange: onVariantChange,
      });
      selectControl(variantTree, "Reasoning for Antigravity")!.props.onChange({ target: { value: "medium" } });
      expect(onVariantChange).toHaveBeenCalledWith([
        { instanceId: "agy", model: "gemini-4-neon", variant: "medium" },
        { instanceId: "codex", model: "gpt-a", effort: "medium" },
      ]);

      const onClearChange = vi.fn();
      const clearTree = FallbackChain({
        bot: bot([{ instanceId: "codex", model: "gpt-a", effort: "medium" }]),
        onChange: onClearChange,
      });
      selectControl(clearTree, "Reasoning for Codex")!.props.onChange({ target: { value: "" } });
      expect(onClearChange).toHaveBeenCalledWith([{ instanceId: "codex", model: "gpt-a" }]);

      const onModelSwitch = vi.fn();
      const switchTree = FallbackChain({
        bot: bot([{ instanceId: "codex", model: "gpt-a", effort: "medium" }]),
        onChange: onModelSwitch,
      });
      selectControl(switchTree, "Model for Codex")!.props.onChange({ target: { value: "gpt-b" } });
      expect(onModelSwitch).toHaveBeenCalledWith([{ instanceId: "codex", model: "gpt-b" }]);
    } finally {
      instances.pop();
      instances.splice(1, 1, engine("codex", "Codex", ["gpt-a", "gpt-b"]));
    }
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
