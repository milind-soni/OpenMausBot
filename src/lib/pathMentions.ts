export function pathMentionAt(text: string, caret: number) {
  const match = /(?:^|\s)(\.?\/)([^\s`"'<>]*)$/.exec(text.slice(0, caret));
  if (!match || match[2].startsWith("/") || match[2].includes("://")) return null;
  const [, prefix, tail] = match;
  const segments = tail.split("/");
  try {
    const decoded = segments.map((part) => decodeURIComponent(part));
    if (decoded.some((part) => /[\/\\\0]/.test(part) || part === "..")) return null;
    return { start: caret - tail.length - prefix.length, prefix, directory: decoded.slice(0, -1).join("/"), query: decoded.at(-1) ?? "", tail };
  } catch {
    return null;
  }
}

export function encodeProjectPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}
