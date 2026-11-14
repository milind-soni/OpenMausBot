import { contrastRatio, fromOklch, toOklch } from "./color-contrast";

/**
 * The colour a model keeps in the usage breakdown: a shade of the predominant
 * colour of its provider. Models from one provider stay in the same family of
 * hues and differ only in a small, deterministic step of hue, lightness and
 * chroma, so the list reads as one provider with distinct members instead of a
 * rainbow of unrelated colours.
 */
export interface ModelFamily {
  id: string;
  label: string;
  color: string;
}

interface FamilyRule extends ModelFamily {
  pattern: RegExp;
}

const FAMILIES: readonly FamilyRule[] = [
  { id: "anthropic", label: "Anthropic", color: "#D97757", pattern: /claude|anthropic|sonnet|opus|haiku/i },
  { id: "openai", label: "OpenAI", color: "#0C9A76", pattern: /(?:^|[-_/])gpt(?:\d|[-_.]|$)|openai|chatgpt|codex|^o[134](?:-|$)/i },
  { id: "xai", label: "xAI", color: "#7D8794", pattern: /grok|xai/i },
  { id: "deepseek", label: "DeepSeek", color: "#4C7DFF", pattern: /deepseek/i },
  { id: "google", label: "Google", color: "#9A6BE0", pattern: /gemini|google|gemma/i },
  { id: "qwen", label: "Qwen", color: "#D0634A", pattern: /qwen|tongyi|qwq/i },
  { id: "mistral", label: "Mistral", color: "#B88A12", pattern: /mistral|codestral|devstral|magistral|pixtral/i },
  { id: "meta", label: "Meta", color: "#D8578F", pattern: /llama|meta-|^meta$/i },
  { id: "kimi", label: "Kimi", color: "#1E93AA", pattern: /kimi|moonshot/i },
  { id: "zai", label: "Z.ai", color: "#7274F2", pattern: /glm|zhipu|z-ai|chatglm/i },
  { id: "minimax", label: "MiniMax", color: "#E05C7A", pattern: /minimax/i },
  { id: "cohere", label: "Cohere", color: "#B563D0", pattern: /command-r|cohere|(?:^|[-/])aya(?:[-/]|$)/i },
  { id: "perplexity", label: "Perplexity", color: "#2F97A6", pattern: /sonar|perplexity/i },
  { id: "amazon", label: "Amazon", color: "#C77C02", pattern: /nova|amazon|titan/i },
  { id: "microsoft", label: "Microsoft", color: "#2C90DE", pattern: /(?:^|[-/])phi|microsoft/i },
  { id: "nvidia", label: "NVIDIA", color: "#5E8C00", pattern: /nemotron|nvidia/i },
  { id: "opencode", label: "OpenCode", color: "#6F8B9A", pattern: /opencode|big-pickle|crouton|beam/i },
  { id: "nous", label: "Nous Research", color: "#8A6FD1", pattern: /hermes/i },
  { id: "cursor", label: "Cursor", color: "#74818C", pattern: /cursor|composer/i },
  { id: "factory", label: "Factory", color: "#7B8794", pattern: /droid/i },
  { id: "greenference", label: "Greenference", color: "#3F8F5F", pattern: /greenference/i },
  { id: "llmtr", label: "LLMTR", color: "#2563EB", pattern: /llmtr/i },
  { id: "unknown", label: "Other", color: "#76828F", pattern: /(?!)/ },
];

/** Every family's base tone, for the contrast guard in the tests. */
export const MODEL_PALETTE: readonly string[] = FAMILIES.map((family) => family.color);

const DRIVER_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/claude|anthropic/i, "anthropic"],
  [/codex|openai/i, "openai"],
  [/grok|xai/i, "xai"],
  [/opencode/i, "opencode"],
  [/gemini|antigravity/i, "google"],
  [/qwen/i, "qwen"],
  [/kimi/i, "kimi"],
  [/mistral/i, "mistral"],
  [/deepseek/i, "deepseek"],
  [/copilot/i, "microsoft"],
  [/cursor/i, "cursor"],
  [/command/i, "cohere"],
  [/droid/i, "factory"],
  [/hermes/i, "nous"],
  [/greenference/i, "greenference"],
  [/llmtr/i, "llmtr"],
];

const GATEWAY = /^(?:opencode-go|opencode|zen|openrouter|vercel|groq|fireworks(?:-ai)?|together(?:_ai)?|deepinfra|cerebras|togetherai|ollama|lmstudio|local)\//;

/** Provider namespaces an aggregator or a model id can carry, stripped before hashing so one model keeps one tone. */
const PROVIDER_NAMESPACE = /^(?:anthropic|openai|google|meta-llama|meta|mistralai|deepseek|qwen|moonshotai|moonshot|x-ai|xai|z-ai|zhipu|minimax|cohere|perplexity|amazon|nvidia|nousresearch|microsoft|cursor|factory)\//;

