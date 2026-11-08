import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Redactor, scopedEnvironment, baseEnvironment, classifyFailure, RunError, hash } from '../security.mjs';
import { codexQuota, codexIdentity, ompQuota, ompBillingKind, confirmedExhausted, identityHash, selectAccount } from '../accounts.mjs';
import { Lease, RunLedger, EventJournal, WorkerClient } from '../protocol.mjs';
import { validateRelease } from '../service.mjs';
import { validateControllerBundle } from '../maintenance.mjs';

test('native ChatGPT identity retains both workspace and member boundaries', () => {
  const account = { type: 'chatgpt', email: 'member@example.invalid' };
  const first = codexIdentity({ account, workspaceRouting: { chatgptAccountId: 'workspace-a' } }, {});
  const second = codexIdentity({ account, workspaceRouting: { chatgptAccountId: 'workspace-b' } }, {});
  assert.notEqual(identityHash('openai', first), identityHash('openai', second));
  assert.notEqual(identityHash('openai', first), identityHash('openai', { email: 'teammate@example.invalid', orgId: 'workspace-a' }));
  assert.equal(identityHash('openai', first), identityHash('openai-codex', { email: account.email, accountId: 'workspace-a', orgId: 'workspace-a' }));
  assert.equal(codexIdentity({ account }, {}), undefined);
});

test('OAuth, dollar budgets and credit meters do not prove included subscription billing', () => {
  assert.equal(ompBillingKind({ provider: 'anthropic', type: 'oauth' }), 'unknown');
  assert.equal(ompBillingKind({ provider: 'another-provider', type: 'oauth', limits: [{ id: 'monthly', amount: { unit: 'percent' } }] }), 'unknown');
  assert.equal(ompBillingKind({ provider: 'anthropic', limits: [{ id: 'anthropic:extra', amount: { unit: 'usd' } }] }), 'unknown');
  assert.equal(ompBillingKind({ provider: 'openai-codex', limits: [{ id: 'openai-codex:credits', amount: { unit: 'credits' } }] }), 'unknown');
  assert.equal(ompBillingKind({ provider: 'anthropic', type: 'api_key' }), 'api');
  assert.equal(ompBillingKind({ provider: 'anthropic', limits: [{ id: 'anthropic:7d', amount: { unit: 'percent' } }] }), 'subscription');
  assert.equal(ompBillingKind({ provider: 'openai-codex', limits: [{ id: 'openai-codex:primary', amount: { unit: 'percent' } }] }), 'subscription');
});

test('redaction never leaks a secret split across arbitrary chunks or lines', () => {
  const secret = 'scope/secret+with=value';
  for (let split = 0; split <= secret.length; split++) {
    const output = []; const redactor = new Redactor([secret, 'private-line-one\nprivate-line-two']);
    const stream = redactor.stream(value => output.push(value));
    stream.push(`before ${secret.slice(0, split)}`); assert.equal(output.length, 0);
    stream.push(`${secret.slice(split)} after\nprivate-line-one\nprivate-line-two\n`); stream.end();
    assert.equal(output.join(''), 'before [REDACTED] after\n[REDACTED]\n[REDACTED]\n');
  }
  const redactor = new Redactor([secret]);
  assert.equal(redactor.text(encodeURIComponent(secret)), '[REDACTED]');
  assert.equal(redactor.text(Buffer.from(secret).toString('base64')), '[REDACTED]');
  assert.equal(redactor.text('Authorization: Bearer some-unregistered-token'), 'Authorization: [REDACTED] [REDACTED]');
  const chunks = []; const bounded = redactor.stream(text => chunks.push(text), 10);
  bounded.push('very-long-sensitive-line'); bounded.push('\n');
  assert.equal(chunks.join(''), '[oversized log line omitted]\n');
});

