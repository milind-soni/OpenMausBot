import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchVerificationServer, runControlOmb, type VerificationServer } from '../scripts/control-omb.ts';
import { previewPdf } from '../scripts/testing/preview-pdf.ts';
import { previewPresentation, previewSpreadsheet } from '../scripts/testing/preview-office.ts';

describe('web file previews use message-authorized downloads', () => {
  let fixture: VerificationServer;
  beforeAll(async () => { fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: '["Inherited reply must not win"]' }, undefined, undefined, undefined, undefined, ['[Movie](sample.mp4)']); }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it('downloads PDF, workbook, slides and video only for their stored message', async () => {
    const created = await runControlOmb(['new-bot', '--name', 'Preview test', '--url', fixture.info.url]) as { bot: { id: string } };
    const samples = [
      { name: 'sample.pdf', mime: 'application/pdf', bytes: new Uint8Array(previewPdf()) },
      { name: 'sample.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: previewSpreadsheet() },
      { name: 'sample.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: await previewPresentation() },
      { name: 'sample.mp4', mime: 'video/mp4', bytes: new Uint8Array(readFileSync(fileURLToPath(new URL('../scripts/testing/file-preview/sample.mp4', import.meta.url)))) },
    ];
    const files: Array<{ path: string; name: string }> = [];
    for (const sample of samples) {
      const response = await fetch(`${fixture.info.url}/api/files?name=${sample.name}`, { method: 'POST', headers: { 'content-type': sample.mime }, body: sample.bytes });
      expect(response.status).toBe(201);
      files.push(await response.json() as { path: string; name: string });
    }
    const workspace = join(fixture.info.dataDir, 'workspaces', created.bot.id);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'sample.mp4'), samples[3].bytes);
    await runControlOmb(['send', '--bot', created.bot.id, '--text', files.map((file) => `<attached-file path="${file.path}" name="${file.name}" />`).join('\n\n'), '--url', fixture.info.url]);
    const result = await runControlOmb(['wait', '--bot', created.bot.id, '--timeout', '15', '--url', fixture.info.url]) as { status: string; taskId: string; messages: Array<{ id: string; role: string; text?: string }> };
    expect(result.status).toBe('settled');
    const user = result.messages.find((message) => message.role === 'user')!;
    const bot = result.messages.find((message) => message.text === '[Movie](sample.mp4)')!;
    expect(bot).toBeTruthy();
    const download = (messageId: string, path: string) => fetch(`${fixture.info.url}/api/threads/${result.taskId}/messages/${messageId}/file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    for (const [index, file] of files.entries()) {
      const response = await download(user.id, file.path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(samples[index].mime);
      expect(response.headers.get('content-disposition')).toContain('attachment;');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(samples[index].bytes);
      expect((await download(bot.id, file.path)).status).toBe(403);
    }
    expect((await download(bot.id, 'sample.mp4')).status).toBe(200);
    expect((await download(user.id, join(workspace, 'sample.mp4'))).status).toBe(403);
  }, 30_000);
});
