#!/usr/bin/env node
// A view/control bridge only. Native harness RPC and process ownership stay in worker.mjs.
import { createServer, createConnection } from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, chmod, lstat, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { command } from './process.mjs';
import { baseEnvironment } from './security.mjs';
import { rexCommand, rexStatus } from './rex.mjs';

const self = fileURLToPath(import.meta.url);
const LINE_LIMIT = 32768, BUFFER_LIMIT = 256 * 1024;
const plain = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function validateConsoleInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !identifier(value.id) || !['followup', 'cancel'].includes(value.action) || Object.keys(value).some(key => !['id', 'action', 'text'].includes(key))) throw Error('Only run follow-up and cancel requests are supported');
  if (value.action === 'followup' && (typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text) > 16000 || value.text.trimStart().startsWith('/'))) throw Error('Follow-up must be 1–16000 bytes of task text, not a console command');
  if (value.action === 'cancel' && value.text !== undefined) throw Error('Cancel takes no arguments');
  return value;
}

export function consoleEventText(event, redactor) {
  let text;
  switch (event.type) {
    case 'log': text = event.text; break;
    case 'status': text = `\n[Origin] ${event.status}\n`; break;
    case 'approval': text = `\n[Origin] Tool permission required: ${event.tool}. Decide in the Origin owner UI; this console cannot approve.\n`; break;
    case 'checkpoint': text = `\n[Origin] Checkpoint ${event.sha ?? event.checkpointSha ?? ''}\n`; break;
    case 'usage': text = '\n[Origin] Native usage updated.\n'; break;
    case 'finished': text = `\n[Origin] ${event.result}: ${event.summary ?? ''}\n${(event.verification ?? []).map(check => `Verification (${check.exitCode}): ${check.command}\n${check.summary ?? ''}`).join('\n')}\n`; break;
    default: return '';
  }
  return plain(redactor.text(String(text ?? '')));
}

function send(socket, frame) {
  if (socket.destroyed || socket.writableEnded) return;
  const line = `${JSON.stringify(frame)}\n`;
  if (socket.writableLength + Buffer.byteLength(line) > BUFFER_LIMIT) { socket.destroy(); return; }
  socket.write(line);
}
function lines(stream, receive, fail) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > LINE_LIMIT) { buffer = ''; fail(); return; }
      try { receive(line); } catch { buffer = ''; fail(); return; }
    }
    if (Buffer.byteLength(buffer) > LINE_LIMIT) { buffer = ''; fail(); }
  });
}
async function ownerOnly(path, kind) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || !info[kind]()) throw Error('Console IPC must belong exclusively to the local owner');
}

