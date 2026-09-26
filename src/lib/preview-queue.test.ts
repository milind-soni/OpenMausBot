import { describe, expect, it } from 'vitest';
import { createPreviewQueue } from './preview-queue';

describe('thumbnail work queue', () => {
  it('bounds active work and removes an aborted waiter without leaking a slot', async () => {
    const acquire = createPreviewQueue(1);
    const active = await acquire(new AbortController().signal);
    const cancelled = new AbortController();
    const waiting = acquire(cancelled.signal);
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    cancelled.abort();
    await rejected;
    let started = false;
    const next = acquire(new AbortController().signal).then(release => { started = true; return release; });
    await Promise.resolve();
    expect(started).toBe(false);
    active(); active();
    (await next)();
    const last = await acquire(new AbortController().signal);
    last();
  });
});
