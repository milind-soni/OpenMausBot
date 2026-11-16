// Links and images in chat messages open in the Quick preview: web pages as
// URL sources, local paths (absolute, ~/, file:// or project-relative) as
// project files once the server maps them into a registered project.
import { buildProjectFilePreviewUrl, validatePreviewUrl, type PreviewFileKind, type PreviewFileSource } from "./mobilePreviewUrl";
import { loadMobilePreviewState, saveMobilePreviewState } from "./mobilePreviewState";

export const OPEN_PREVIEW_EVENT = "gbs-open-preview";

const FILE_EXT = /\.(html?|pdf|md|markdown|txt|png|jpe?g|webp|gif|svg|avif|ico)$/i;

export type ChatHref =
  | { kind: "web"; url: string }
  | { kind: "file"; path: string }
  | { kind: "other"; href: string };

/** Markdown output percent-encodes link targets ("The%20Gerer%20Company"); file paths need the real name. */
function decodePath(value: string): string {
  try { return decodeURI(value); } catch { return value; }
}

export function classifyChatHref(href: string | undefined | null): ChatHref | null {
  const value = (href ?? "").trim();
  if (!value || value.startsWith("#")) return null;
  if (/^https?:\/\//i.test(value)) return { kind: "web", url: value };
  if (/^file:\/\//i.test(value)) return { kind: "file", path: value };
  if (value.startsWith("/") || value.startsWith("~/")) return { kind: "file", path: decodePath(value) };
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return { kind: "other", href: value };
  // Bare relative paths only count when they name a previewable file.
  const bare = value.split(/[?#]/)[0];
  return FILE_EXT.test(bare) ? { kind: "file", path: decodePath(value) } : { kind: "other", href: value };
}

/** True for inline-code text that is clearly a local file path we could preview. */
export function looksLikeFilePath(text: string): boolean {
  const value = text.trim();
  // Spaces are allowed ("The Gerer Company"); line breaks are not.
  return !/[\n\r]/.test(value) && (value.startsWith("/") || value.startsWith("~/") || /^file:\/\//i.test(value)) && FILE_EXT.test(value);
}

export interface ResolvedChatFile {
  projectId: string;
  projectName: string;
  path: string;
  kind: PreviewFileKind;
}

const cache = new Map<string, Promise<ResolvedChatFile | null>>();

export function resolveChatFile(path: string): Promise<ResolvedChatFile | null> {
  let pending = cache.get(path);
  if (!pending) {
    pending = fetch(`/api/preview/resolve?path=${encodeURIComponent(path)}`)
      .then((res) => (res.ok ? (res.json() as Promise<ResolvedChatFile>) : null))
      .catch(() => null);
    cache.set(path, pending);
    // Misses are retried later: the file may not exist yet when a model first mentions it.
    void pending.then((hit) => { if (!hit) setTimeout(() => cache.delete(path), 5_000); });
  }
  return pending;
}

export function chatFileUrl(file: ResolvedChatFile): string {
  return buildProjectFilePreviewUrl(file.projectId, file.path);
}

export type OpenPreviewDetail = { file: PreviewFileSource } | { url: string };

/** Show a file or web page in the Quick preview, opening the panel if needed. */
export function openInPreview(detail: OpenPreviewDetail): void {
  // The panel reads its last state on mount, so a closed panel opens on this target too.
  // Local/private web addresses are left for the panel's own confirmation step.
  const previous = loadMobilePreviewState();
  if ("file" in detail) saveMobilePreviewState({ ...previous, source: detail.file, input: "" });
  else {
    const check = validatePreviewUrl(detail.url);
    saveMobilePreviewState({
      ...previous,
      input: detail.url,
      source: check.valid && !check.isLocalOrPrivate ? { kind: "url", url: check.url, raw: detail.url, isLocalOrPrivate: false } : previous.source ?? null,
    });
  }
  window.dispatchEvent(new CustomEvent<OpenPreviewDetail>(OPEN_PREVIEW_EVENT, { detail }));
}

/** Open a chat link: returns false when it isn't something the preview can show. */
export async function openChatHref(href: string): Promise<boolean> {
  const target = classifyChatHref(href);
  if (!target || target.kind === "other") return false;
  if (target.kind === "web") {
    openInPreview({ url: target.url });
    return true;
  }
  const file = await resolveChatFile(target.path);
  if (!file) return false;
  openInPreview({ file: { kind: "file", projectId: file.projectId, projectName: file.projectName, filePath: file.path, fileType: file.kind } });
  return true;
}