/** The model id inside a usage group key (`model:<driver>/<model>`), or the key itself. */
export function modelIdOf(groupKey: string): string {
  if (!groupKey.startsWith("model:")) return groupKey;
  const rest = groupKey.slice("model:".length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(slash + 1);
}

/** The driver segment of a `model:<driver>/<model>` key, or undefined when the key carries no driver. */
function driverOf(groupKey: string): string | undefined {
  if (!groupKey.startsWith("model:")) return undefined;
  const rest = groupKey.slice("model:".length);
  const slash = rest.indexOf("/");
  return slash === -1 ? undefined : rest.slice(0, slash);
}

/** The model name without the gateway prefix, a provider namespace or the free/beta marker, so one model keeps one tone. */
function coreModelId(model: string): string {
  let id = model.trim().toLowerCase();
  if (GATEWAY.test(id)) id = id.replace(GATEWAY, "");
  while (PROVIDER_NAMESPACE.test(id)) id = id.replace(PROVIDER_NAMESPACE, "");
  return id.replace(/(?::|-)(?:free|beta|preview|latest)$/, "");
}

/** The provider family a model belongs to, by its model id or its driver; unknown models use the neutral family. */
export function modelFamily(groupKey: string): ModelFamily {
  const model = coreModelId(modelIdOf(groupKey));
  const known = FAMILIES.find((family) => family.id !== "unknown" && family.pattern.test(model));
  if (known) return known;
  const driver = driverOf(groupKey);
  const fallback = driver && DRIVER_FAMILIES.find(([pattern]) => pattern.test(driver))?.[1];
  return FAMILIES.find((family) => family.id === fallback) ?? FAMILIES.find((family) => family.id === "unknown")!;
}

/** Murmur3's mixing over the model name: a small change in the name moves the tone to an unrelated step. */
function hash32(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    let chunk = text.charCodeAt(index);
    chunk = Math.imul(chunk, 0xcc9e2d51);
    chunk = (chunk << 15) | (chunk >>> 17);
    chunk = Math.imul(chunk, 0x1b873593);
    hash ^= chunk;
    hash = (hash << 13) | (hash >>> 19);
    hash = (Math.imul(hash, 5) + 0xe6546b64) >>> 0;
  }
  hash ^= text.length;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

const SHADE_SALT = "shade428:";
const HUE_STEPS = [-7, -4.7, -2.3, 0, 2.3, 4.7, 7] as const;
const LIGHT_STEPS = [-0.045, -0.03, -0.015, 0, 0.015, 0.03, 0.045] as const;
const CHROMA_STEPS = [0.93, 1, 1.07] as const;
const SURFACES = ["#ffffff", "#3a322d"] as const;
const MIN_CONTRAST = 3.05;

/** Whether a colour meets the minimum contrast on both the light and the dark surface. */
function readsOnBoth(hex: string): boolean {
  return SURFACES.every((surface) => contrastRatio(hex, surface) >= MIN_CONTRAST);
}

/** Keeps a tone legible on the light and the dark grounds, moving lightness only as much as it has to. */
function readableTone(hex: string, fallback: string): string {
  if (readsOnBoth(hex)) return hex;
  const base = toOklch(hex);
  for (let step = 0; step <= 140; step += 1) {
    for (const direction of [-1, 1] as const) {
      const lightness = base.l + direction * step * 0.002;
      if (lightness < 0.2 || lightness > 0.95) continue;
      const candidate = fromOklch({ ...base, l: lightness });
      if (readsOnBoth(candidate)) return candidate;
    }
  }
  return fallback;
}

/** Moves a model deterministically around its family colour, then keeps the shade readable on both grounds. */
function shadeOf(model: string, family: ModelFamily): string {
  const base = toOklch(family.color);
  const index = hash32(`${SHADE_SALT}${model}`) % (HUE_STEPS.length * LIGHT_STEPS.length * CHROMA_STEPS.length);
  const hue = base.h + HUE_STEPS[index % HUE_STEPS.length]!;
  const lightness = base.l + LIGHT_STEPS[Math.floor(index / HUE_STEPS.length) % LIGHT_STEPS.length]!;
  const chroma = base.c * CHROMA_STEPS[Math.floor(index / (HUE_STEPS.length * LIGHT_STEPS.length)) % CHROMA_STEPS.length]!;
  return readableTone(fromOklch({ l: lightness, c: chroma, h: hue }), family.color);
}

/** The colour of a model, stable across drivers, periods and the other models in the list. */
export function modelColor(groupKey: string): string {
  const family = modelFamily(groupKey);
  return shadeOf(coreModelId(modelIdOf(groupKey)) || groupKey.toLowerCase(), family);
}
