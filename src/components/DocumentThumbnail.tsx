import { useEffect, useRef, useState } from 'react';
import type { OfficePreviewResult } from '@/lib/file-preview';
import { acquirePreviewSlot } from '@/lib/preview-queue';

export default function DocumentThumbnail({ data, kind, onReady, onError }: {
  data: Uint8Array; kind: 'pdf' | 'presentation' | 'spreadsheet';
  onReady: () => void; onError: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const callbacks = useRef({ onReady, onError });
  useEffect(() => { callbacks.current = { onReady, onError }; }, [onReady, onError]);
  const [result, setResult] = useState<{ svgUrl?: string; rows?: string[][] } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let dispose = () => {};
    let svgUrl: string | undefined;
    setResult(null);
    void (async () => {
      const release = await acquirePreviewSlot(controller.signal);
      try {
        if (kind === 'pdf') {
          const { renderPdfThumbnail } = await import('@/lib/pdf-thumbnail');
          if (controller.signal.aborted) return;
          await renderPdfThumbnail(data, canvas.current!, controller.signal);
          if (!controller.signal.aborted) callbacks.current.onReady();
        } else {
          const preview = await new Promise<OfficePreviewResult>((resolve, reject) => {
            const worker = new Worker(new URL('../lib/office-preview.worker.ts', import.meta.url), { type: 'module' });
            const abort = () => { worker.terminate(); reject(new Error('Cancelled')); };
            const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Timed out')); }, 30_000);
            dispose = () => { clearTimeout(timeout); worker.terminate(); controller.signal.removeEventListener('abort', abort); };
            controller.signal.addEventListener('abort', abort, { once: true });
            worker.onmessage = (event: MessageEvent<{ result?: OfficePreviewResult }>) => {
              if (event.data.result) resolve(event.data.result); else reject(new Error('Invalid document'));
            };
            worker.onerror = () => reject(new Error('Invalid document'));
            const copy = data.slice();
            worker.postMessage({ data: copy, kind, thumbnail: true }, [copy.buffer]);
          });
          if (controller.signal.aborted) return;
          if (preview.kind === 'presentation') {
            svgUrl = URL.createObjectURL(new Blob([preview.slides[0].svg], { type: 'image/svg+xml' }));
            setResult({ svgUrl });
          } else {
            setResult({ rows: preview.sheets[0].rows });
            callbacks.current.onReady();
          }
        }
      } finally { dispose(); release(); }
    })().catch(() => { if (!controller.signal.aborted) callbacks.current.onError(); });
    return () => { controller.abort(); dispose(); if (svgUrl) URL.revokeObjectURL(svgUrl); };
  }, [data, kind]);

  if (kind === 'pdf') return <canvas ref={canvas} aria-hidden="true" className="mx-auto h-full max-w-full bg-white object-contain shadow-sm" />;
  if (result?.svgUrl) return <img src={result.svgUrl} alt="" onLoad={() => callbacks.current.onReady()} onError={() => callbacks.current.onError()} className="h-full w-full object-contain shadow-sm" />;
  if (result?.rows) return <span aria-hidden="true" className="grid h-full grid-cols-4 overflow-hidden rounded border border-hairline bg-card text-[8px] leading-tight">
    {result.rows.slice(0, 6).map((row, i) => Array.from({ length: 4 }, (_, j) => <span key={`${i}:${j}`} className={`overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-hairline/50 px-1 py-2 ${i === 0 ? 'bg-accent/10 font-semibold text-accent' : 'text-ink-secondary'}`}>{row[j] || '\u00a0'}</span>))}
  </span>;
  return null;
}
