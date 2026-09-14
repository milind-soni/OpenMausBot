import type { ProviderPresetId } from "./catalog.js";

export type ProviderCapabilities = {
  streaming: boolean;
  reasoning: boolean;
  modelDiscovery: boolean;
  toolCalls: boolean;
};

// Preset-level defaults only advertise capabilities guaranteed by the shared
// transport. Model-specific reasoning or tool support must be discovered or
// explicitly overridden rather than inferred from OpenAI compatibility.
const DEFAULTS: Record<ProviderPresetId, ProviderCapabilities> = {
  openai: { streaming: true, reasoning: false, modelDiscovery: true, toolCalls: false },
  openrouter: { streaming: true, reasoning: false, modelDiscovery: true, toolCalls: false },
  groq: { streaming: true, reasoning: false, modelDiscovery: true, toolCalls: false },
  mistral: { streaming: true, reasoning: false, modelDiscovery: true, toolCalls: false },
  "nvidia-nim": { streaming: true, reasoning: false, modelDiscovery: true, toolCalls: false },
  "custom-openai-compatible": { streaming: true, reasoning: false, modelDiscovery: true, toolCalls: false },
};

/** Returns conservative provider-level capabilities with explicit overrides applied. */
export function providerCapabilities(provider: ProviderPresetId, overrides?: Partial<ProviderCapabilities>): ProviderCapabilities {
  return { ...DEFAULTS[provider], ...overrides };
}

/** Converts enabled capability flags into renderer-friendly capability labels. */
export function capabilityLabels(capabilities: ProviderCapabilities): string[] {
  return Object.entries(capabilities)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);
}
