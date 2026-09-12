import type { OfficePreviewResult } from './file-preview';
import { prepareOfficeArchive } from './office-preview-limits';

export async function parseOfficePreview(data: Uint8Array, kind: 'presentation' | 'spreadsheet', thumbnail = false): Promise<OfficePreviewResult> {
    data = prepareOfficeArchive(data);
    let result: OfficePreviewResult;
    if (kind === 'presentation') {
      const { loadPresentation, getSlides, getSlideText } = await import('@office-kit/pptx');
      const { renderSlideToSvg } = await import('@office-kit/pptx-preview');
      const presentation = await loadPresentation(data);
      const all = getSlides(presentation);
      if (!all.length) throw new Error('empty');
      let renderedBytes = 0;
      result = { kind, truncated: all.length > 100, slides: all.slice(0, thumbnail ? 1 : 100).map((slide) => {
        const svg = renderSlideToSvg(presentation, slide);
        renderedBytes += svg.length;
        if (renderedBytes > 50_000_000) throw new Error('preview too large');
        return { svg, text: getSlideText(slide).slice(0, 10000) };
      }) };
    } else {
      const { read, utils } = await import('xlsx');
      const book = read(data, { type: 'array', sheetRows: thumbnail ? 7 : 501, cellHTML: false, cellFormula: false, cellText: true, bookVBA: false });
      if (!book.SheetNames.length) throw new Error('empty');
      if (book.SheetNames.length > 50) throw new Error('too many sheets');
      let characters = 0;
      const sheets = book.SheetNames.slice(0, thumbnail ? 1 : 50).map((name) => {
        const sheet = book.Sheets[name];
        const range = utils.decode_range(sheet['!ref'] || 'A1');
        const fullRange = utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
        let truncated = fullRange.e.r >= 500 || fullRange.e.c >= 100;
        range.s = { r: 0, c: 0 };
        range.e = { r: Math.min(range.e.r, thumbnail ? 5 : 499), c: Math.min(range.e.c, thumbnail ? 3 : 99) };
        const rows = utils.sheet_to_json<string[]>(sheet, { header: 1, range, raw: false, defval: '', blankrows: true }).map((row) => row.map((cell) => {
          const text = String(cell);
          if (text.length <= 4000) return text;
          truncated = true;
          return `${text.slice(0, 4000)}…`;
        }));
        characters += rows.reduce((total, row) => total + row.reduce((sum, cell) => sum + cell.length, 0), 0);
        if (characters > 2_000_000) throw new Error('preview too large');
        return { name, rows, truncated };
      });
      result = { kind, sheets };
    }
    return result;
}
