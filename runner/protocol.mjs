import { mkdir, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, readJson, controllerEndpoint, hash, RunError } from './security.mjs';

export class WorkerClient {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; this.endpoint = controllerEndpoint(config.controller); }
  async request(op, payload = {}, token = this.config.hostToken) {
    const response = await this.fetcher(this.endpoint, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 1, op, ...(op !== 'enroll' ? { hostId: this.config.hostId } : {}), ...payload }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      const error = new Error(`Controller ${op} rejected (${response.status})`);
      error.status = response.status; throw error;
    }
    return response.json();
  }
}
export class RunLedger {
  constructor(root) { this.directory = join(root, 'runs'); }
  path(id, attempt = 1) { return join(this.directory, `${hash(attempt === 1 ? id : JSON.stringify([id, attempt]))}.json`); }
  async claim(run) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const attempt = run.attempt ?? 1;
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RunError('failed', 'Invalid execution attempt');
    const previous = (await this.records()).filter(record => record.id === run.id);
    if (previous.some(record => (record.attempt ?? 1) >= attempt || record.leaseToken === run.leaseToken)) throw new RunError('failed', 'Duplicate execution attempt refused; prior receipts retained');
    if (previous.some(record => record.state !== 'acknowledged')) throw new RunError('failed', 'Prior attempt lacks an acknowledged native stop receipt; replacement refused');
    let file;
    try { file = await open(this.path(run.id, attempt), 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new RunError('failed', 'Duplicate execution refused: run already has a durable local receipt'); throw error; }
    // Do not persist prompt, environment values, git tokens, or account auth.
    const record = { id: run.id, attempt, leaseToken: run.leaseToken, state: 'claimed', sequence: 0, outbox: [], messages: [], startedAt: Date.now() };
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
    return record;
  }
  async records() {
    let names; try { names = await readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => name.endsWith('.json')).map(name => readJson(join(this.directory, name))));
  }
}
export class EventJournal {
  constructor(ledger, record, client, redactor) {
    this.ledger = ledger; this.record = record; this.client = client; this.redactor = redactor;
    this.writes = Promise.resolve(); this.sending = null; this.pendingBytes = 0;
    this.record.outboxBytes ??= Buffer.byteLength(JSON.stringify(record.outbox));
  }
  mutate(fn) {
    const operation = this.writes.then(async () => { fn(this.record); await atomicJson(this.ledger.path(this.record.id, this.record.attempt), this.record); });
    this.writes = operation.catch(() => {});
    return operation;
  }
  event(event) {
    // Redact untrusted text without corrupting protocol enums/SHAs when an env value
    // happens to be a short word such as "running" or "1".
    const clean = structuredClone(event);
    for (const key of ['text', 'message', 'summary', 'tool']) if (typeof clean[key] === 'string') clean[key] = this.redactor.text(clean[key]);
    if ('input' in clean) clean.input = this.redactor.value(clean.input);
    if (clean.verification) clean.verification = clean.verification.map(value => ({ ...value, command: this.redactor.text(value.command), ...(value.summary ? { summary: this.redactor.text(value.summary) } : {}) }));
    if (clean.account) {
      clean.account.label = this.redactor.text(clean.account.label);
      if (clean.account.quota.error) clean.account.quota.error = this.redactor.text(clean.account.quota.error);
    }
    const bytes = Buffer.byteLength(JSON.stringify(clean));
    if (event.type !== 'finished' && this.pendingBytes + bytes > 16 * 1024 * 1024) return Promise.reject(new Error('Pending audit buffer full; stopping execution'));
    this.pendingBytes += bytes;
    return this.mutate(record => {
      if (event.type !== 'finished' && (record.outbox.length >= 10000 || record.outboxBytes + bytes > 16 * 1024 * 1024)) throw new Error('Controller event backlog full; stopping instead of dropping audit records');
      record.outboxBytes += bytes;
      record.sequence++;
      record.outbox.push({ sequence: record.sequence, event: clean });
      if (event.type === 'finished') { record.state = 'stopped'; record.finished = clean; }
    }).finally(() => { this.pendingBytes -= bytes; });
  }
  async flush(terminalOnly = false) {
    if (this.sending) {
      try { await this.sending; } catch (error) { if (!terminalOnly) throw error; }
      if (!this.record.outbox.length) return;
    }
    const sending = (async () => {
      await this.writes;
      while (this.record.outbox.length) {
        const item = terminalOnly ? this.record.outbox.findLast(value => value.event.type === 'finished') : this.record.outbox[0];
        if (!item) break;
        const result = await this.client.request('event', { runId: this.record.id, leaseToken: this.record.leaseToken, ...item });
        if (result.accepted !== true) throw new Error('Controller did not acknowledge event');
        await this.mutate(record => {
          record.outbox = record.outbox.filter(value => value.sequence > item.sequence);
          record.outboxBytes = Buffer.byteLength(JSON.stringify(record.outbox));
          if (item.event.type === 'finished') record.state = 'acknowledged';
        });
      }
    })();
    this.sending = sending;
    try { await sending; } finally { if (this.sending === sending) this.sending = null; }
  }
}
export class Lease {
  constructor(seconds = 60, clock = () => performance.now()) { this.clock = clock; this.renew(seconds); }
  renew(seconds = this.seconds, startedAt = this.clock()) {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new RunError('cancelled', 'Invalid worker lease duration');
    this.seconds = Math.min(seconds, 60); this.deadline = startedAt + this.seconds * 1000;
  }
  assert() { if (this.clock() >= this.deadline) throw new RunError('cancelled', 'Worker lease expired; stopped locally without handoff'); }
}
