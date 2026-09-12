import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileText, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { filePreviewKind, previewDisplayName, type FilePreviewKind } from '@/lib/file-preview';
import { loadFilePreview } from '@/lib/load-file-preview';
import { t } from '@/lib/i18n';
import { InlineFileCard } from './InlineFileCard';
import { acquirePreviewSlot } from '@/lib/preview-queue';
import { canonicalDownloadFilename, useLocalFileSave, type MessageAttachmentContext } from './AttachmentPreview';

const PdfPreview = lazy(() => import('./PdfPreview'));
const OfficePreview = lazy(() => import('./OfficePreview'));

interface LoadedPreview { data: Uint8Array; url: string; name: string }

function usePreviewFile(path: string, name: string, message: MessageAttachmentContext, kind: FilePreviewKind, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; file?: LoadedPreview; error?: string } | null>(null);
  const key = JSON.stringify([path, name, message.threadId, message.messageId, kind, attempt]);
  useEffect(() => {
    if (!enabled) { setResult(null); return; }
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setResult(null);
    void (async () => {
      const release = await acquirePreviewSlot(controller.signal);
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
      try {
        const { blob, disposition } = await loadFilePreview(message, path, kind, controller.signal);
        const data = new Uint8Array(await blob.arrayBuffer());
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setResult({ key, file: { data, url: objectUrl, name: canonicalDownloadFilename({ contentDisposition: disposition, fallback: name, mime: blob.type }) } });
      } catch (reason) {
        if (!controller.signal.aborted || timedOut) setResult({ key, error: timedOut ? t('filePreview.fetchFailed') : reason instanceof Error ? reason.message : t('filePreview.fetchFailed') });
      } finally { clearTimeout(timeout); release(); }
    })().catch(() => {});
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path, name, message.threadId, message.messageId, kind, enabled, key]);
  return {
    file: enabled && result?.key === key ? result.file : undefined,
    error: enabled && result?.key === key ? result.error : undefined,
    retry: () => setAttempt((value) => value + 1),
  };
}

export function PreviewableFile({ path, name, message, children, compact = false }: {
  path: string; name?: string; message: MessageAttachmentContext; children?: ReactNode; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = name || previewDisplayName(path);
  const kind = filePreviewKind(path)!;
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '160px' });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const resource = usePreviewFile(path, label, message, kind, open || visible);
  return <span ref={container} className="inline-flex max-w-full align-top">
    <InlineFileCard key={path} kind={kind} path={path} label={label} caption={compact ? children : undefined}
      file={resource.file} error={resource.error} visible={visible} expanded={open} onExpand={() => setOpen(true)} />
    {open && <FilePreviewDialog key={path} path={path} name={label} message={message} resource={resource} onClose={() => setOpen(false)} />}
  </span>;
}

function FilePreviewDialog({ path, name, message, resource, onClose }: { path: string; name: string; message: MessageAttachmentContext; resource: ReturnType<typeof usePreviewFile>; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const { file } = resource;
  const [renderError, setError] = useState('');
  const error = resource.error || renderError;
  const retry = () => { setError(''); resource.retry(); };
  const save = useLocalFileSave(path, name, message);
  const kind = filePreviewKind(path)!;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById('root');
    const previousInert = root?.inert;
    if (root) root.inert = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, [tabindex="0"]') ?? [])];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (root) root.inert = previousInert ?? false;
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  return createPortal(<div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-2 backdrop-blur-sm sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t('filePreview.open', { name })} tabIndex={-1} className="flex h-full max-h-[1100px] w-full max-w-[1280px] flex-col overflow-hidden rounded-2xl border border-hairline bg-card text-ink shadow-2xl outline-none">
      <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-3">
        <FileText size={20} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{file?.name || name}</div><div className="text-[11px] text-ink-secondary">{t('filePreview.document')}</div></div>
        {file ? <a href={file.url} download={file.name} aria-label={t('filePreview.download')} title={t('filePreview.download')} className="rounded-lg p-2 hover:bg-raised"><Download size={18} /></a> : <button type="button" onClick={() => void save.save()} disabled={save.state === 'saving'} aria-label={t('filePreview.download')} className="rounded-lg p-2 hover:bg-raised"><Download size={18} /></button>}
        <button type="button" onClick={onClose} aria-label={t('filePreview.close')} className="rounded-lg p-2 hover:bg-raised"><X size={20} /></button>
      </header>
      {error ? <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center" role="alert"><FileText size={36} className="text-ink-secondary" /><p>{error}</p><button type="button" onClick={retry} className="flex items-center gap-2 rounded-lg border border-hairline px-4 py-2"><RotateCcw size={15} />{t('filePreview.retry')}</button></div> : file ? kind === 'video' ? <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-4"><video src={file.url} tabIndex={0} controls playsInline preload="metadata" aria-label={file.name} onError={() => setError(t('filePreview.videoFailed'))} className="max-h-full max-w-full" /></div> : kind === 'image' ? <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-inset p-4"><img src={file.url} alt={file.name} onError={() => setError(t('filePreview.invalidFile'))} className="max-h-full max-w-full object-contain" /></div> : <PreviewBoundary onError={setError}><Suspense fallback={<PreviewLoading />}>{kind === 'pdf' ? <PdfPreview data={file.data} onError={setError} /> : <OfficePreview data={file.data} kind={kind} onError={setError} />}</Suspense></PreviewBoundary> : <PreviewLoading />}
      {save.state === 'failed' && <p role="alert" className="p-3 text-sm text-danger">{save.reason}</p>}
    </div>
  </div>, document.body);
}

export function PreviewLoading() {
  return <div role="status" className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-ink-secondary"><LoaderCircle size={18} className="animate-spin" />{t('filePreview.loading')}</div>;
}

class PreviewBoundary extends Component<{ children: ReactNode; onError: (message: string) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(t('filePreview.invalidFile')); }
  render() { return this.state.failed ? null : this.props.children; }
}
