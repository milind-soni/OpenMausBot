import { spawn, fork } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { baseEnvironment, RunError, VERSION } from './security.mjs';

export function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid < 2) return;
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
export function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function deadline(promise, milliseconds, fallback) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
export class ManagedProcess {
  constructor(command, args = [], options = {}) {
    if (options.signal?.aborted) throw options.signal.reason;
    this.child = spawn(command, args, { cwd: options.cwd, env: options.env ?? baseEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pid = this.child.pid;
    this.child.stdin.on('error', () => {});
    this.closed = false;
    this.exit = new Promise(resolve => {
      this.child.once('error', error => { this.error = error; resolve({ code: null, error }); });
      this.child.once('close', (code, signal) => { this.closed = true; resolve({ code, signal }); });
    });
    // A separate guardian survives worker crashes and fences the entire process group.
    if (this.pid) {
      this.guardian = fork(fileURLToPath(new URL('./guardian.mjs', import.meta.url)), [String(this.pid)], { env: baseEnvironment(), execArgv: [], detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      this.guardian.unref();
      this.guardianResult = new Promise(resolve => {
        this.guardian.on('message', message => { if (typeof message?.stopped === 'boolean') resolve(message.stopped); });
        this.guardian.once('exit', code => { if (code !== 0) resolve(false); });
        this.guardian.once('error', () => resolve(false));
      });
      this.guardian.on('error', () => { void this.stop().catch(() => {}); });
    }
    this.abort = () => { void this.stop().catch(() => {}); };
    options.signal?.addEventListener('abort', this.abort, { once: true });
    this.exit.then(() => options.signal?.removeEventListener('abort', this.abort));
  }
  async send(value) {
    if (this.closed || this.error) throw this.error ?? new Error('Harness process stopped');
    const data = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
    await new Promise((resolve, reject) => this.child.stdin.write(data, error => error ? reject(error) : resolve()));
  }
  async stop(graceMs = 1500) {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.beforeStop) await deadline(Promise.resolve().then(() => this.beforeStop()).catch(() => {}), 500, null);
      if (this.guardian?.connected) this.guardian.send({ stop: true }, () => {});
      if (this.pid) {
        signalGroup(this.pid, 'SIGTERM');
        await deadline(this.exit, graceMs, null);
        // The leader may exit before its children. Always kill the remaining group.
        signalGroup(this.pid, 'SIGKILL');
      }
      const stopped = this.guardianResult ? await deadline(this.guardianResult, 6000, false) : !this.pid;
      if (!stopped) throw new RunError('failed', 'Unable to prove subprocess tree stopped; controller must not hand off this run');
      await this.exit;
      if (this.guardian?.connected) this.guardian.disconnect();
      return { processStopped: true };
    })().catch(error => { error.processStopUnproven = true; throw error; });
    return this.stopping;
  }
}
export function jsonLines(stream, receive, onError) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  stream.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (buffer.length > 8 * 1024 * 1024) { onError(new Error('Harness JSON record exceeds 8 MiB')); buffer = ''; return; }
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { receive(JSON.parse(line)); } catch (error) { onError(error); }
    }
  });
  stream.on('end', () => { buffer += decoder.end(); if (buffer.trim()) { try { receive(JSON.parse(buffer)); } catch (error) { onError(error); } } });
}
export function ompJsonLines(process, receive, onError) {
  let resolveReady, rejectReady, pending, negotiated = false, negotiating = false, failed = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const fail = error => { if (failed) return; failed = true; pending = undefined; clearTimeout(timer); rejectReady(error); onError(error); };
  const timer = setTimeout(() => fail(new Error('OMP protocol negotiation timed out')), 30000);
  jsonLines(process.child.stdout, frame => {
    if (failed) return;
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('OMP RPC frame must be an object');
    if (frame.type === 'ready') {
      if (negotiated || negotiating || !frame.supportedProtocolVersions?.includes(2)) throw new Error('OMP must support RPC protocol 2');
      negotiating = true;
      process.send({ type: 'negotiate_protocol', protocolVersion: 2, id: 'origin-protocol' }).catch(fail);
      return;
    }
    if (frame.type === 'response' && frame.id === 'origin-protocol') {
      if (!negotiating || negotiated || !frame.success || frame.data?.protocolVersion !== 2) throw new Error('OMP protocol negotiation failed');
      negotiated = true; clearTimeout(timer); resolveReady(); return;
    }
    if (frame.type !== 'rpc_chunk') {
      if (pending) throw new Error('OMP chunk sequence interrupted');
      receive(frame); return;
    }
    const { chunkId, index, count, byteLength, data } = frame;
    if (!negotiated || typeof chunkId !== 'string' || !chunkId.length || chunkId.length > 128 ||
        !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength) ||
        count < 2 || count > 256 || index < 0 || index >= count || byteLength < 1024 * 1024 || byteLength > 64 * 1024 * 1024 ||
        typeof data !== 'string' || !data.length || data.length > 349528 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('Invalid OMP chunk metadata');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > 256 * 1024 || bytes.toString('base64') !== data) throw new Error('Invalid OMP chunk payload');
    if (!pending) {
      if (index !== 0) throw new Error('OMP chunk sequence must begin at zero');
      pending = { chunkId, count, byteLength, index: 0, received: 0, bytes: Buffer.allocUnsafe(byteLength) };
    }
    if (chunkId !== pending.chunkId || count !== pending.count || byteLength !== pending.byteLength || index !== pending.index || pending.received + bytes.length > byteLength) throw new Error('OMP chunk sequence mismatch');
    bytes.copy(pending.bytes, pending.received); pending.received += bytes.length; pending.index++;
    if (pending.index < count) return;
    if (pending.received !== byteLength) throw new Error('OMP chunk length mismatch');
    const complete = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending.bytes));
    pending = undefined;
    if (!complete || typeof complete !== 'object' || Array.isArray(complete) || complete.type === 'rpc_chunk') throw new Error('Invalid reassembled OMP frame');
    receive(complete);
  }, fail);
  process.exit.then(() => fail(new Error('OMP RPC process exited')));
  return ready;
}
export class JsonRpc {
  constructor(process, onNotification = () => {}, onRequest = async () => { throw new Error('Unsupported native request'); }) {
    this.process = process; this.pending = new Map(); this.nextId = 1;
    const fail = error => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear();
      void process.stop().catch(() => {});
    };
    jsonLines(process.child.stdout, message => {
      if (message.method && message.id !== undefined) {
        Promise.resolve(onRequest(message)).then(result => process.send({ id: message.id, result }), () => process.send({ id: message.id, error: { code: -32601, message: 'Unsupported or declined host request' } })).catch(fail);
      } else if (message.id !== undefined) {
        const item = this.pending.get(message.id); if (!item) return;
        this.pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(Object.assign(new Error(message.error.message), message.error)); else item.resolve(message.result);
      } else { Promise.resolve(onNotification(message)).catch(fail); }
    }, fail);
    process.exit.then(result => fail(result.error ?? new Error('Native RPC process exited')));
  }
  call(method, params = {}, timeout = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Native RPC timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.process.send({ id, method, params }).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error); });
    });
  }
  async initialize() {
    await this.call('initialize', { clientInfo: { name: 'origin_runner', title: 'Origin Runner', version: VERSION }, capabilities: { experimentalApi: true } });
    await this.process.send({ method: 'initialized', params: {} });
  }
}
export async function command(command, args, options = {}) {
  const child = new ManagedProcess(command, args, options);
  let stdout = '', stderr = '';
  child.child.stdout.setEncoding('utf8'); child.child.stderr.setEncoding('utf8');
  child.child.stdout.on('data', text => { if (stdout.length < (options.maxOutput ?? 4 * 1024 * 1024)) stdout += text; options.onOutput?.('stdout', text); });
  child.child.stderr.on('data', text => { if (stderr.length < (options.maxOutput ?? 4 * 1024 * 1024)) stderr += text; options.onOutput?.('stderr', text); });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { child.stop().then(() => reject(new RunError('failed', `${command} exceeded its execution deadline`)), reject); }, options.timeoutMs ?? 60000);
  });
  try {
    if (options.input !== undefined) await child.send(options.input);
    child.child.stdin.end();
    const result = await Promise.race([child.exit, timeout]);
    if (options.signal?.aborted) throw options.signal.reason;
    if (result.error) throw result.error;
    if (result.code !== 0 && !options.allowFailure) throw new RunError('failed', `${command} exited ${result.code ?? result.signal}: ${stderr.slice(-2000)}`);
    return { code: result.code ?? 128, stdout, stderr };
  } finally { clearTimeout(timer); await child.stop(); }
}
