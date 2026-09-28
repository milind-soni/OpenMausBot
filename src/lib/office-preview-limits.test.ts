import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { checkOfficeArchive, prepareOfficeArchive } from './office-preview-limits';
import { parseOfficePreview } from './parse-office-preview';

function declareSize(data: Uint8Array, size: number) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const directory = view.getUint32(data.length - 6, true);
  const local = view.getUint32(directory + 42, true);
  view.setUint32(directory + 24, size, true);
  view.setUint32(local + 22, size, true);
  return data;
}

describe('bounded Office ZIP inflation', () => {
  it.each([0, 6] as const)('rebuilds method level %i archives as stored entries with identical bytes', (level) => {
    const files = { 'xl/workbook.xml': strToU8('<workbook>example</workbook>'.repeat(4000)), 'ppt/日本語.xml': strToU8('slide') };
    const safe = prepareOfficeArchive(zipSync(files, { level }));
    expect(unzipSync(safe)).toEqual(files);
    const view = new DataView(safe.buffer, safe.byteOffset, safe.byteLength);
    expect(view.getUint16(8, true)).toBe(0);
  });

  it.each(['presentation', 'spreadsheet'] as const)('rejects underreported inflated bytes before the %s parser', async (kind) => {
    const forged = declareSize(zipSync({ 'part.xml': new Uint8Array(256 * 1024) }), 1024);
    expect(() => checkOfficeArchive(forged)).not.toThrow();
    expect(() => prepareOfficeArchive(forged)).toThrow('inflated output exceeds limit');
    await expect(parseOfficePreview(forged, kind)).rejects.toThrow('inflated output exceeds limit');
  });

  it('rejects a stored entry whose actual size exceeds its declaration', () => {
    const forged = declareSize(zipSync({ 'part.xml': new Uint8Array(4096) }, { level: 0 }), 1);
    expect(() => prepareOfficeArchive(forged)).toThrow('inflated output exceeds limit');
  });

  it('rejects the declared per-part and cumulative limits before allocating output', () => {
    expect(() => prepareOfficeArchive(declareSize(zipSync({ a: new Uint8Array(1) }), 26 * 1024 * 1024))).toThrow('archive too large');
    const archive = zipSync(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(name => [name, new Uint8Array(1)])));
    const view = new DataView(archive.buffer);
    let offset = view.getUint32(archive.length - 6, true);
    for (let i = 0; i < 5; i++) {
      view.setUint32(offset + 24, 25 * 1024 * 1024, true);
      offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    expect(() => prepareOfficeArchive(archive)).toThrow('archive too large');
  });

  it('rejects inconsistent local headers and keeps text inputs unchanged', () => {
    const archive = zipSync({ 'part.xml': strToU8('ok') });
    archive[30] ^= 1;
    expect(() => prepareOfficeArchive(archive)).toThrow('invalid ZIP filename');
    const csv = strToU8('a,b\n1,2');
    expect(prepareOfficeArchive(csv)).toBe(csv);
  });
});