async function startRexViewer({ config, name, path, launch, options }) {
  const { executable, args } = rexCommand(config);
  await rexStatus(config, (executable, args, statusOptions) => launch(executable, args, { ...statusOptions, ...options }));
  const created = JSON.parse((await launch(executable, [...args, 'api', 'call', 'session.create', JSON.stringify({ label: name })], options)).stdout);
  if (!/^session:[0-9a-f-]{36}$/.test(created.session_id ?? '')) throw Error('Rex did not return a stable session identity');
  const cleanup = async () => {
    try { await launch(executable, [...args, 'kill', created.session_id], { ...options, signal: undefined }); } catch { /* Socket closure already detached the fixed viewer. */ }
  };
  try {
    // Empty session creation never attaches/focuses a client. Run directly, with
    // no login shell, keep-open recovery shell, TUI/model command or focus.
    const terminal = JSON.parse((await launch(executable, [...args, 'run', '--session', created.session_id, '--shell=none', '--focus=false', '--json', '--', process.execPath, self, path], options)).stdout);
    if (!/^window:[0-9a-f-]{36}$/.test(terminal.window_id ?? '') || !Array.isArray(terminal.block_ids) || terminal.block_ids.length !== 1 || !/^block:[0-9a-f-]{36}$/.test(terminal.block_ids[0])) throw Error('Rex did not return the new console identity');
    return { metadata: { type: 'terminal', backend: 'rex', name, sessionId: created.session_id, windowId: terminal.window_id, blockId: terminal.block_ids[0] }, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export class RunConsole {
  static async start({ config, run, redactor, input, signal, launch = command }) {
    if (config.herdr?.enabled !== true && config.rex?.enabled !== true) return null;
    const view = new RunConsole(redactor, input);
    try {
      const root = resolve(config.dataDirectory, 'consoles');
      await mkdir(root, { recursive: true, mode: 0o700 });
      await ownerOnly(root, 'isDirectory');
      view.directory = await mkdtemp(join(root, 'run-'));
      await chmod(view.directory, 0o700);
      view.path = join(view.directory, 'ipc');
      if (Buffer.byteLength(view.path) > 100) throw Error('Runner data path is too long for a portable private console socket');
      view.secret = randomBytes(32).toString('hex');
      await writeFile(`${view.path}.auth`, view.secret, { mode: 0o600, flag: 'wx' });
      view.server = createServer(socket => view.accept(socket));
      await new Promise((done, reject) => { view.server.once('error', reject); view.server.listen(view.path, done); });
      view.server.on('error', () => { void view.close('Console IPC unavailable; native run remains managed by Origin.'); });
      await chmod(view.path, 0o600);
      const env = baseEnvironment();
      for (const key of ['HC_SESSION', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) if (process.env[key]) env[key] = process.env[key];
      const options = { env, cwd: view.directory, timeoutMs: 10000, maxOutput: 65536, signal };
      view.metadata = [];
      view.publish({ type: 'log', text: `Origin run console — not the native harness UI.\nRun: ${run.id}; attempt: ${run.attempt ?? 1}\n${run.verificationOnly ? 'Verification-only: no model will start.\n' : ''}Task text sends a follow-up; /cancel requests cancellation; /quit closes this view only.\nTool approvals remain in the Origin owner UI.\n\n` });
      // Each optional viewer shares this exact socket, authorization and input ledger.
      for (const backend of ['herdr', 'rex']) {
        if (config[backend]?.enabled !== true) continue;
        try {
          const name = `origin-${randomBytes(10).toString('hex')}`;
          if (backend === 'herdr') {
            const session = process.env.HC_SESSION || 'default';
            if (!identifier(session)) throw Error('Invalid Herdr session');
            const status = JSON.parse((await launch('hc', ['server', 'status', '--json'], options)).stdout);
            if (!identifier(status.core?.id)) throw Error('Herdr core metadata unavailable');
            const terminal = JSON.parse((await launch('hc', ['run', '--bg', '--json', '--no-parent', '--no-notify', '--name', name, '--', process.execPath, self, view.path], options)).stdout);
            if (!identifier(terminal.address) || terminal.name !== name || terminal.state !== 'live') throw Error('Herdr did not return the new run console');
            view.metadata.push({ type: 'terminal', backend, coreId: status.core.id, terminalId: terminal.address, name, session });
          } else {
            const rex = await startRexViewer({ config, name, path: view.path, launch, options });
            view.metadata.push(rex.metadata); view.cleanupRex = rex.cleanup;
          }
        } catch (error) {
          if (error.processStopUnproven || signal?.aborted) throw error;
          view.metadata.push({ type: 'log', stream: 'system', text: `${backend === 'rex' ? 'Rex' : 'Herdr'} run console unavailable. Native execution and Origin owner controls remain authoritative.` });
        }
      }
      return view;
    } catch (error) { await view.close('Console unavailable; use Origin run controls.'); throw error; }
  }
  constructor(redactor, input) { this.redactor = redactor; this.input = input; this.sockets = new Set(); this.history = []; this.bytes = 0; this.pending = 0; this.closed = false; }
  publish(event) {
    const text = consoleEventText(event, this.redactor);
    // Chunk output so replay and live frames have the same bounded size.
    for (let offset = 0; offset < text.length; offset += 4096) {
      const frame = { type: 'output', text: text.slice(offset, offset + 4096) };
      const bytes = Buffer.byteLength(frame.text);
      this.history.push(frame); this.bytes += bytes;
      while (this.bytes > 128 * 1024) this.bytes -= Buffer.byteLength(this.history.shift().text);
      for (const socket of this.sockets) if (socket.authenticated) send(socket, frame);
    }
  }
  accept(socket) {
    if (this.closed || this.sockets.size >= 4) { socket.destroy(); return; }
    this.sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); this.sockets.delete(socket); });
    lines(socket, line => {
      const frame = JSON.parse(line);
      if (!socket.authenticated) {
        if (frame?.type !== 'auth' || typeof frame.token !== 'string' || !/^[a-f0-9]{64}$/.test(frame.token) || !timingSafeEqual(Buffer.from(frame.token), Buffer.from(this.secret))) { socket.destroy(); return; }
        clearTimeout(timer); socket.authenticated = true;
        send(socket, { type: 'ready' });
        for (const entry of this.history) send(socket, entry);
        return;
      }
      const request = validateConsoleInput(frame);
      if (this.closed || this.pending >= 16) { send(socket, { type: 'reply', id: request.id, ok: false, message: 'Console is closing or busy; no input admitted.' }); return; }
      this.pending++;
      Promise.resolve().then(() => this.input(request)).then(result => send(socket, { type: 'reply', id: request.id, ok: true, ...result }), () => send(socket, { type: 'reply', id: request.id, ok: false, message: 'Input not confirmed. Check Origin; retry only with the same request ID.' })).finally(() => { this.pending--; });
    }, () => socket.destroy());
  }
  async close(message = 'Run console closed. Use Origin for the final audited outcome.') {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      for (const socket of this.sockets) {
        if (socket.authenticated) send(socket, { type: 'closed', message });
        socket.end(); socket.destroySoon();
        const timer = setTimeout(() => socket.destroy(), 250);
        timer.unref(); socket.once('close', () => clearTimeout(timer));
      }
      if (this.server?.listening) await new Promise(done => this.server.close(done));
      if (this.directory) await rm(this.directory, { recursive: true, force: true });
      await this.cleanupRex?.();
    })();
    return this.closing;
  }
}

