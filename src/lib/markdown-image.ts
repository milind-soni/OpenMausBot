export function markdownImageName(src: string, alt?: string): string {
  const supplied = alt?.trim();
  if (supplied) return supplied;
  try {
    const path = decodeURIComponent(new URL(src, "https://openmausbot.invalid").pathname);
    const name = path.split(/[\\/]/).filter(Boolean).at(-1)?.trim();
    if (name) return name;
  } catch {
  }
  return "Image";
}

export function markdownImageOpenUrl(src: string): string | undefined {
  try {
    const url = new URL(src.startsWith("//") ? `https:${src}` : src);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
