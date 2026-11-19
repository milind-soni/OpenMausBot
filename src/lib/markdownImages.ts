import { defaultUrlTransform } from "react-markdown";
import { classifyChatHref } from "./chatLinks";
import { buildProjectFilePreviewUrl } from "./mobilePreviewUrl";

export type MarkdownLocation = { projectId: string; filePath: string };

export function markdownUrlTransform(url: string, key: string): string {
  if (key === "src" && /^file:\/\//i.test(url)) return url;
  return defaultUrlTransform(url);
}

export function documentImageSource(src: string, location: MarkdownLocation): string | null {
  const target = classifyChatHref(src);
  if (target?.kind === "web") return src;
  if (!src || /^(?:\/\/|~\/|[a-z][a-z0-9+.-]*:|#)/i.test(src)) return null;
  const parts = src.startsWith("/") ? [] : location.filePath.split("/").slice(0, -1);
  for (const raw of src.split(/[?#]/, 1)[0].split("/")) {
    let part: string;
    try { part = decodeURIComponent(raw); } catch { return null; }
    if (/[\/\\\0]/.test(part)) return null;
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  if (!parts.length || classifyChatHref(parts.join("/"))?.kind !== "file") return null;
  if (!/\.(?:png|jpe?g|gif|webp|svg|avif|ico)$/i.test(parts.at(-1)!)) return null;
  return buildProjectFilePreviewUrl(location.projectId, parts.join("/"));
}