export async function runConsoleViewer(path) {
  if (!path || !path.startsWith('/') || Buffer.byteLength(path) > 100) throw Error('Expected a private Origin run socket');
  await ownerOnly(dirname(path), 'isDirectory'); await ownerOnly(path, 'isSocket'); await ownerOnly(`${path}.auth`, 'isFile');
  const token = await readFile(`${path}.auth`, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid local console credential');
  const socket = createConnection(path);
  let ready = false;
  const pending = new Map();
  const print = text => { if (process.stdout.writableLength > BUFFER_LIMIT) { socket.destroy(); return; } process.stdout.write(plain(text)); };
  const input = line => {
    const text = line.replace(/\r$/, '');
    if (text === '/quit') { socket.end(); return; }
    if (!text.trim()) return;
    if (!ready || pending.size >= 16) { print('\nConsole not ready or awaiting requests.\n'); return; }
    const request = { id: randomUUID(), action: text === '/cancel' ? 'cancel' : 'followup', ...(text === '/cancel' ? {} : { text }) };
    try { validateConsoleInput(request); } catch (error) { print(`\n${error.message}\n`); return; }
    pending.set(request.id, request); send(socket, request);
    print(`\n[Origin request ${request.id}] awaiting admission\n`);
  };
  socket.once('connect', () => send(socket, { type: 'auth', token }));
  lines(socket, line => {
    const frame = JSON.parse(line);
    if (frame.type === 'ready') ready = true;
    else if (frame.type === 'output') print(frame.text);
    else if (frame.type === 'reply') { pending.delete(frame.id); print(`\n[Origin request ${frame.id}] ${frame.ok ? frame.state ?? 'accepted' : frame.message}\n`); }
    else if (frame.type === 'closed') print(`\n${frame.message}\n`);
  }, () => socket.destroy());
  lines(process.stdin, input, () => { print('\nInput exceeds console line limit; view closed without cancelling the run.\n'); socket.destroy(); });
  const leave = () => socket.destroy();
  process.on('SIGINT', leave); process.on('SIGTERM', leave);
  process.stdin.once('end', leave);
  await new Promise(done => { socket.on('error', () => {}); socket.once('close', done); });
  process.removeListener('SIGINT', leave); process.removeListener('SIGTERM', leave);
  process.stdin.pause(); process.stdin.removeAllListeners('data'); process.stdin.removeListener('end', leave);
  print('\nView disconnected. This does not cancel native execution. Check Origin for the audited outcome.\n');
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  if (process.argv.length !== 3) { console.error('Usage: run-console.mjs PRIVATE_RUN_SOCKET'); process.exitCode = 1; }
  else runConsoleViewer(process.argv[2]).catch(() => { console.error('Origin run console unavailable. No native execution was cancelled.'); process.exitCode = 1; });
}
