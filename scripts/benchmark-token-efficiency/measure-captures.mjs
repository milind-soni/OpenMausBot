import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { benchmarkUrl } from './settings.mjs';

const [input, output] = process.argv.slice(2);
assert(input && output, 'Usage: measure-captures.mjs CAPTURE OUTPUT');
const baseUrl = benchmarkUrl();
const capture = JSON.parse(readFileSync(input, 'utf8'));
const post = async (path, body) => {
  const response = await fetch(new URL(path, baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000), redirect: "error" });
  assert(response.ok, `${path}: ${response.status}`); return response.json();
};
const tokenIds = async text => (await post('tokenize', { content: text, add_special: false })).tokens;
const prefix = (left, right) => { let n = 0; while (n < Math.min(left.length, right.length) && left[n] === right[n]) n++; return n; };
const history = [], rows = [];
for (const record of capture.requests) {
  const request = { ...record.request, model: undefined };
  const rendered = await post('apply-template', { ...request, add_generation_prompt: true });
  const ids = await tokenIds(rendered.prompt);
  const ending = await post('apply-template', { ...request, add_generation_prompt: false });
  const endIds = await tokenIds(ending.prompt);
  const eligible = prefix(ids, endIds);
  const messages = request.messages;
  const boundaryEnds = [];
  const omittedLookupBoundaries = [];
  let initialEnd = 0;
  while (initialEnd < messages.length && ['system', 'developer'].includes(messages[initialEnd].role)) initialEnd++;
  const messageEnds = [];
  for (let i = initialEnd; i < messages.length; i++) {
    if (messages[i].role === 'user' || (messages[i].role === 'tool' && messages[i + 1]?.role !== 'tool')) messageEnds.push(i + 1);
  }
  for (const messageEnd of [...(initialEnd ? [initialEnd] : []), ...messageEnds.slice(-21)]) {
    if (!messages.slice(0, messageEnd).some(message => message.role === 'user')) {
      omittedLookupBoundaries.push({ messageEnd, reason: 'Splash requires a user message; initial system/developer boundary cannot render independently. This trace never writes a system-only endpoint.' });
      continue;
    }
    const partial = await post('apply-template', { ...request, messages: messages.slice(0, messageEnd), add_generation_prompt: false });
    const partialIds = await tokenIds(partial.prompt);
    // A local endpoint is usable only if its full template output matches the incoming prefix.
    if (prefix(ids, partialIds) === partialIds.length && partialIds.length <= eligible) boundaryEnds.push(partialIds.length);
  }
  const matchedEarlierBoundaryTokens = history.reduce((best, previous) =>
    boundaryEnds.includes(previous.eligible) && prefix(previous.ids, ids) >= previous.eligible
      ? Math.max(best, previous.eligible) : best, 0);
  let maxEarlierPrefix = 0;
  for (const previous of history) maxEarlierPrefix = Math.max(maxEarlierPrefix, Math.min(prefix(previous.ids, ids), previous.eligible));
  let text = '', calls = [];
  for (const line of record.response.split('\n')) if (line.startsWith('data: {')) {
    const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
    text += delta?.content ?? ''; calls.push(...(delta?.tool_calls ?? []));
  }
  if (record.phase === 'helper') text = JSON.parse(record.response).choices[0].message.content;
  const outputText = text || calls.map(call => JSON.stringify({ name: call.function.name, arguments: JSON.parse(call.function.arguments) })).join('\n');
  const generated = await tokenIds(outputText);
  rows.push({ turn: record.turn, round: record.round, phase: record.phase, inputTokens: ids.length, eligiblePrefixTokens: eligible, commonPreviousPrefixTokens: history.length ? prefix(history.at(-1).ids, ids) : 0, maxEarlierEligiblePrefixTokens: maxEarlierPrefix, lookupBoundaryTokens: boundaryEnds, omittedLookupBoundaries, matchedEarlierBoundaryTokens, scriptedOutputTokens: generated.length, toolCount: request.tools?.length ?? 0, messages: request.messages.length, renderedBytes: Buffer.byteLength(rendered.prompt) });
  history.push({ ids, eligible });
}
writeFileSync(output, JSON.stringify({ label: capture.label, workload: capture.workload, sourceRevision: capture.sourceRevision, sourceDirty: capture.sourceDirty, catalogHash: capture.catalogHash, benchmarkUrl: baseUrl.href, tokenizer: 'Exact token IDs from the explicitly selected local server chat template/tokenizer; Qwen-token-equivalent rate-card units when the loaded model is Qwen', rows }, null, 2));
console.log(JSON.stringify({ label: capture.label, workload: capture.workload, requests: rows.length, initial: rows[0].inputTokens, final: rows.at(-1).inputTokens, largest: Math.max(...rows.map(row => row.inputTokens)), inputSum: rows.reduce((sum, row) => sum + row.inputTokens, 0), eligibleReuse: rows.reduce((sum, row) => sum + row.maxEarlierEligiblePrefixTokens, 0) }));
