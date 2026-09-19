import { afterEach, expect, it, vi } from 'vitest';
import { createPreviewBinaryDataFactory } from './pdf-preview-assets';

afterEach(() => vi.unstubAllGlobals());

it('cancels an in-flight resource body and keeps another preview independent', async () => {
  const first = new AbortController();
  const second = new AbortController();
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, { signal }: { signal: AbortSignal }) => ({
    ok: true,
    arrayBuffer: () => {
      if (signal === second.signal) return Promise.resolve(new Uint8Array([1, 2]).buffer);
      notifyStarted();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  })));
  const resource = { kind: 'standardFontDataUrl' as const, filename: 'LiberationSans-Regular.ttf' };
  const pending = new (createPreviewBinaryDataFactory(first.signal))().fetch(resource);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await started;
  first.abort();
  await rejected;
  await expect(new (createPreviewBinaryDataFactory(second.signal))().fetch(resource)).resolves.toEqual(new Uint8Array([1, 2]));
});

it('rejects cancelled previews and unknown resources without starting requests', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const Factory = createPreviewBinaryDataFactory(controller.signal);
  await expect(new Factory().fetch({ kind: 'cMapUrl', filename: '../private' })).rejects.toThrow('Unknown PDF resource');
  controller.abort();
  await expect(new Factory().fetch({ kind: 'standardFontDataUrl', filename: 'LiberationSans-Regular.ttf' })).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).not.toHaveBeenCalled();
});

it('preserves HTTP response validation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
  const Factory = createPreviewBinaryDataFactory(new AbortController().signal);
  await expect(new Factory().fetch({ kind: 'standardFontDataUrl', filename: 'LiberationSans-Regular.ttf' })).rejects.toThrow('PDF resource unavailable');
});
