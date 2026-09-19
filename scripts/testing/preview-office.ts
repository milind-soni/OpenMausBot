import { createPresentation, addBlankSlide, addSlideTextBox, setShapeTextFormat, setSlideBackground, savePresentation, inches } from '@office-kit/pptx';
import { utils, write } from 'xlsx';

export async function previewPresentation(): Promise<Uint8Array> {
  const deck = createPresentation();
  for (const [title, subtitle] of [
    ['Project field notes', 'OPENMAUSBOT / SLIDE PREVIEW'],
    ['Review together', 'Open a slide. Check the details. Keep the conversation.'],
  ]) {
    const slide = addBlankSlide(deck);
    setSlideBackground(slide, '142D38');
    const heading = addSlideTextBox(slide, { x: inches(0.8), y: inches(2), w: inches(11.5), h: inches(1.2), text: title });
    setShapeTextFormat(heading, { size: 44, color: 'FFFFFF', font: 'Arial' });
    const body = addSlideTextBox(slide, { x: inches(0.8), y: inches(3.5), w: inches(11.5), h: inches(1), text: subtitle });
    setShapeTextFormat(body, { size: 22, color: '80D6BB', font: 'Arial' });
  }
  return savePresentation(deck);
}

export function previewSpreadsheet(): Uint8Array {
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet([
    ['Project / プロジェクト', 'Owner / 担当', 'Status / 状態', 'Hours / 時間'],
    ['Web previews', 'Atlas', 'Ready for review', 12],
    ['Mobile layout', 'Juniper', 'In progress', 8],
    ['Documentation', 'Maki', 'Ready for review', 4],
    ['Total', '', '', { t: 'n', f: 'SUM(D2:D4)', v: 24 }],
  ]), 'Overview');
  utils.book_append_sheet(book, utils.aoa_to_sheet([
    ['Checkpoint', 'Result'], ['PDF pages', '2'], ['Presentation slides', '2'], ['Video length', '3 seconds'],
    ['Literal markup', '<img src=x onerror=alert(1)>'],
  ]), 'Checks');
  return new Uint8Array(write(book, { type: 'array', bookType: 'xlsx' }));
}
