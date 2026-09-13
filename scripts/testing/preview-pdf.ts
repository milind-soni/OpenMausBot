// Small, deterministic two-page PDF for the isolated browser fixture.
export function previewPdf(): Buffer {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    '',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const pages = [
    '0.08 0.16 0.20 rg 0 600 612 192 re f 1 1 1 rg BT /F1 30 Tf 50 700 Td (Project field notes) Tj 0 -44 Td /F1 14 Tf (OPENMAUSBOT / WEB PREVIEW) Tj ET 0.12 0.2 0.25 rg BT /F1 18 Tf 50 535 Td (01 / A document inside the conversation) Tj 0 -40 Td /F1 12 Tf (Review the PDF without leaving your chat.) Tj 0 -26 Td (Use the page controls to continue to the checklist.) Tj ET 0.2 0.65 0.55 rg 50 390 512 5 re f',
    '0.08 0.16 0.20 rg BT /F1 28 Tf 50 700 Td (Preview checklist) Tj 0 -60 Td /F1 16 Tf (Page 2 of 2) Tj 0 -50 Td /F1 14 Tf (1. Open the attachment in the web app.) Tj 0 -35 Td (2. Navigate between pages and adjust zoom.) Tj 0 -35 Td (3. Download a copy when needed.) Tj ET',
  ];
  pages.forEach((stream, index) => { objects[index * 2 + 3] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`; });
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
