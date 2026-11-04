/**
 * The colour a model keeps everywhere on the Usage page: its own bar, and its
 * share of a bot's bar. Families sit in brand hues, and every tone clears 3:1
 * against the raised ground of every skin, because a bar is a graphic that has
 * to be told apart from the track it sits on.
 */
const FAMILY_COLORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/deepseek/i, "#4C7DFF"],
  [/gpt|openai|chatgpt/i, "#0C9A76"],
  [/claude|anthropic/i, "#D97757"],
  [/gemini|google|palm/i, "#9A6BE0"],
  [/qwen|tongyi/i, "#D0634A"],
  [/mistral|codestral|devstral|magistral/i, "#B88A12"],
  [/grok|xai/i, "#7D8794"],
  [/llama|meta-/i, "#D8578F"],
  [/kimi|moonshot/i, "#1E93AA"],
  [/crouton/i, "#66951F"],
  [/glm|zhipu/i, "#7274F2"],
];

/** Every tone a bar can take, for the contrast guard in the tests. */
export const MODEL_PALETTE: readonly string[] = FAMILY_COLORS.map(([, color]) => color);

/** The model id inside a usage group key (`model:<driver>/<model>`), or the key itself. */
export function modelIdOf(groupKey: string): string {
  if (!groupKey.startsWith("model:")) return groupKey;
  const rest = groupKey.slice("model:".length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(slash + 1);
}

export function modelColor(groupKey: string): string {
  const model = modelIdOf(groupKey);
  const known = FAMILY_COLORS.find(([pattern]) => pattern.test(model));
  if (known) return known[1];
  let hash = 0;
  for (const char of model.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) % 997;
  return MODEL_PALETTE[hash % MODEL_PALETTE.length]!;
}