test('project environment allows application API keys but forbids runner and shell injection', () => {
  for (const key of ['ORIGIN_HOST_TOKEN', 'HOME', 'PATH', 'NODE_OPTIONS', 'GIT_ASKPASS', 'BASH_ENV', 'LD_PRELOAD']) assert.throws(() => scopedEnvironment({ [key]: 'secret' }), /Disallowed/);
  const application = { DATABASE_URL: 'postgres://scoped', OPENAI_API_KEY: 'application-openai', ANTHROPIC_API_KEY: 'application-anthropic', GEMINI_API_KEY: 'application-gemini' };
  assert.deepEqual(scopedEnvironment(application), application);
  const previous = process.env.ORIGIN_HOST_TOKEN; process.env.ORIGIN_HOST_TOKEN = 'not-inherited';
  try { assert.equal(baseEnvironment().ORIGIN_HOST_TOKEN, undefined); } finally { if (previous === undefined) delete process.env.ORIGIN_HOST_TOKEN; else process.env.ORIGIN_HOST_TOKEN = previous; }
});

test('missing, stale, errors and feature quotas never imply coding exhaustion', () => {
  const now = Date.now();
  assert.equal(confirmedExhausted(codexQuota({}, now), now), false);
  const quota = codexQuota({ rateLimits: { limitId: 'codex', primary: { usedPercent: 100, resetsAt: (now + 3600000) / 1000, windowDurationMins: 300 } } }, now);
  assert.equal(confirmedExhausted(quota, now), true);
  assert.equal(quota.windows[0].durationMinutes, 300);
  assert.equal(quota.windows[0].resetsAt, now + 3600000);
  for (const status of ['unknown', 'stale', 'error']) assert.equal(confirmedExhausted({ ...quota, status }, now), false);
  assert.equal(confirmedExhausted({ ...quota, observedAt: now - 120001 }, now), false);
  assert.equal(confirmedExhausted(codexQuota({ rateLimits: { limitId: 'code-review', primary: { usedPercent: 100 } } }, now), now), false);
  const native = ompQuota({ provider: 'anthropic', fetchedAt: now, limits: [{ id: 'shared', label: 'Weekly', scope: { shared: true }, amount: { usedFraction: 1 }, window: { durationMs: 604800000, resetsAt: now + 60000 } }] });
  assert.equal(confirmedExhausted(native, now), true);
});

test('fallback exit reasons require structured provider evidence', () => {
  assert.equal(classifyFailure({ httpStatus: 429, message: 'quota exhausted' }), 'failed');
  assert.equal(classifyFailure({ codexErrorInfo: 'usageLimitExceeded' }), 'quota');
  assert.equal(classifyFailure({ httpStatus: 503 }), 'provider_unavailable');
  assert.equal(classifyFailure({ httpStatus: 401 }), 'needs_auth');
  assert.equal(classifyFailure(new RunError('needs_approval', 'denied')), 'needs_approval');
});

test('dedup identity crosses CLI/machine profiles and retains organization scope', () => {
  assert.equal(identityHash('openai-codex', { email: 'USER@example.org' }), identityHash('openai', { email: 'user@example.org' }));
  assert.notEqual(identityHash('anthropic', { email: 'u@e', orgId: 'one' }), identityHash('anthropic', { email: 'u@e', orgId: 'two' }));
  assert.equal(identityHash('openai', {}), null);
});

test('explicit selection rejects implicit model, effort and ambiguous account substitutions', () => {
  const account = { binding: { harness: 'omp' }, report: { id: 'local', authKind: 'subscription', authenticated: true, quota: { status: 'unknown', windows: [] }, models: [{ id: 'provider/exact', efforts: ['high'] }] } };
  const selected = { accountId: 'local', harness: 'omp', model: 'provider/exact', effort: 'high' };
  assert.equal(selectAccount([account], selected, 'subscription'), account);
  assert.throws(() => selectAccount([account], { ...selected, model: 'exact' }, 'subscription'), /exact model/);
  assert.throws(() => selectAccount([account], { ...selected, effort: 'max' }, 'subscription'), /effort/);
  assert.throws(() => selectAccount([{ ...account, binding: { harness: 'omp', ambiguous: true } }], selected, 'subscription'), /dedicated/);
  for (const authKind of ['api', 'unknown']) assert.throws(() => selectAccount([{ ...account, report: { ...account.report, authKind } }], selected, 'subscription'), /billing type/);
  assert.throws(() => selectAccount([account], selected, undefined), /billing type/);
});

