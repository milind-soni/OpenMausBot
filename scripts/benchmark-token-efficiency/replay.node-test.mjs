import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

for (const changed of ['capture', 'helper']) test(`resume refuses a changed ${changed} before contacting the selected server`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omb-replay-'));
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    for await (const chunk of req) void chunk;
    if (req.url === '/status') res.end('{}');
    else res.end(`data: ${JSON.stringify({ usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}/`;
    const input = join(directory, 'capture.json'), output = join(directory, 'latency.json');
    const model = randomUUID();
    const capture = JSON.stringify({ label: 'fixture', workload: 'short', requests: [] });
    await writeFile(input, capture);
    await writeFile(output, JSON.stringify({ model, benchmarkUrl: origin, captureSha256: changed === 'capture' ? randomUUID() : createHash('sha256').update(capture).digest('hex'), helperSha256: changed === 'helper' ? randomUUID() : createHash('sha256').update(await readFile(new URL('./replay-splash.mjs', import.meta.url))).digest('hex'), namespace: randomUUID(), rows: [] }));
    let failed = false;
    try {
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./replay-splash.mjs', import.meta.url)), input, output], {
        env: { ...process.env, OMB_BENCHMARK_URL: origin, OMB_BENCHMARK_MODEL: model }, timeout: 10_000,
      });
    } catch (error) { failed = typeof error.code === 'number' && error.code !== 0; }
    assert.equal(failed, true);
    assert.equal(requests, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
