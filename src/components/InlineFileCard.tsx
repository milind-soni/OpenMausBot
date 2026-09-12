import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { FileText, ImageOff, LoaderCircle, Maximize2, Play } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { FilePreviewKind } from '@/lib/file-preview';
import { FileExtensionBadge } from './FileExtensionBadge';

const DocumentThumbnail = lazy(() => import('./DocumentThumbnail'));

export function InlineFileCard({ kind, path, label, caption, file, error, visible, expanded, onExpand }: {
  kind: FilePreviewKind; path: string; label: string; caption?: ReactNode;
  file?: { data: Uint8Array; url: string }; error?: string; visible: boolean;
  expanded: boolean; onExpand: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [readyUrl, setReadyUrl] = useState('');
  const [failedUrl, setFailedUrl] = useState('');
  const [started, setStarted] = useState(false);
  const [duration, setDuration] = useState('');
  const url = file?.url;
  const ready = !!url && readyUrl === url;
  const failed = !!error || (!!url && failedUrl === url);
  const document = kind !== 'image' && kind !== 'video';
  useEffect(() => {
    if (!visible || expanded) video.current?.pause();
    if (!visible) setStarted(false);
  }, [visible, expanded]);
  useEffect(() => { setStarted(false); setDuration(''); }, [url]);

  const play = () => {
    if (!video.current || !ready || failed) { onExpand(); return; }
    // Only the user's click starts playback; loading and scrolling never do.
    video.current.currentTime = 0;
    setStarted(true);
    void video.current.play().catch(() => setStarted(false));
  };
  const open = () => { video.current?.pause(); onExpand(); };

  return <span className={`group/file my-1 inline-flex ${document ? 'w-48' : 'w-64'} max-w-full flex-col overflow-hidden rounded-xl border border-hairline/50 bg-inset text-left align-top`}>
    <span className={`relative block aspect-video w-full overflow-hidden ${document ? `bg-inset p-2 ${kind === 'spreadsheet' ? 'pt-8' : ''}` : 'bg-black/90'}`}>
      {file && !failed && (document ?
        <ThumbnailBoundary key={file.url} onError={() => setFailedUrl(file.url)}><Suspense fallback={<Loading />}><DocumentThumbnail data={file.data} kind={kind} onReady={() => setReadyUrl(file.url)} onError={() => setFailedUrl(file.url)} /></Suspense></ThumbnailBoundary>
        : kind === 'image' ?
          <img src={file.url} alt="" onLoad={() => setReadyUrl(file.url)} onError={() => setFailedUrl(file.url)} className="h-full w-full object-contain" />
          : <video ref={video} src={file.url} controls={started} playsInline preload="metadata" aria-label={label}
              tabIndex={started ? 0 : -1} onError={() => setFailedUrl(file.url)}
              onLoadedMetadata={(event) => {
                const element = event.currentTarget;
                setReadyUrl(file.url);
                const seconds = Math.floor(element.duration);
                setDuration(Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '');
                if (element.duration > 0.1 && !started) element.currentTime = 0.1;
              }} onLoadedData={() => setReadyUrl(file.url)}
              className="h-full w-full object-contain" />)}
      {!ready && !failed && <Loading />}
      {failed && <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center text-ink-secondary"><ImageOff size={24} /></span>}
      {(!started || kind !== 'video' || failed) && <button type="button"
        onClick={kind === 'video' && !failed ? play : open}
        aria-label={kind === 'video' && !failed ? t('filePreview.playInline', { name: label }) : t('filePreview.open', { name: label })}
        className="absolute inset-0 flex items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-accent">
        {ready && !failed && <span aria-hidden="true" className={`${document ? 'opacity-0 group-hover/file:opacity-100 group-focus-within/file:opacity-100' : ''} flex size-10 items-center justify-center rounded-full border border-white/30 bg-black/50 text-white transition-opacity`}>
          {kind === 'video' ? <Play size={20} fill="currentColor" /> : <Maximize2 size={17} />}
        </span>}
      </button>}
      {kind === 'video' && !started && ready && !failed && duration && <span aria-hidden="true" className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-[10px] text-white">{duration}</span>}
      <FileExtensionBadge filename={path} />
    </span>
    <button type="button" onClick={open} aria-label={t('filePreview.open', { name: label })}
      className="flex w-full min-w-0 items-center gap-2 border-t border-hairline/40 px-3 py-2 text-left hover:bg-raised/70 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-accent">
      {document && <FileText size={15} className="shrink-0 text-accent" />}
      <span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-medium text-ink">{caption || label}</span>
        <span className="mt-0.5 block text-[10px] text-ink-secondary">{failed ? t('filePreview.thumbnailFailed') : document ? t(kind === 'presentation' ? 'filePreview.coverSlide' : kind === 'pdf' ? 'filePreview.coverPage' : 'filePreview.coverSheet') : t('filePreview.hint')}</span></span>
      <Maximize2 size={13} className="shrink-0 text-ink-secondary" />
    </button>
  </span>;
}

function Loading() {
  return <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center text-ink-secondary"><LoaderCircle size={20} className="animate-spin" /></span>;
}

class ThumbnailBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}
