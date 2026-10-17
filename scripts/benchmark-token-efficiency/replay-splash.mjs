import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { benchmarkUrl } from './settings.mjs';

const [input, output] = process.argv.slice(2);
assert(input && output, 'Usage: replay-splash.mjs CAPTURE OUTPUT');
const captureBytes = readFileSync(input);
const capture = JSON.parse(captureBytes);
const captureSha256 = createHash('sha256').update(captureBytes).digest('hex');
const helperSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const baseUrl = benchmarkUrl();
const model = process.env.OMB_BENCHMARK_MODEL;
assert(model?.trim(), 'Set OMB_BENCHMARK_MODEL to the exact model ID on the selected local server');
const namespace = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')).namespace : randomBytes(8).toString('hex');
const report = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : { label: capture.label, workload: capture.workload, captureSha256, helperSha256, sourceRevision: capture.sourceRevision, sourceDirty: capture.sourceDirty, catalogHash: capture.catalogHash, benchmarkUrl: baseUrl.href, namespace, startedAt: new Date().toISOString(), model, latencyMethod: 'Fixed scripted request replay, one generated token per completion, no model-generated operation is executed. Unique constant namespace precedes the first tool description when tools exist, otherwise first message content; it reduces reuse without flushing the user cache, but template prefixes preceding that location may remain cached.', rows: [] };
assert(report.model === model && report.benchmarkUrl === baseUrl.href && report.captureSha256 === captureSha256 && report.helperSha256 === helperSha256, 'Resume requires the same capture, model, endpoint and replay helper');
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
const health = async () => {
  try {
    const response = await fetch(new URL('status', baseUrl), { signal: AbortSignal.timeout(10000) });
    return await response.json();
  } catch (error) { return { error: String(error) }; }
};
const complete = body => new Promise((resolve, reject) => {
  const started = performance.now();
  let firstTokenMs = null, raw = '';
  const request = httpRequest(new URL('v1/chat/completions', baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
    response.setEncoding('utf8');
    response.on('data', chunk => {
      raw += chunk;
      if (firstTokenMs === null && /"(?:content|reasoning_content|reasoning)"\s*:\s*"[^"\s]|"tool_calls"\s*:\s*\[\s*\{/.test(raw)) firstTokenMs = performance.now() - started;
    });
    response.on('error', reject);
    response.on('end', () => {
      clearTimeout(timeout);
      if (response.statusCode !== 200) { reject(new Error(`HTTP ${response.statusCode}: ${raw.slice(0, 1200)}`)); return; }
      const frames = raw.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
      const usage = frames.findLast(frame => frame.usage)?.usage;
      if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || !Number.isSafeInteger(usage.prompt_tokens_details?.cached_tokens)) { reject(new Error('Missing measured prompt/cache usage: ' + raw.slice(-1500))); return; }
      resolve({ wallMs: Math.round(performance.now() - started), firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs), usage, raw });
    });
  });
  request.on('error', reject);
  const timeout = setTimeout(() => request.destroy(new Error('Benchmark request exceeded 45 minutes')), 2700000);
  request.on('close', () => clearTimeout(timeout));
  request.end(JSON.stringify(body));
});
if (report.rows.length === 0) {
  report.statusBefore = await health(); save();
  const warmup = await complete({ model, messages: [{ role: 'user', content: 'Benchmark warm-up. Reply OK.' }], stream: true, stream_options: { include_usage: true }, max_tokens: 1, temperature: 0, reasoning_effort: 'none' });
  report.warmup = { wallMs: warmup.wallMs, usage: warmup.usage }; save();
}
for (const [index, record] of capture.requests.entries()) {
  if (report.rows.some(row => row.request === index + 1)) continue;
  const body = structuredClone(record.request);
  body.model = model; body.reasoning_effort = "none"; body.max_tokens = 1; body.temperature = 0; body.stream = true; body.stream_options = { include_usage: true };
  assert(['system', 'user'].includes(body.messages[0]?.role) && typeof body.messages[0].content === 'string');
  const noncePlacement = body.tools?.length ? 'first-tool-description' : 'first-message-content';
  if (body.tools?.length) {
    assert(body.tools[0]?.function, 'First tool must use the function schema');
    body.tools[0].function.description = `Synthetic benchmark namespace ${namespace}.\n` + (body.tools[0].function.description ?? '');
  } else body.messages[0].content = `Synthetic benchmark namespace ${namespace}.\n` + body.messages[0].content;
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  report.pending = { request: index + 1, turn: record.turn, round: record.round, startedAt: new Date().toISOString(), requestHash: hash, noncePlacement, reasoningEffort: body.reasoning_effort }; save();
  console.log(JSON.stringify({ label: capture.label, workload: capture.workload, event: 'start', ...report.pending }));
  try {
    const result = await complete(body);
    const row = { request: index + 1, turn: record.turn, round: record.round, phase: record.phase, requestHash: hash, noncePlacement, wallMs: result.wallMs, firstTokenMs: result.firstTokenMs, usage: result.usage, raw: result.raw, statusAfter: await health() };
    report.rows.push(row); delete report.pending; save();
    console.log(JSON.stringify({ label: capture.label, workload: capture.workload, request: index + 1, turn: record.turn, wallMs: row.wallMs, firstTokenMs: row.firstTokenMs, prompt: row.usage.prompt_tokens, cached: row.usage.prompt_tokens_details.cached_tokens, output: row.usage.completion_tokens }));
  } catch (error) { report.error = String(error); report.failedAt = new Date().toISOString(); report.statusOnFailure = await health(); save(); throw error; }
}
report.completedAt = new Date().toISOString(); delete report.error; save();
console.log(JSON.stringify({ label: report.label, workload: report.workload, complete: true, requests: report.rows.length, wallMs: report.rows.reduce((sum, row) => sum + row.wallMs, 0) }));
