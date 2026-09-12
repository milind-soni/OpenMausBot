import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PreviewBinaryDataFactory } from './pdf-preview-assets';

GlobalWorkerOptions.workerSrc = workerUrl;

export async function renderPdfThumbnail(data: Uint8Array, canvas: HTMLCanvasElement, signal: AbortSignal) {
  const task = getDocument({ data: data.slice(), enableXfa: false, useSystemFonts: true, useWorkerFetch: false, BinaryDataFactory: PreviewBinaryDataFactory, maxImageSize: 16_000_000 });
  const abort = () => { void task.destroy(); };
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 30_000);
  try {
    signal.throwIfAborted();
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    signal.throwIfAborted();
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(480 / natural.width, 260 / natural.height) });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvas, viewport }).promise;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    await task.destroy();
  }
}
