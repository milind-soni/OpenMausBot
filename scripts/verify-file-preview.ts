// Real web app and authenticated attachment routes on a disposable fake engine.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer, preview } from 'vite';
import { launchVerificationServer, runControlOmb } from './control-omb.ts';
import { previewPdf } from './testing/preview-pdf.ts';
import { previewPresentation, previewSpreadsheet } from './testing/preview-office.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = join(root, 'docs/verification/evidence/chat-previews');
mkdirSync(evidence, { recursive: true });
const mediaOnly = process.argv.includes('--media');
const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, [
  mediaOnly ? 'Here are the image and video:\n\n[Project image](<Project image.png>) [Project video](<Project motion.mp4>)'
    : 'The project files are ready to review:\n\n[Project notes](<Project field notes.pdf>) · [Workbook](<Project overview.xlsx>) · [Slides](<Project review.pptx>) \n\n[Image](<Project image.png>) [Video](<Project motion.mp4>)',
]);
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
let builtUi: Awaited<ReturnType<typeof preview>> | undefined;
try {
  const created = await runControlOmb(['new-bot', '--name', 'Document review', '--url', fixture.info.url]) as { bot: { id: string } };
  const video = join(root, 'scripts/testing/file-preview/sample.mp4');
  const samples = [
    { name: 'Project field notes.pdf', mime: 'application/pdf', bytes: new Uint8Array(previewPdf()) },
    { name: 'Project overview.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: previewSpreadsheet() },
    { name: 'Project review.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: await previewPresentation() },
    ...(existsSync(video) ? [{ name: 'Project motion.mp4', mime: 'video/mp4', bytes: new Uint8Array(readFileSync(video)) }] : []),
    { name: 'Project image.png', mime: 'image/png', bytes: new Uint8Array(readFileSync(join(root, 'scripts/testing/file-preview/sample.png'))) },
  ].filter((sample) => !mediaOnly || /^(image|video)\//.test(sample.mime));
  const uploaded: Array<{ path: string; name: string; image: boolean }> = [];
  const workspace = join(fixture.info.dataDir, 'workspaces', created.bot.id);
  mkdirSync(workspace, { recursive: true });
  for (const sample of samples) {
    writeFileSync(join(workspace, sample.name), sample.bytes);
    const image = sample.mime.startsWith('image/');
    const route = image ? '/api/attachments' : `/api/files?name=${encodeURIComponent(sample.name)}`;
    const response = await fetch(`${fixture.info.url}${route}`, { method: 'POST', headers: { 'content-type': sample.mime }, body: sample.bytes });
    if (!response.ok) {
      if (process.argv.includes('--baseline') && sample.mime === 'video/mp4') continue;
      throw new Error(`Fixture upload failed: ${response.status} ${await response.text()}`);
    }
    uploaded.push({ ...await response.json() as { path: string }, name: sample.name, image });
  }
  // The composer separates transport tags with blank lines (Markdown blocks).
  const tags = uploaded.map((file) => `<attached-${file.image ? 'image' : 'file'} path="${file.path}" name="${file.name}" />`).join('\n\n');
  const sent = await runControlOmb(['send', '--bot', created.bot.id, '--text', `Please review the project files.\n\n${tags}`, '--url', fixture.info.url]);
  const settled = await runControlOmb(['wait', '--bot', created.bot.id, '--timeout', '30', '--url', fixture.info.url]);
  const messages = await runControlOmb(['messages', '--bot', created.bot.id, '--url', fixture.info.url]);
  let previewUrl: string;
  if (process.argv.includes('--built')) {
    builtUi = await preview({ root, preview: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: fixture.info.url } } } });
    previewUrl = builtUi.resolvedUrls.local[0];
  } else {
    ui = await createServer({ root, cacheDir: join(fixture.info.dataDir, 'vite-cache'), server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: fixture.info.url } } } });
    await ui.listen();
    previewUrl = ui.resolvedUrls!.local[0];
  }
  const info = { ...fixture.info, previewUrl, botId: created.bot.id, uploaded, sent, settled, messages };
  writeFileSync(join(evidence, 'fixture.json'), JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info, null, 2));
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve); process.once('SIGTERM', resolve);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (input) => { if (String(input).trim() === 'stop') resolve(); });
    process.stdin.resume();
  });
  process.stdin.pause();
} finally {
  await ui?.close();
  try {
    await new Promise<void>((resolve, reject) => {
      if (!builtUi) { resolve(); return; }
      builtUi.httpServer.close((error) => error ? reject(error) : resolve());
      // EventSource keeps a connection open while the preview tab is visible.
      builtUi.httpServer.closeAllConnections();
    });
  } finally { await fixture.close(); }
  console.log(JSON.stringify({ cleaned: !existsSync(fixture.info.dataDir) }));
}
