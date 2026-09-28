import { describe, expect, it } from 'vitest';
import { filePreviewKind, fileRequestUrl, previewDisplayName, previewMimeAllowed } from './file-preview';
import { parseOfficePreview } from './parse-office-preview';
import { checkOfficeArchive } from './office-preview-limits';
import { previewPresentation, previewSpreadsheet } from '../../scripts/testing/preview-office';
import { utils, write } from 'xlsx';

describe('file preview boundaries', () => {
  it('uses the path suffix and requires the response MIME to agree', () => {
    expect(filePreviewKind('C:\\reports\\REPORT.PDF')).toBe('pdf');
    expect(filePreviewKind('/report.pdf.exe')).toBeNull();
    expect(filePreviewKind('/report.ppt')).toBeNull();
    expect(previewDisplayName('Project%20notes.pdf')).toBe('Project notes.pdf');
    expect(previewDisplayName('100%.pdf')).toBe('100%.pdf');
    expect(previewMimeAllowed('pdf', 'text/html')).toBe(false);
    expect(previewMimeAllowed('video', 'application/octet-stream')).toBe(false);
    expect(previewMimeAllowed('spreadsheet', 'text/csv; charset=utf-8')).toBe(true);
    expect(fileRequestUrl({ threadId: 'a/b', messageId: '../c' })).toBe('/api/threads/a%2Fb/messages/..%2Fc/file');
  });

  it('parses both spreadsheet tabs, cached formula values and literal markup', async () => {
    const result = await parseOfficePreview(previewSpreadsheet(), 'spreadsheet');
    if (result.kind !== 'spreadsheet') throw new Error('wrong preview');
    expect(result.sheets.map((sheet) => sheet.name)).toEqual(['Overview', 'Checks']);
    expect(result.sheets[0].rows[4][3]).toBe('24');
    expect(result.sheets[1].rows[4][1]).toBe('<img src=x onerror=alert(1)>');
  });

  it('renders real slide content and keeps slide ordering', async () => {
    const result = await parseOfficePreview(await previewPresentation(), 'presentation');
    if (result.kind !== 'presentation') throw new Error('wrong preview');
    expect(result.slides).toHaveLength(2);
    expect(result.slides[0].svg).toContain('Project field notes');
    expect(result.slides[1].text).toContain('Review together');
    expect(result.slides[0].svg).not.toContain('<script');
  });

  it('limits automatic thumbnails to the first slide and a small first-sheet grid', async () => {
    const slides = await parseOfficePreview(await previewPresentation(), 'presentation', true);
    if (slides.kind !== 'presentation') throw new Error('wrong preview');
    expect(slides.slides).toHaveLength(1);
    expect(slides.slides[0].text).toContain('Project field notes');
    const workbook = await parseOfficePreview(previewSpreadsheet(), 'spreadsheet', true);
    if (workbook.kind !== 'spreadsheet') throw new Error('wrong preview');
    expect(workbook.sheets).toHaveLength(1);
    expect(workbook.sheets[0].rows.length).toBeLessThanOrEqual(6);
    expect(workbook.sheets[0].rows.every(row => row.length <= 4)).toBe(true);
  });

  it('bounds a wide and tall sheet and reports truncation', async () => {
    const book = utils.book_new();
    const sheet = utils.aoa_to_sheet([['First']]);
    sheet['Z1000'] = { t: 's', v: 'Last' };
    sheet['!ref'] = 'A1:ZZ1000';
    utils.book_append_sheet(book, sheet, 'Large');
    const result = await parseOfficePreview(new Uint8Array(write(book, { type: 'array', bookType: 'xlsx' })), 'spreadsheet');
    if (result.kind !== 'spreadsheet') throw new Error('wrong preview');
    expect(result.sheets[0].truncated).toBe(true);
    expect(result.sheets[0].rows.length).toBeLessThanOrEqual(500);
    expect(result.sheets[0].rows.every((row) => row.length <= 100)).toBe(true);
  });

  it('rejects malformed and oversized ZIP directories before inflation', () => {
    expect(() => checkOfficeArchive(new Uint8Array([80, 75, 3, 4]))).toThrow();
    const data = new Uint8Array(68);
    const view = new DataView(data.buffer);
    data[0] = 80; data[1] = 75;
    view.setUint32(0, 0x02014b50, true);
    view.setUint32(24, 200_000_000, true);
    view.setUint32(46, 0x06054b50, true);
    view.setUint16(56, 1, true);
    expect(() => checkOfficeArchive(data)).toThrow('archive too large');
  });
});
