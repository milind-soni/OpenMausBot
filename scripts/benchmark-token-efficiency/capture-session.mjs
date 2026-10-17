import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const [repoArg, label, outputArg, workload = 'short', blocksArg = '275'] = process.argv.slice(2);
assert(repoArg && label && outputArg, 'Usage: capture-session.mjs REPO LABEL OUTPUT short|long [DOCUMENT_ROWS]');
const repo = resolve(repoArg), output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const { launchVerificationServer, runControlOmb } = await import(pathToFileURL(join(repo, 'scripts/control-omb.ts')));
assert(['short', 'long'].includes(workload), 'Workload must be short or long');
assert(Number.isSafeInteger(Number(blocksArg)) && Number(blocksArg) > 0, 'DOCUMENT_ROWS must be a positive integer');
assert(process.env.OMB_COMPUTER_CATALOG_FILE, 'Set OMB_COMPUTER_CATALOG_FILE to a read-only tools/list catalog JSON array');
const catalogBytes = readFileSync(resolve(process.env.OMB_COMPUTER_CATALOG_FILE));
const computer = JSON.parse(catalogBytes);
assert(Array.isArray(computer), 'Computer catalog must be a JSON array');
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const sourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo, encoding: 'utf8' }).trim().length > 0;
const catalogHash = createHash('sha256').update(catalogBytes).digest('hex');
const frame = (delta, finish) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const textFrame = text => frame({ content: text }, 'stop') + 'data: [DONE]\n\n';
const callFrame = (name, args, id) => frame({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls') + 'data: [DONE]\n\n';
let turn = 0, step = 0, action = null, phasePlan = null;
const requests = [], replies = [], commands = [];
const provider = createServer(async (req, res) => {
  try {
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_length: 262144 }] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    const record = { turn, round: step + 1, request };
    requests.push(record);
    if (request.stream === false) {
      record.phase = 'helper';
      record.response = JSON.stringify({ choices: [{ message: { content: 'Synthetic account statements reviewed; invoice deadlines retained. No email sent.' }, finish_reason: 'stop' }] });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(record.response); return;
    }
    const names = request.tools?.map(tool => tool.function.name) ?? [];
    const deferred = names.includes('mail_search_tools');
    const descriptionKnown = request.messages.some(message => message.role === 'tool' && String(message.content).includes('mail_read_batch') && String(message.content).includes('inputSchema'));
    const phases = phasePlan ??= action ? (deferred && !descriptionKnown ? ['search', 'describe', 'execute', 'reply'] : ['execute', 'reply']) : ['reply'];
    const phase = phases[step++];
    let response;
    if (phase === 'search') response = callFrame('mail_search_tools', { query: 'read batch synthetic inbox email' }, `search-${turn}`);
    else if (phase === 'describe') response = callFrame('mail_describe_tool', { name: 'mail_read_batch' }, `describe-${turn}`);
    else if (phase === 'execute') response = callFrame(deferred ? 'mail_call_tool' : 'mail_mail_read_batch', deferred ? { name: 'mail_read_batch', arguments: { batch: turn, fail: action === 'fail' } } : { batch: turn, fail: action === 'fail' }, `read-${turn}`);
    else {
      const reply = action === 'fail' ? 'The synthetic inbox read failed. No email was sent or changed.' : action ? `Batch ${turn} reviewed. The invoice needs a reply; the newsletter is informational. No email was sent.` : `Acknowledged turn ${turn}. The standing triage rules still apply. No email was sent.`;
      replies.push({ turn, reply }); response = textFrame(reply);
    }
    record.phase = phase; record.response = response;
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(response);
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
let fixture;
try {
  fixture = await launchVerificationServer();
  const address = provider.address(); assert(address && typeof address !== 'string');
  const api = async (method, path, body) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { 'content-type': 'application/json', origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert(response.ok, `${method} ${path}: ${JSON.stringify(result)}`); return result;
  };
  const control = async args => { const result = await runControlOmb([...args, '--url', fixture.info.url]); commands.push({ args, result }); return result; };
  await api('PATCH', '/api/config', { openaiCompat: { key: 'synthetic-benchmark-key', url: `http://127.0.0.1:${address.port}/v1`, model: 'fixture-model' }, context: { rebuildBytes: 1000000, autoCompact: false }, features: { browser: false } });
  const catalog = join(fixture.info.dataDir, 'computer.json'); writeFileSync(catalog, JSON.stringify(computer));
  const receipts = join(fixture.info.dataDir, 'calls.ndjson');
  const script = join(fixture.info.dataDir, 'synthetic-mcp.mjs');
  writeFileSync(script, `
import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync } from 'node:fs';
const schema = { type: 'object', properties: { batch: { type: 'integer', description: 'The numbered synthetic inbox batch requested by the user' }, fail: { type: 'boolean', description: 'Return the synthetic provider failure without modifying anything' } }, required: ['batch'], additionalProperties: false };
const tools = process.env.KIND === 'computer' ? JSON.parse(readFileSync(process.env.CATALOG, 'utf8')) : [
  { name: 'mail_read_batch', description: 'Read a numbered batch of synthetic inbox email for triage. Returns email IDs, sender, subject, summary, and action flags. No emails are sent or changed.', inputSchema: schema },
  ...Array.from({ length: 14 }, (_, i) => ({ name: 'mail_reference_' + i, description: 'Read the synthetic mail reference section ' + i + '. Optional parameters select account, mailbox, dates, priority, labels, pagination and output fields. This is a synthetic reference catalog; the benchmark never invokes this operation.', inputSchema: { type: 'object', properties: Object.fromEntries(['account','mailbox','after','before','priority','labels','cursor','fields'].map(key => [key, { type: 'string', description: 'Optional ' + key + ' selector for this synthetic mail reference operation; does not grant permission or send email.' }])) } }))
];
createInterface({ input: process.stdin }).on('line', line => {
 const request = JSON.parse(line); if (request.id === undefined) return;
 let result;
 if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: process.env.KIND, version: '1' } };
 else if (request.method === 'tools/list') result = { tools };
 else if (request.method === 'tools/call') {
  appendFileSync(process.env.RECEIPTS, JSON.stringify(request.params) + '\\n');
  if (process.env.KIND !== 'mail' || request.params.name !== 'mail_read_batch') result = { content: [{ type: 'text', text: 'Unexpected synthetic operation' }], isError: true };
  else if (request.params.arguments?.fail) result = { content: [{ type: 'text', text: 'Synthetic inbox service unavailable; no operation ran.' }], isError: true };
  else result = { content: [{ type: 'text', text: JSON.stringify(Array.from({ length: 14 }, (_, i) => ({ id: 'batch-' + request.params.arguments.batch + '-email-' + i, from: i === 0 ? 'client@example.invalid' : 'newsletter@example.invalid', subject: i === 0 ? 'Invoice correction due Friday' : 'Weekly newsletter ' + i, summary: 'Synthetic email for controlled triage: review the account statement, identify follow-up deadlines, keep future-dated event notices, and prepare an unsent reply if requested.', needsReply: i === 0 }))) }] };
 } else result = { content: [{ type: 'text', text: 'Unsupported' }], isError: true };
 process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});`);
  for (const [name, kind] of [['mail', 'mail'], ['desktop_fixture', 'computer']]) {
    await api('POST', '/api/mcp/servers', { name, command: process.execPath, args: [script], env: { KIND: kind, CATALOG: catalog, RECEIPTS: receipts }, enabled: true });
    await api('PATCH', `/api/mcp/servers/${name}`, { enabled: true });
  }
  const { bot } = await control(['new-bot', '--name', 'Synthetic email triage']);
  await control(['set-model', '--bot', bot.id, '--instance', 'openaiCompat', '--model', 'fixture-model']);
  await api('PATCH', `/api/bots/${bot.id}`, { mcpServers: ['mail', 'desktop_fixture'], browser: false, description: 'Triage synthetic email', soul: 'Use email tools for inbox requests. Never send email. Identify reply deadlines, retain future event notices, and keep summaries concise.' });
  const memoryDir = join(fixture.info.dataDir, 'workspaces', bot.id); mkdirSync(memoryDir, { recursive: true });
  const memory = join(memoryDir, 'MEMORY.md');
  writeFileSync(memory, '# Memory\nOnly synthetic email is permitted. Keep drafts unsent.\n' + Array.from({ length: 24 }, (_, i) => `- Triage preference ${i}: preserve deadlines and future event notices; general newsletters need no reply.\n`).join(''));
  const short = ['Hello. Briefly confirm the triage rules.', 'Read inbox batch 2 and identify anything needing a reply.', 'Keep future event notices and mention the invoice deadline.', 'Read inbox batch 4; report a synthetic service failure if one occurs.', 'Thanks.'];
  for (let i = 0; i < (workload === 'long' ? 20 : 5); i++) {
    turn = i + 1; step = 0; phasePlan = null;
    action = workload === 'short' ? (turn === 2 ? 'read' : turn === 4 ? 'fail' : null) : ([2, 7, 12, 17].includes(turn) ? (turn === 17 ? 'fail' : 'read') : null);
    if (turn === 3 || (workload === 'long' && turn === 11)) writeFileSync(memory, readFileSync(memory, 'utf8') + '\n- New preference: report invoice deadlines explicitly.\n');
    const document = workload === 'long' ? Array.from({ length: Number(blocksArg) }, (_, row) => `Reference ${turn}.${row}: account ${10000 + turn * 1000 + row} has a synthetic invoice due Friday; retain future notices and review the correction before preparing an unsent reply.\n`).join('') : '';
    const message = workload === 'long' ? `Review synthetic reference batch ${turn}. ${action ? `Read inbox batch ${turn}${action === 'fail' ? ' and report its synthetic failure' : ''}.` : 'Acknowledge the reference and retain the prior rules.'}\n${document}` : short[i];
    await control(['send', '--bot', bot.id, '--task', bot.activeTaskId, '--text', message]);
    let settled = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const status = await control(['wait', '--bot', bot.id, '--task', bot.activeTaskId, '--timeout', '20']);
      if (['settled','failed'].includes(status.status)) { assert(status.status === (action === 'fail' ? 'failed' : 'settled'), JSON.stringify(status)); settled = true; break; }
      if (status.status === 'needs-user') {
        const state = await api('GET', '/api/bots');
        const current = state.bots.find(item => item.id === bot.id);
        const card = current.messages.find(item => item.card?.requestId && !item.card.answered)?.card;
        assert(card?.requestId); assert(JSON.stringify(card).includes('mail_read_batch'));
        await api('POST', `/api/bots/${bot.id}/respond`, { threadId: bot.activeTaskId, requestId: card.requestId, behavior: 'allow' });
      }
    }
    assert(settled, `turn ${turn} did not settle`);
    assert(replies.some(item => item.turn === turn), `No final reply for turn ${turn}`);
  }
  const calls = readFileSync(receipts, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert(calls.every(call => call.name === 'mail_read_batch'), 'No real desktop or other operation is permitted');
  const report = { label, workload, sourceRevision, sourceDirty, catalogHash, fixture: fixture.info, documentRows: workload === 'long' ? Number(blocksArg) : 0, calls, requests, replies, configuration: { rebuildBytes: 1000000, autoCompact: false, rationale: 'Long controlled workload retains the same canonical references up to the 256K model limit; no live configuration is changed.' } };
  writeFileSync(join(output, `${label}-${workload}.json`), JSON.stringify(report));
  console.log(JSON.stringify({ label, workload, turns: turn, requests: requests.length, tools: requests[0].request.tools?.length, mailCalls: calls.length, output: join(output, `${label}-${workload}.json`) }));
} finally {
  if (fixture) await fixture.close();
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
