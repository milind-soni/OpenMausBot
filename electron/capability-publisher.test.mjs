import { describe, expect, it } from 'vitest';
import { createCapabilityPublisher } from './capability-publisher.mjs';

describe('desktop capability publication', () => {
  it('publishes local native availability only to the local app and rail', async () => {
    let handler;
    const sent = [], rail = [];
    const window = (url, destroyed = false) => ({ isDestroyed: () => destroyed, webContents: { getURL: () => url, send: (_channel, data) => sent.push({ url, data }) } });
    const publish = createCapabilityPublisher({
      ipcMain: { handle: (_name, fn) => { handler = fn; } }, isLocalSender: event => event.local,
      facts: () => ({ platform: 'win32', nativeBrowser: true, frame: true }), connection: async () => null,
      rail: value => rail.push(value), origin: () => 'http://127.0.0.1:8799',
      windows: () => [window('http://127.0.0.1:8799/'), window('https://other.test/'), window('not a URL'), window('http://127.0.0.1:8799/', true)],
    });
    expect((await handler({ local: true })).nativeBrowser.available).toBe(true);
    expect((await handler({ local: false })).nativeBrowser.available).toBe(false);
    await publish();
    expect(rail[0].nativeBrowser.available).toBe(true);
    expect(sent.map(item => item.data.nativeBrowser.available)).toEqual([true, false, false]);
  });
});