test('monotonic lease expires independently of wall-clock and renewals', () => {
  let now = 0; const lease = new Lease(60, () => now);
  now = 59999; lease.assert(); now = 60000; assert.throws(() => lease.assert(), /expired/);
  lease.renew(); now += 59000; lease.assert(); now += 1000; assert.throws(() => lease.assert(), /expired/);
});

test('duplicate claims are refused and event retries retain exact sequence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'origin-journal-'));
  try {
    const ledger = new RunLedger(root); const run = { id: 'one', leaseToken: 'lease-secret' };
    const record = await ledger.claim(run); await assert.rejects(ledger.claim(run), /Duplicate/);
    const sent = []; let fail = true;
    const client = { request: async (op, payload) => { sent.push({ op, ...payload }); if (fail) { fail = false; throw new Error('network lost after accept'); } return { accepted: true }; } };
    const journal = new EventJournal(ledger, record, client, new Redactor(['running', '1', 'sensitive-value']));
    await journal.event({ type: 'status', status: 'running', message: 'sensitive-value' });
    await assert.rejects(journal.flush(), /network/); await journal.flush();
    assert.equal(sent.length, 2); assert.equal(sent[0].sequence, sent[1].sequence);
    assert.equal(sent[1].event.status, 'running'); assert.equal(sent[1].event.message, '[REDACTED]');
    await journal.event({ type: 'finished', result: 'cancelled', processStopped: true, summary: 'stopped' }); await journal.flush(true);
    assert.equal((await ledger.records())[0].state, 'acknowledged');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker auth is scoped and redirects are forbidden', async () => {
  let observed;
  const client = new WorkerClient({ controller: 'https://origin.example', hostId: 'h', hostToken: 'private' }, async (url, options) => { observed = { url, options }; return { ok: true, json: async () => ({ run: null }) }; });
  await client.request('claim');
  assert.equal(observed.options.redirect, 'error');
  assert.equal(observed.options.headers.authorization, 'Bearer private');
  assert.deepEqual(JSON.parse(observed.options.body), { protocolVersion: 1, op: 'claim', hostId: 'h' });
  assert.throws(() => new WorkerClient({ controller: 'http://remote.example' }), /HTTPS/);
});

test('stable releases require trusted signature and safe immutable paths', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const manifest = { version: '1.2.3', channel: 'stable', protocolVersion: 1, nodeMajor: 24, files: [{ path: 'runner/cli.mjs', sha256: hash('code'), bytes: 4 }] };
  const signature = sign(null, Buffer.from(JSON.stringify(manifest)), privateKey).toString('base64');
  validateRelease(manifest, signature, publicKey, '1.2.3');
  assert.throws(() => validateRelease({ ...manifest, version: '1.2.3-nightly' }, signature, publicKey, '1.2.3-nightly'), /stable/);
  const files = [{ path: 'cli.mjs', content: 'code', sha256: hash('code') }];
  const bundle = { version: '1.2.3', files, sha256: hash(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 })))) };
  validateControllerBundle(bundle);
  assert.throws(() => validateControllerBundle({ ...bundle, files: [{ ...files[0], path: 'runner/../escape.mjs' }] }), /integrity|path/);
});

test('source secret gate rejects credential values without rejecting ordinary auth code', () => {
  const redactor = new Redactor(['private-secret-value']);
  assert.equal(redactor.containsSecret('const headers = { authorization: token, password: request.password };'), false);
  assert.equal(redactor.containsSecret('const password = "private-secret-value";'), true);
  assert.equal(redactor.containsSecret('https://user:actual-password@example.invalid'), true);
});

test('leases reject invalid durations and do not gain network transit time', () => {
  let now = 10000;
  const lease = new Lease(60, () => now);
  now = 20000; lease.renew(60, 10000);
  now = 70000; assert.throws(() => lease.assert(), /expired/);
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => new Lease(value), /Invalid/);
});
