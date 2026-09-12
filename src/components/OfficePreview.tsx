import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { OfficePreviewResult } from '@/lib/file-preview';

export default function OfficePreview({ data, kind, onError }: { data: Uint8Array; kind: 'presentation' | 'spreadsheet'; onError: (message: string) => void }) {
  const [result, setResult] = useState<OfficePreviewResult | null>(null);
  const [selected, setSelected] = useState(0);
  const [slideUrl, setSlideUrl] = useState('');
  useEffect(() => {
    const worker = new Worker(new URL('../lib/office-preview.worker.ts', import.meta.url), { type: 'module' });
    const timeout = setTimeout(() => { worker.terminate(); onError(t('filePreview.invalidFile')); }, 30_000);
    worker.onmessage = (event: MessageEvent<{ result?: OfficePreviewResult; error?: boolean }>) => {
      clearTimeout(timeout);
      if (event.data.result) setResult(event.data.result);
      else onError(t('filePreview.invalidFile'));
      worker.terminate();
    };
    worker.onerror = () => { clearTimeout(timeout); worker.terminate(); onError(t('filePreview.invalidFile')); };
    const copy = data.slice();
    worker.postMessage({ data: copy, kind }, [copy.buffer]);
    return () => { clearTimeout(timeout); worker.terminate(); };
  }, [data, kind, onError]);

  useEffect(() => {
    if (result?.kind !== 'presentation') return;
    // SVG is an image document: scripts, links and external subresources cannot run.
    // Never insert the renderer's markup into the app DOM.
    const url = URL.createObjectURL(new Blob([result.slides[selected].svg], { type: 'image/svg+xml' }));
    setSlideUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result, selected]);

  if (!result) return <div role="status" className="flex flex-1 items-center justify-center text-sm text-ink-secondary">{t('filePreview.loading')}</div>;
  if (result.kind === 'presentation') return <>
    <div className="flex items-center justify-center gap-4 border-b border-hairline px-3 py-2 text-xs">
      <button type="button" aria-label={t('filePreview.previousSlide')} disabled={selected === 0} onClick={() => setSelected((value) => value - 1)} className="rounded-lg p-2 hover:bg-raised disabled:opacity-30"><ChevronLeft size={18} /></button>
      <span aria-live="polite">{t('filePreview.slide', { page: selected + 1, count: result.slides.length })}</span>
      <button type="button" aria-label={t('filePreview.nextSlide')} disabled={selected === result.slides.length - 1} onClick={() => setSelected((value) => value + 1)} className="rounded-lg p-2 hover:bg-raised disabled:opacity-30"><ChevronRight size={18} /></button>
    </div>
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-inset p-4 sm:p-8">{slideUrl && <img src={slideUrl} alt={result.slides[selected].text || t('filePreview.slide', { page: selected + 1, count: result.slides.length })} onError={() => onError(t('filePreview.invalidFile'))} className="max-h-full max-w-full bg-white shadow-lg" />}</div>
    <p className="border-t border-hairline px-4 py-2 text-[11px] text-ink-secondary">{t('filePreview.slideNote')}{result.truncated && ` ${t('filePreview.slidesLimited')}`}</p>
  </>;
  const sheet = result.sheets[selected];
  const columns = Math.max(1, ...sheet.rows.map((row) => row.length));
  return <>
    <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-2 text-xs"><label htmlFor="preview-sheet">{t('filePreview.sheet')}</label><select id="preview-sheet" value={selected} onChange={(event) => setSelected(Number(event.target.value))} className="max-w-64 rounded-md border border-hairline bg-inset px-3 py-1.5 text-ink">{result.sheets.map((item, index) => <option key={index} value={index}>{item.name}</option>)}</select></div>
    <div className="min-h-0 flex-1 overflow-auto bg-card"><table className="w-full border-collapse text-left text-xs"><caption className="sr-only">{sheet.name}</caption><thead className="sticky top-0 z-10 bg-inset"><tr><th className="border-b border-r border-hairline px-3 py-2" /><>{Array.from({ length: columns }, (_, index) => <th key={index} scope="col" className="min-w-28 border-b border-r border-hairline px-3 py-2 text-center font-medium text-ink-secondary">{columnName(index)}</th>)}</></tr></thead><tbody>{sheet.rows.map((row, index) => <tr key={index} className="hover:bg-raised/40"><th scope="row" className="sticky left-0 border-b border-r border-hairline bg-inset px-3 py-2 text-right font-normal text-ink-secondary">{index + 1}</th>{Array.from({ length: columns }, (_, column) => <td key={column} className="max-w-96 whitespace-pre-wrap break-words border-b border-r border-hairline/50 px-3 py-2">{row[column] || ''}</td>)}</tr>)}</tbody></table></div>
    <p className="border-t border-hairline px-4 py-2 text-[11px] text-ink-secondary">{t('filePreview.sheetNote')}{sheet.truncated && ` ${t('filePreview.sheetLimited')}`}</p>
  </>;
}

function columnName(index: number): string {
  let result = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + (value - 1) % 26) + result;
  return result;
}
