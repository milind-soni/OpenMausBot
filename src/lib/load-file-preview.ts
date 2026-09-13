import { fileRequestUrl, previewMimeAllowed, type FilePreviewKind } from './file-preview';
import { t } from './i18n';

export const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

/** Auto-loaded thumbnails use the same message authority as an explicit preview.
 * Bound bytes while streaming, including responses without Content-Length. */
export async function loadFilePreview(
  message: { threadId: string; messageId: string },
  path: string,
  kind: FilePreviewKind,
  signal: AbortSignal,
): Promise<{ blob: Blob; disposition: string | null }> {
  const response = await fetch(fileRequestUrl(message), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }), signal,
  });
  const mime = response.headers.get('content-type') || '';
  const problem = !response.ok ? 'filePreview.fetchFailed'
    : !previewMimeAllowed(kind, mime) ? 'filePreview.invalidFile'
      : Number(response.headers.get('content-length')) > PREVIEW_MAX_BYTES ? 'filePreview.tooLarge' : null;
  if (problem) {
    await response.body?.cancel();
    throw new Error(t(problem));
  }
  if (!response.body) throw new Error(t('filePreview.fetchFailed'));
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PREVIEW_MAX_BYTES) throw new Error(t('filePreview.tooLarge'));
      chunks.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  signal.throwIfAborted();
  return { blob: new Blob(chunks, { type: mime }), disposition: response.headers.get('content-disposition') };
}
