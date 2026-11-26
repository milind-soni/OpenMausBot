import type { ModelCatalog } from "../contracts.ts";
import { codexBackgroundModel } from "../drivers/codex-background-text.ts";
import { decodeCodexSelection, OFFICIAL_CODEX_PROVIDER } from "../drivers/codex-catalog.ts";

/** The smallest model of the bot's own engine that a suggested reply runs on, and which of the engine's one-shot calls
 * takes it: `text` (a direct request) or `background` (a fresh tool-free engine process). */
export interface LightModel {
  model: string;
  call: "text" | "background";
}

export interface LightModelEngine {
  driverKind: string;
  models: ModelCatalog;
  quickModelsUsable?: () => boolean;
  generateText?: unknown;
  generateMemoryText?: unknown;
}

type Option = ModelCatalog["options"][number];

const named = (pattern: RegExp) => (option: Option) => pattern.test(option.id);
const HAIKU = named(/(?:^|[-_./])haiku(?:$|[-_.])/i);
const MINI = named(/(?:^|[-_./])mini(?:$|[-_.])/i);
const FAST = named(/(?:^|[-_./])fast(?:$|[-_.])/i);
const FLASH_LITE = named(/(?:^|[-_./])flash-lite(?:$|[-_.])/i);
const FLASH = named(/(?:^|[-_./])flash(?:$|[-_.])/i);
const CODEX_SMALL = /(?:^|[-.])(?:luna|mini|nano)(?:$|[-.])/i;

/** First option the first matching rule picks; the engines list their newest first. */
function first(models: ModelCatalog, refused: ReadonlySet<string>, ...rules: Array<(option: Option) => boolean>): string | null {
  const usable = models.options.filter((option) => !option.custom && !option.local && !option.orgBlocked && !option.needsCliUpdate && !refused.has(option.id));
  for (const rule of rules) {
    const hit = usable.find(rule);
    if (hit) return hit.id;
  }
  return null;
}

function codexLight(engine: LightModelEngine, refused: ReadonlySet<string>): string | null {
  // A ChatGPT sign-in refuses the small models its catalog lists.
  if (engine.quickModelsUsable?.() === false) return null;
  const id = codexBackgroundModel(engine.models, refused, OFFICIAL_CODEX_PROVIDER);
  return id && CODEX_SMALL.test(decodeCodexSelection(id).model ?? id) ? id : null;
}

/** Null keeps suggested replies off for this engine: it has no small model of its own, or none its one-shot call can name.
 * Never another provider's model and never a local one. */
export function lightModelFor(engine: LightModelEngine, refused: ReadonlySet<string> = new Set()): LightModel | null {
  const text = (model: string | null): LightModel | null => model && engine.generateText ? { model, call: "text" } : null;
  const background = (model: string | null): LightModel | null => model && engine.generateMemoryText ? { model, call: "background" } : null;
  switch (engine.driverKind) {
    case "claudeAgent": return text(first(engine.models, refused, HAIKU));
    case "grok": return text(first(engine.models, refused, MINI, FAST));
    case "codex": return background(codexLight(engine, refused));
    case "antigravityAgent": return background(first(engine.models, refused, FLASH_LITE, FLASH));
    case "grokAgent": return background(first(engine.models, refused, MINI, FAST));
    default: return null;
  }
}
