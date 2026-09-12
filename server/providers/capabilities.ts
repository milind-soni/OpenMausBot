import type { ProviderPresetId } from "./catalog.js";

export type ProviderCapabilities = {
  streaming: boolean;
  reasoning: boolean;
  modelDiscovery: boolean;
  toolCalls: boolean;
};

const DEFAULTS: Record<ProviderPresetId, ProviderCapabilities> = {
  openai: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: false },
  openrouter: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: false },
  groq: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: false },
  mistral: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: false },
  "nvidia-nim": { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: false },
  "custom-openai-compatible": { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: false },
};

export function providerCapabilities(provider: ProviderPresetId, overrides?: Partial<ProviderCapabilities>): ProviderCapabilities {
  return { ...DEFAULTS[provider], ...overrides };
}

export function capabilityLabels(capabilities: ProviderCapabilities): string[] {
  return Object.entries(capabilities)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);
}
