// Bundle PDF.js resources locally, including CMaps needed by many CJK PDFs.
// A document can select only a known filename, never an arbitrary resource URL.
const assets = {
  cMapUrl: import.meta.glob('../../node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url', import: 'default', eager: true }),
  standardFontDataUrl: import.meta.glob('../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { query: '?url', import: 'default', eager: true }),
  wasmUrl: import.meta.glob('../../node_modules/pdfjs-dist/wasm/*.wasm', { query: '?url', import: 'default', eager: true }),
};

export class PreviewBinaryDataFactory {
  async fetch({ kind, filename }: { kind: keyof typeof assets; filename: string }): Promise<Uint8Array> {
    const entries = assets[kind];
    const url = entries && Object.entries(entries).find(([path]) => path.split('/').at(-1) === filename)?.[1];
    if (typeof url !== 'string') throw new Error('Unknown PDF resource');
    const response = await fetch(url);
    if (!response.ok) throw new Error('PDF resource unavailable');
    return new Uint8Array(await response.arrayBuffer());
  }
}
