import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { ompJsonLines, command } from '../process.mjs';
import { startHarness } from '../harnesses.mjs';
import { identityHash } from '../accounts.mjs';
import { UsageTotals, claudeUsage } from '../usage.mjs';
import { Runner } from '../worker.mjs';
import { atomicJson } from '../security.mjs';

async function adapterFixture(t, harness, script) {
  const root = await mkdtemp(join(tmpdir(), 'origin-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'native-fixture.mjs');
  await writeFile(executable, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\nimport { readFileSync } from 'node:fs';\nif (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY) throw new Error('Project key replaced native account environment');\nif (JSON.parse(readFileSync(process.env.ORIGIN_PROJECT_ENV_FILE, 'utf8')).OPENAI_API_KEY !== 'application-only-key') throw new Error('Protected application environment unavailable');\nconst send = value => console.log(JSON.stringify(value));\n${script}\n`, { mode: 0o700 });
  const projectEnvironmentFile = join(root, 'environment.json');
  await writeFile(projectEnvironmentFile, JSON.stringify({ OPENAI_API_KEY: 'application-only-key', ANTHROPIC_API_KEY: 'application-anthropic-key', GEMINI_API_KEY: 'application-gemini-key' }), { mode: 0o600 });
  const usage = [], approvals = [], logs = [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('Native adapter fixture timed out')), 10000);
  t.after(() => clearTimeout(timer));
  const context = { run: { selection: { harness, model: 'exact-model', effort: 'high' }, permissionMode: 'ask' }, account: { binding: { harness, executable }, report: { identityHash: identityHash('openai', { email: 'test@example.invalid', orgId: 'fixture-workspace' }), authKind: 'subscription' } }, cwd: root, sessionDirectory: root, signal: abort.signal, projectEnvironmentFile, prompt: 'work', output: (stream, text) => logs.push({ stream, text }), usage: value => usage.push(value), approve: async (tool, input) => { approvals.push({ tool, input }); return true; } };
  const handle = await startHarness(context);
  t.after(() => handle.stop());
  const result = await handle.done; await handle.stop();
  return { result, usage, approvals, logs };
}

test('OMP uses native RPC approval selection and cumulative token events', async t => {
  const result = await adapterFixture(t, 'omp', `
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'negotiate_protocol') send({ type: 'response', id: frame.id, success: true, data: { protocolVersion: 2 } });
  if (frame.type === 'get_state') send({ type: 'response', id: frame.id, success: true, data: { model: { id: 'exact-model', provider: 'openai' }, thinkingLevel: 'high' } });
  if (frame.type === 'prompt') send({ type: 'extension_ui_request', method: 'select', id: 'permission', title: 'Approve write file?', options: ['Approve', 'Approve all for this session', 'Deny'] });
  if (frame.type === 'extension_ui_response') {
    if (frame.value !== 'Approve') throw new Error('must grant once only');
    send({ type: 'message_end', message: { usage: { input: 10, output: 2 } } });
    send({ type: 'message_end', message: { usage: { input: 20, cacheRead: 5, output: 3 } } });
    send({ type: 'prompt_result', id: 'origin-prompt', agentInvoked: true, status: 'completed', sessionSettled: true });
  }
});
send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] });`);
  assert.equal(result.approvals.length, 1);
  assert.deepEqual(result.usage.at(-1), { inputTokens: 35, outputTokens: 5 });
});

test('Codex uses official app-server selection, permissions, totals and terminal receipt', async t => {
  const result = await adapterFixture(t, 'codex', `
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') send({ id: frame.id, result: {} });
  if (frame.method === 'account/read') send({ id: frame.id, result: { account: { type: 'chatgpt', email: 'test@example.invalid' }, workspaceRouting: { chatgptAccountId: 'fixture-workspace' } } });
  if (frame.method === 'thread/start') {
    if (frame.params.model !== 'exact-model' || frame.params.sandbox !== 'workspace-write') throw new Error('unsafe selection');
    send({ id: frame.id, result: { thread: { id: 'thread' } } });
  }
  if (frame.method === 'turn/start') {
    if (frame.params.effort !== 'high') throw new Error('effort missing');
    send({ id: frame.id, result: { turn: { id: 'turn' } } });
    send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', command: 'test' } });
  }
  if (frame.id === 'approval') {
    if (frame.result.decision !== 'accept') throw new Error('approval missing');
    send({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 20, outputTokens: 5 }, last: { inputTokens: 5, outputTokens: 1 } } } });
    send({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
  }
  if (frame.method === 'turn/interrupt') send({ id: frame.id, result: {} });
});`);
  assert.equal(result.approvals.length, 1);
  assert.deepEqual(result.usage[0], { inputTokens: 20, outputTokens: 5 });
  assert.match(result.result.summary, /Codex/);
});

test('Claude streaming control handles host approval and does not report subscription billing', async t => {
  const result = await adapterFixture(t, 'claude-code', `
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request' && frame.request.subtype === 'initialize') send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
  if (frame.type === 'user') send({ type: 'control_request', request_id: 'tool', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'test' } } });
  if (frame.type === 'control_response' && frame.response.request_id === 'tool') {
    if (frame.response.response.behavior !== 'allow') throw new Error('permission missing');
    send({ type: 'result', result: 'completed', is_error: false, usage: { input_tokens: 99, output_tokens: 1 }, modelUsage: { exact: { inputTokens: 100, cacheReadInputTokens: 10, outputTokens: 20 } }, total_cost_usd: 1.25 });
  }
});`);
  assert.equal(result.approvals.length, 1);
  assert.deepEqual(result.usage.at(-1), { inputTokens: 110, outputTokens: 20 });
});

for (const [code, expected, status] of [
  ['billing_error', 'needs_auth'], ['overloaded', 'provider_unavailable'],
  [undefined, 'needs_auth', 402], [undefined, 'failed'], ['rate_limit', 'failed'],
]) test(`Claude structured provider rejection preserves fallback classification: ${code ?? status ?? 'text-only'}`, async t => {
  await assert.rejects(adapterFixture(t, 'claude-code', `
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request' && frame.request.subtype === 'initialize') send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
  if (frame.type === 'user') {
    send({ type: 'assistant', error: ${JSON.stringify(code) ?? 'undefined'}, message: { content: [{ type: 'text', text: 'billing_error' }] } });
    send({ type: 'result', is_error: true, errors: ['billing_error'], api_error_status: ${status ?? 'undefined'} });
  }
});`), error => error.result === expected);
});

test('a recovered Claude provider error cannot misclassify a later turn failure', async t => {
  await assert.rejects(adapterFixture(t, 'claude-code', `
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request' && frame.request.subtype === 'initialize') send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
  if (frame.type === 'user') {
    send({ type: 'assistant', error: 'overloaded', message: { content: [] } });
    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Provider recovered' }] } });
    send({ type: 'result', is_error: true, subtype: 'error_max_turns', errors: ['Turn limit reached'] });
  }
});`), error => error.result === 'failed');
});

test('usage accounting never doubles cumulative totals across multiple native results', () => {
  const totals = new UsageTotals();
  assert.deepEqual(claudeUsage(totals, { modelUsage: { one: { inputTokens: 10, outputTokens: 2 } }, total_cost_usd: 0.5 }, true), { inputTokens: 10, outputTokens: 2, estimatedApiUsd: 0.5 });
  assert.deepEqual(claudeUsage(totals, { modelUsage: { one: { inputTokens: 20, outputTokens: 5 } }, total_cost_usd: 0.75 }, true), { inputTokens: 20, outputTokens: 5, estimatedApiUsd: 0.75 });
  const perTurn = new UsageTotals();
  claudeUsage(perTurn, { usage: { input_tokens: 10, output_tokens: 2 } }, false);
  assert.deepEqual(claudeUsage(perTurn, { usage: { input_tokens: 5, output_tokens: 1 } }, false), { inputTokens: 15, outputTokens: 3 });
});

test('server pause and local pause remain independent across heartbeat and local resume', async t => {
  const root = await mkdtemp(join(tmpdir(), 'origin-pause-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sent = []; let serverPause = true;
  const runner = new Runner({ dataDirectory: root, hostId: 'host' }, { client: { request: async (_op, payload) => { sent.push(payload); return { paused: serverPause }; } } });
  await runner.heartbeat(); assert.equal(sent.at(-1).paused, false); assert.equal(runner.paused, true);
  await atomicJson(join(root, 'control.json'), { paused: true }); serverPause = false;
  await runner.heartbeat(); assert.equal(sent.at(-1).paused, true); assert.equal(runner.paused, true);
  await atomicJson(join(root, 'control.json'), { paused: false }); serverPause = true;
  await runner.heartbeat(); assert.equal(sent.at(-1).paused, false); assert.equal(runner.paused, true);
});

test('Pi requires native agent_settled and its permission extension bridge approves once', async t => {
  const result = await adapterFixture(t, 'pi', `
