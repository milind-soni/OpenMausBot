import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { ConfigStatus, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({ config: {} as Partial<ConfigStatus>, instances: [] as InstanceInfo[] }));
vi.mock("@/state/store", async (original) => {
  const store = await original<typeof import("@/state/store")>();
  return { ...store, useStore: () => ({ state: { ...store.initialState, config: fixture.config, instances: fixture.instances }, dispatch: vi.fn() }) };
});

const { KeyRow } = await import("./KeyRow");
const { cleanKey, looksLikeKey, tregVerdict } = await import("./key-save");

beforeEach(() => {
  fixture.config = {};
  fixture.instances = [];
  vi.stubGlobal("window", {});
  setLocale("en");
});
afterEach(() => vi.unstubAllGlobals());

const render = (props: ComponentProps<typeof KeyRow>) => renderToStaticMarkup(createElement(KeyRow, props));

describe("an empty key row", () => {
  it("is a calm field with the key's shape, show and hide, one Save and where to get a key", () => {
    const html = render({ id: "anthropic" });
    expect(html).toContain("Anthropic API key");
    expect(html).toContain("Claude models, billed per token");
    expect(html).toMatch(/<input[^>]*type="password"[^>]*placeholder="sk-ant-…"[^>]*aria-label="Anthropic API key"[^>]*value=""/);
    expect(html).toContain('aria-label="Show key"');
    expect(html.match(/data-key-save=/g)).toHaveLength(1);
    expect(html).toMatch(/data-key-save="true"[^>]*disabled=""/);
    expect(html).toMatch(/<a href="https:\/\/console\.anthropic\.com\/settings\/keys"[^>]*>Get a key/);
    expect(html).not.toContain("Connected");
    expect(html).not.toContain("data-key-masked");
  });

  it("keeps a key's warning in view before it is added", () => {
    expect(render({ id: "box" })).toContain("Boat is a paid service after its trial.");
    expect(render({ id: "openai" })).toContain("Codex doesn&#x27;t use this key");
  });
});

describe("a saved key", () => {
  it("shows the key masked to its last four, Connected with a check, and Replace and Remove beside it", () => {
    fixture.config = { anthropic: { configured: true, last4: "a1b2" } };
    const html = render({ id: "anthropic" });
    expect(html).toContain("••••••••a1b2");
    expect(html).toContain("Anthropic API key is saved and ends in a1b2");
    expect(html).toContain(">Connected<");
    expect(html).toContain("data-key-replace");
    expect(html).toContain("data-key-remove");
    expect(html).not.toContain("<input");
    expect(html).toContain('data-key-state="saved"');
  });

  it("says Saved, not Connected, for a key nothing can test", () => {
    fixture.config = { deepseek: { configured: true, last4: "9z9z" } };
    const html = render({ id: "deepseek" });
    expect(html).toContain(">Saved<");
    expect(html).not.toContain(">Connected<");
    expect(html).toContain("••••••••9z9z");
  });

  it("masks a saved key it has no hint for, never showing an empty field", () => {
    fixture.config = { treg: { configured: true } };
    const html = render({ id: "treg" });
    expect(html).toMatch(/<span aria-hidden="true">••••••••<\/span>/);
    expect(html).not.toContain("<input");
  });

  it("reads the keys kept inside other settings back from savedKeys", () => {
    fixture.config = { savedKeys: { ttsKey: { configured: true, last4: "11aa" }, openaiLiveKey: { configured: true, last4: "22bb" } } };
    expect(render({ id: "elevenlabs" })).toContain("••••••••11aa");
    expect(render({ id: "liveKey" })).toContain("••••••••22bb");
    expect(render({ id: "jev" })).toContain("<input");
  });

  it("marks a key its provider has since rejected as not working, keeping it in view to replace", () => {
    fixture.config = { openai: { configured: true, last4: "a1b2" } };
    fixture.instances = [{ instanceId: "openai", driverKind: "openai-compat", displayName: "OpenAI", access: "api",
      snapshot: { state: "available", authenticated: false }, models: { default: "m", options: [] } } as unknown as InstanceInfo];
    const html = render({ id: "openai" });
    expect(html).toContain(">Didn&#x27;t work<");
    expect(html).toContain("Didn&#x27;t work: The provider rejected this key.");
    expect(html).toContain("••••••••a1b2");
    expect(html).toContain("data-key-replace");
  });
});

describe("a key that comes with the Cloud plan", () => {
  it("says it is included and offers the person's own key only on request", () => {
    fixture.config = { box: { configured: true, included: true } };
    const html = render({ id: "box" });
    expect(html).toContain("Included with your Cloud plan");
    expect(html).toContain("Use your own key");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("data-key-remove");
  });
});

describe("a row that uses another row's key", () => {
  it("shows the OpenAI key under its own name in Voice and calls, without a second Remove", () => {
    fixture.config = { openai: { configured: true, last4: "a1b2" } };
    const html = render({ id: "openai", row: "liveCalls" });
    expect(html).toContain('data-key-row="liveCalls"');
    expect(html).not.toContain("data-api-key-row");
    expect(html).toContain("OpenAI key");
    expect(html).toContain("Live calls use the same key as OpenAI&#x27;s models");
    expect(html).toContain("••••••••a1b2");
    expect(html).toContain("data-key-replace");
    expect(html).not.toContain("data-key-remove");
  });
});

describe("what a pasted key goes through", () => {
  it("drops the spaces, line breaks, quotes and invisible characters a copy brings along", () => {
    expect(cleanKey("  sk-proj-abc123\n")).toBe("sk-proj-abc123");
    expect(cleanKey('"sk-proj-abc123"')).toBe("sk-proj-abc123");
    expect(cleanKey("​sk-proj-abc123﻿")).toBe("sk-proj-abc123");
  });

  it("refuses text that is not a key", () => {
    expect(looksLikeKey("sk-proj-abc123_DEF")).toBe(true);
    expect(looksLikeKey("The mascots are ready")).toBe(false);
    expect(looksLikeKey("sk-abc\n")).toBe(false);
  });

  it("says treg is working with the balance, or names the exact problem", () => {
    expect(tregVerdict({ ok: true, check: "treg", balanceUsd: 4.25 } as never)).toBe("treg is working ✓ Balance: $4.25.");
    expect(tregVerdict({ ok: true })).toBe("treg is working ✓");
    expect(tregVerdict({ ok: false, message: "treg rejected this key. Copy it again from treg.to." })).toBe("treg rejected this key. Copy it again from treg.to.");
  });
});
