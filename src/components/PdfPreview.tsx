import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus, Scan } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { t } from '@/lib/i18n';
import { PreviewBinaryDataFactory } from '@/lib/pdf-preview-assets';

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPreview({ data, onError }: { data: Uint8Array; onError: (error: string) => void }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const [rendering, setRendering] = useState(true);
  const [text, setText] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // The worker transfers ownership; copy so StrictMode and retries keep valid bytes.
    const task = getDocument({ data: data.slice(), enableXfa: false, useSystemFonts: true, useWorkerFetch: false, BinaryDataFactory: PreviewBinaryDataFactory, maxImageSize: 16_000_000 });
    let alive = true;
    void task.promise.then((document) => { if (alive) setPdf(document); }).catch((error) => {
      if (alive) onError(t(error?.name === 'PasswordException' ? 'filePreview.password' : 'filePreview.invalidPdf'));
    });
    return () => { alive = false; void task.destroy(); };
  }, [data, onError]);

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(160, entry.contentRect.width - 48)));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let cancelled = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    setRendering(true);
    setText('');
    const element = canvas.current;
    void (async () => {
      try {
        const documentPage = await pdf.getPage(page);
        if (cancelled) return;
        const natural = documentPage.getViewport({ scale: 1 });
        const scale = Math.min(width / natural.width, 1.4) * zoom;
        const viewport = documentPage.getViewport({ scale });
        // Bound memory even for pathological page dimensions or high-DPI screens.
        const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
        element.width = Math.max(1, Math.floor(viewport.width * density));
        element.height = Math.max(1, Math.floor(viewport.height * density));
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        render = documentPage.render({ canvas: element, viewport, transform: [density, 0, 0, density, 0, 0] });
        await render.promise;
        if (cancelled) return;
        setRendering(false);
        const content = await documentPage.getTextContent();
        if (!cancelled) setText(content.items.map((item) => 'str' in item ? item.str : '').join(' '));
      } catch (error) {
        if (!cancelled && (error as Error)?.name !== 'RenderingCancelledException') onError(t('filePreview.invalidPdf'));
      }
    })();
    return () => { cancelled = true; render?.cancel(); };
  }, [pdf, page, width, zoom, onError]);

  const buttonClass = 'rounded-lg p-2 hover:bg-raised disabled:opacity-30 disabled:cursor-default';
  return <>
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-b border-hairline bg-inset/30 px-2 py-2 text-xs">
      <button type="button" aria-label={t('filePreview.previous')} disabled={!pdf || page <= 1} onClick={() => setPage((value) => value - 1)} className={buttonClass}><ChevronLeft size={17} /></button>
      <span className="min-w-24 text-center tabular-nums" aria-live="polite">{t('filePreview.page', { page, count: pdf?.numPages ?? '…' })}</span>
      <button type="button" aria-label={t('filePreview.next')} disabled={!pdf || page >= pdf.numPages} onClick={() => setPage((value) => value + 1)} className={buttonClass}><ChevronRight size={17} /></button>
      <span className="mx-2 h-5 border-l border-hairline" />
      <button type="button" aria-label={t('filePreview.zoomOut')} disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} className={buttonClass}><Minus size={15} /></button>
      <span className="min-w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label={t('filePreview.zoomIn')} disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + 0.25))} className={buttonClass}><Plus size={15} /></button>
      <button type="button" aria-label={t('filePreview.fit')} onClick={() => setZoom(1)} className={buttonClass}><Scan size={16} /></button>
    </div>
    <div ref={container} className="relative min-h-0 flex-1 overflow-auto bg-inset p-6">
      {rendering && <div role="status" className="sticky top-0 z-10 mx-auto w-fit rounded-full bg-card px-3 py-1 text-xs text-ink-secondary shadow">{t('filePreview.loading')}</div>}
      <canvas key={`${page}:${width}:${zoom}`} ref={canvas} role="img" aria-label={t('filePreview.page', { page, count: pdf?.numPages ?? '…' })} className={`mx-auto block bg-white shadow-lg ${rendering ? 'invisible' : ''}`} />
      <p className="sr-only">{text}</p>
    </div>
  </>;
}
