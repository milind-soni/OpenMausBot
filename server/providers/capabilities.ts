import type { ProviderPresetId } from "./catalog";

export type ProviderCapabilities = {
  streaming: boolean;
  reasoning: boolean;
  modelDiscovery: boolean;
  toolCalls: boolean;
};

const DEFAULTS: Record<ProviderPresetId, ProviderCapabilities> = {
  openai: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: true },
  openrouter: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: true },
  groq: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: true },
  mistral: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: true },
  "nvidia-nim": { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: true },
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
