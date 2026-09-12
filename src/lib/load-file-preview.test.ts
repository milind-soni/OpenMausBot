import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFilePreview, PREVIEW_MAX_BYTES } from './load-file-preview';
import { setLocale } from './i18n';

const message = { threadId: 'thread/one', messageId: 'message/two' };
beforeEach(() => setLocale('en'));
afterEach(() => vi.unstubAllGlobals());

describe('automatic media preview downloads', () => {
  it('sends a path only in the message-authorized POST body and preserves bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetch = vi.fn().mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const result = await loadFilePreview(message, '/private/movie.mp4', 'video', signal);
    expect(fetch).toHaveBeenCalledWith('/api/threads/thread%2Fone/messages/message%2Ftwo/file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/private/movie.mp4' }), signal,
    });
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    { status: 403, mime: 'video/mp4', length: '2' },
    { status: 200, mime: 'text/html', length: '2' },
    { status: 200, mime: 'video/mp4', length: String(PREVIEW_MAX_BYTES + 1) },
  ])('cancels denied, mismatched and oversized responses before reading ($status/$mime/$length)', async ({ status, mime, length }) => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status, headers: { 'content-type': mime, 'content-length': length } })));
    await expect(loadFilePreview(message, 'movie.mp4', 'video', new AbortController().signal)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('stops a chunked response when it exceeds the limit without a Content-Length header', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'video/mp4' } })));
    await expect(loadFilePreview(message, 'movie.mp4', 'video', new AbortController().signal)).rejects.toThrow('25 MB');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not publish bytes from an aborted request', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      controller.abort();
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
    }));
    await expect(loadFilePreview(message, 'image.png', 'image', controller.signal)).rejects.toThrow();
  });
});
