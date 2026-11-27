import { injectedContextWindow } from "./drivers/local-inject.ts";

export function modelContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const local = injectedContextWindow(model);
  if (local) return local;
  const id = model.toLowerCase();
  // Opus 5.5, Sonnet 5.5 and Fable 5.2 are 1M without a `[1m]` suffix: only the exact slug, alone or after a slash or provider dot.
  if (/(?:^|[/.])claude-(?:(?:opus|sonnet)-5(?:-5|\.5)|fable-5(?:-2|\.2))$/.test(id)) return 1_000_000;
  if (/claude/.test(id) || /^(opus|sonnet|haiku|fable)\b/.test(id)) return /\[1m\]|-1m\b|1m-context/.test(id) ? 1_000_000 : 200_000;
  if (/^(gpt-5|o[34]\b|codex)/.test(id)) return 272_000;
  if (id.startsWith("gpt-4.1")) return 1_000_000;
  if (/gemini/.test(id)) return 1_000_000;
  if (id === "grok-4.7") return 500_000;
  if (id.startsWith("grok")) return 256_000;
  return undefined;
}
