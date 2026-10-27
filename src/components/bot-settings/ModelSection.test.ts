import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";

const instances = vi.hoisted(() => [] as InstanceInfo[]);
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, instances, config: { automaticRecovery: { enabled: true } } }, dispatch: vi.fn() }) };
});

const { FallbackChain } = await import("./ModelSection");

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

  it("keeps showing a saved model the engine no longer lists", () => {
    const markup = renderToStaticMarkup(createElement(FallbackChain, { bot: bot([{ instanceId: "codex", model: "gpt-old" }]), onChange: vi.fn() }));
    expect(markup).toMatch(/aria-label="Model for Codex"[^>]*>.*<option value="gpt-old" selected="">gpt-old<\/option>/);
  });
});