createInterface({ input: process.stdin }).on('line', async line => {
  const frame = JSON.parse(line);
  if (frame.type === 'get_state') send({ type: 'response', id: frame.id, success: true, data: { model: { id: 'exact-model', provider: 'openai' }, thinkingLevel: 'high' } });
  if (frame.type !== 'prompt') return;
  const response = await fetch(process.env.ORIGIN_PERMISSION_ENDPOINT, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.ORIGIN_PERMISSION_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ toolName: 'bash', input: { command: 'test' } }) });
  if (!(await response.json()).allow) throw new Error('permission bridge denied');
  send({ type: 'message_end', message: { usage: { input: 10, output: 2 } } });
  send({ type: 'agent_end' });
  setTimeout(() => {
    send({ type: 'message_end', message: { usage: { input: 5, output: 1 } } });
    send({ type: 'agent_settled' });
  }, 20);
});`);
  assert.equal(result.approvals.length, 1);
  assert.deepEqual(result.usage.at(-1), { inputTokens: 15, outputTokens: 3 });
});

test('CLI lifecycle stop preserves deliberate pause without creating one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'origin-stop-control-')); t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  await atomicJson(configPath, { controller: 'http://127.0.0.1:1', hostId: 'fixture', hostToken: 'synthetic-token', dataDirectory: root });
  const sent = [];
  const runner = new Runner({ dataDirectory: root, hostId: 'fixture' }, { client: { request: async (_op, body) => { sent.push(body); return {}; } } });
  for (const deliberatePause of [false, true]) {
    await command(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), deliberatePause ? 'pause' : 'resume', '--config', configPath]);
    await command(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'stop', '--config', configPath]);
    await runner.heartbeat();
    assert.equal(sent.at(-1).paused, deliberatePause);
  }
});

async function ompTransportFixture(t) {
  const stdout = new PassThrough(), received = [], errors = [];
  let exit;
  const emit = frame => stdout.write(JSON.stringify(frame) + '\n');
  const native = { child: { stdout }, exit: new Promise(resolve => { exit = resolve; }), send: async frame => emit({ type: 'response', id: frame.id, success: true, data: { protocolVersion: 2 } }) };
  const ready = ompJsonLines(native, frame => received.push(frame), error => errors.push(error));
  emit({ type: 'ready', supportedProtocolVersions: [1, 2] }); await ready;
  t.after(() => { stdout.end(); exit(); });
  return { emit, received, errors };
}

test('OMP reconstructs large UTF-8 frames without publishing partial messages', async t => {
  const fixture = await ompTransportFixture(t);
  const frame = { type: 'response', id: 'catalog', data: { description: '界'.repeat(400000) } };
  const bytes = Buffer.from(JSON.stringify(frame)), count = Math.ceil(bytes.length / (256 * 1024));
  for (let index = 0; index < count; index++) {
    assert.equal(fixture.received.length, 0);
    fixture.emit({ type: 'rpc_chunk', chunkId: 'catalog', index, count, byteLength: bytes.length, data: bytes.subarray(index * 256 * 1024, (index + 1) * 256 * 1024).toString('base64') });
  }
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.received, [frame]);
});

test('OMP rejects out-of-order, oversized, and interrupted chunk sequences', async t => {
  const first = { type: 'rpc_chunk', chunkId: 'catalog', index: 0, count: 5, byteLength: 1024 * 1024, data: Buffer.alloc(256 * 1024).toString('base64') };
  for (const sequence of [[{ ...first, index: 1 }], [{ ...first, byteLength: 65 * 1024 * 1024 }], [first, { type: 'prompt_result', status: 'completed' }]]) {
    const fixture = await ompTransportFixture(t);
    for (const frame of sequence) fixture.emit(frame);
    assert.equal(fixture.errors.length, 1);
    assert.deepEqual(fixture.received, []);
  }
});
