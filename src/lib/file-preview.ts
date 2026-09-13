/** Match the actual path, never a model-supplied display label. */
export type FilePreviewKind = 'image' | 'pdf' | 'video' | 'spreadsheet' | 'presentation';

/** Decode only the basename for display; malformed escapes retain their original text. */
export function previewDisplayName(path: string): string {
  const basename = path.split(/[\\/]/).at(-1) || 'file';
  try { return decodeURIComponent(basename); } catch { return basename; }
}

/** Select a supported decoder from the actual path, never the display label. */
export function filePreviewKind(path: string): FilePreviewKind | null {
  if (/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(path)) return 'image';
  if (/\.pdf$/i.test(path)) return 'pdf';
  if (/\.(mp4|webm|mov)$/i.test(path)) return 'video';
  if (/\.(xlsx|xls|csv|tsv|ods)$/i.test(path)) return 'spreadsheet';
  if (/\.pptx$/i.test(path)) return 'presentation';
  return null;
}

/** Require the response MIME to match the chosen decoder before consuming its bytes. */
export function previewMimeAllowed(kind: FilePreviewKind, mime: string): boolean {
  const type = mime.split(';', 1)[0].trim().toLowerCase();
  if (kind === 'image') return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(type);
  if (kind === 'pdf') return type === 'application/pdf';
  if (kind === 'video') return ['video/mp4', 'video/webm', 'video/quicktime'].includes(type);
  if (kind === 'presentation') return type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  return ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.oasis.opendocument.spreadsheet', 'text/csv', 'text/tab-separated-values'].includes(type);
}

export type SpreadsheetPreview = { kind: 'spreadsheet'; sheets: Array<{ name: string; rows: string[][]; truncated: boolean }> };
export type PresentationPreview = { kind: 'presentation'; slides: Array<{ svg: string; text: string }>; truncated: boolean };
export type OfficePreviewResult = SpreadsheetPreview | PresentationPreview;

/** Address the message-scoped file endpoint; the server authorizes the requested path. */
export function fileRequestUrl(message: { threadId: string; messageId: string }): string {
  return `/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file`;
}
