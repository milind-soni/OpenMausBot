export function piModelId(model: unknown): string | null {
  const entry = model as { provider?: unknown; id?: unknown } | null | undefined;
  return typeof entry?.provider === "string" && entry.provider && typeof entry.id === "string" && entry.id
    ? `${entry.provider}/${entry.id}` : null;
}
