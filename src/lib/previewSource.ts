import type { PreviewSource } from "./mobilePreviewUrl";

/** Device sizes, Canvas and synchronized scrolling apply only to web content. */
export function isDeviceSource(source: PreviewSource | null | undefined): boolean {
  return source?.kind === "url" || (source?.kind === "file" && source.fileType === "html");
}
