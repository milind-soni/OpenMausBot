// The model's window, when the driver did not say. A conservative pattern
// table over the model id: a wrong window would put a wrong percentage next
// to the context figure, so unknown models get no window and the chip shows
// the absolute count alone.
export function modelContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase();
  // Opus 5.5 is 1M without a `[1m]` suffix. Only the exact slug, or that
  // slug after a slash or a provider dot. A longer suffix such as
  // `claude-opus-5-5-local` stays on the generic Claude rule, as does `host::`.
  if (/(?:^|[/.])claude-opus-5(?:-5|\.5)$/.test(id)) return 1_000_000;
  if (/claude/.test(id) || /^(opus|sonnet|haiku|fable)\b/.test(id)) return /\[1m\]|-1m\b|1m-context/.test(id) ? 1_000_000 : 200_000;
  if (/^(gpt-5|o[34]\b|codex)/.test(id)) return 272_000;
  if (id.startsWith("gpt-4.1")) return 1_000_000;
  if (/gemini/.test(id)) return 1_000_000;
  if (id === "grok-4.7") return 500_000;
  if (id.startsWith("grok")) return 256_000;
  return undefined;
}
