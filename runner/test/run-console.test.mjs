import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { RunConsole, consoleEventText, validateConsoleInput } from '../run-console.mjs';
import { Runner } from '../worker.mjs';
import { EventJournal, Lease } from '../protocol.mjs';
import { Redactor, readJson } from '../security.mjs';
import { ManagedProcess } from '../process.mjs';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'oc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function launcher(calls = []) {
  return async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (args[0] === 'server') return { stdout: JSON.stringify({ core: { id: 'fixture-core' } }) };
    return { stdout: JSON.stringify({ address: 't1', name: args[args.indexOf('--name') + 1], state: 'live' }) };
  };
}
async function viewFixture(t, input = async () => ({ state: 'delivered' })) {
  const root = await directory(t), calls = [];
  const view = await RunConsole.start({ config: { dataDirectory: root, herdr: { enabled: true } }, run: { id: 'run-one' }, redactor: new Redactor(['private-secret']), input, launch: launcher(calls) });
  t.after(() => view.close());
  return { view, root, calls };
}
async function connect(t, view, token) {
  const socket = createConnection(view.path), frames = [], waiting = [];
  let buffer = '';
  socket.setEncoding('utf8'); socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const waiter = waiting.find(value => value.predicate(frame));
      if (waiter) { waiting.splice(waiting.indexOf(waiter), 1); waiter.resolve(frame); } else frames.push(frame);
    }
  });
  t.after(() => socket.destroy());
  const next = predicate => {
    const index = frames.findIndex(predicate);
    if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
    return new Promise(resolve => waiting.push({ predicate, resolve }));
  };
  await once(socket, 'connect');
  socket.write(`${JSON.stringify({ type: 'auth', token: token ?? await readFile(`${view.path}.auth`, 'utf8') })}\n`);
  return { socket, next, send: request => socket.write(`${JSON.stringify(request)}\n`) };
}
async function activeFixture(t, control = async () => ({ leaseValid: true })) {
  const root = await directory(t), messages = [], requests = [];
  const client = { request: async (op, input) => { requests.push({ op, input }); return op === 'control' ? control(input) : { accepted: true }; } };
  const runner = new Runner({ dataDirectory: root, hostToken: 'host-private' }, { client });
  const run = { id: 'run-one', leaseToken: 'lease-private' };
  const record = await runner.ledger.claim(run), redactor = new Redactor(['private-secret']);
  const active = { run, abort: new AbortController(), lease: new Lease(60), journal: new EventJournal(runner.ledger, record, client, redactor), sourceRedactor: redactor, approvals: new Map(), messages: [], messageReady: true, handle: { message: async text => messages.push(text) } };
  runner.active = active;
  return { runner, active, messages, requests };
}

test('disabled console makes no filesystem or hc call, and disabled worker never schedules personal-core helpers', async t => {
  let calls = 0;
  assert.equal(await RunConsole.start({ config: {}, launch: () => { calls++; } }), null);
  const root = await directory(t);
  const runner = new Runner({ dataDirectory: root }, { client: { request: async (_op, payload) => { assert.deepEqual(payload.herdr, { enabled: false, cloudConnections: false }); return { herdrPlans: [{}] }; } }, herdrConnections: { report: () => { calls++; }, schedule: () => { calls++; } } });
  await runner.heartbeat(); assert.equal(calls, 0);
});

test('console launches only its fixed viewer and authenticates through an owner-only per-run socket', { timeout: 5000 }, async t => {
  const { view, calls } = await viewFixture(t);
  assert.equal((await stat(view.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(view.path)).mode & 0o777, 0o600);
  assert.equal((await stat(`${view.path}.auth`)).mode & 0o777, 0o600);
  assert.deepEqual(calls.map(call => call.args[0]), ['server', 'run']);
  const args = calls[1].args;
  assert.ok(args.includes('--no-parent')); assert.ok(args.includes('--no-notify'));
  assert.ok(!args.includes('--keep')); assert.ok(!args.includes('--on'));
  assert.deepEqual(args.slice(args.indexOf('--') + 1), [process.execPath, new URL('../run-console.mjs', import.meta.url).pathname, view.path]);
  const token = await readFile(`${view.path}.auth`, 'utf8');
  assert.ok(!args.includes(token));
  const bad = await connect(t, view, '0'.repeat(64));
  await once(bad.socket, 'close');
  const good = await connect(t, view); await good.next(frame => frame.type === 'ready');
  assert.match((await good.next(frame => frame.type === 'output')).text, /not the native harness UI/);
  assert.deepEqual(view.metadata, [{ type: 'terminal', backend: 'herdr', coreId: 'fixture-core', terminalId: 't1', name: args[args.indexOf('--name') + 1], session: process.env.HC_SESSION || 'default' }]);
});

test('untrusted output cannot issue clipboard, terminal title, OSC7501 status or cursor commands', async t => {
  const { view } = await viewFixture(t);
  const poison = '\x1b]52;c;c2VjcmV0\x07\x1b]0;spoof\x07\x1b]7501;{"status":"success"}\x1b\\\x1b[2J\x1b[H\x00\x07\rprivate-secret actual progress\n';
  const text = consoleEventText({ type: 'log', text: poison }, new Redactor(['private-secret']));
  assert.equal(text, '[REDACTED] actual progress\n');
  const client = await connect(t, view); await client.next(frame => frame.type === 'ready');
  view.publish({ type: 'log', text: poison });
  assert.equal((await client.next(frame => frame.type === 'output' && frame.text.includes('actual progress'))).text, text);
  assert.match(consoleEventText({ type: 'approval', tool: 'shell' }, new Redactor([])), /cannot approve/);
});

test('IPC binds requests to its run; other run credentials, targeting fields and approvals are refused', { timeout: 5000 }, async t => {
  const received = [];
  const first = await viewFixture(t, async request => { received.push(request); return { state: 'delivered' }; });
  const second = await viewFixture(t);
  const foreign = await connect(t, first.view, await readFile(`${second.view.path}.auth`, 'utf8'));
  await once(foreign.socket, 'close');
  for (const request of [{ id: 'x', action: 'approve', text: 'allow' }, { id: 'x', action: 'followup', text: 'hello', runId: 'another' }, { id: 'x', action: 'cancel', terminalId: 't2' }]) {
    const client = await connect(t, first.view); await client.next(frame => frame.type === 'ready');
    client.send(request); await once(client.socket, 'close');
  }
  const valid = await connect(t, first.view); await valid.next(frame => frame.type === 'ready');
  valid.send({ id: 'one', action: 'followup', text: 'Check the task output' });
  assert.equal((await valid.next(frame => frame.type === 'reply')).state, 'delivered');
  assert.deepEqual(received, [{ id: 'one', action: 'followup', text: 'Check the task output' }]);
});

test('output replay and request lines are bounded and closing a viewer does not call cancellation', { timeout: 5000 }, async t => {
  let inputs = 0;
  const { view } = await viewFixture(t, async () => { inputs++; });
  view.publish({ type: 'log', text: 'x'.repeat(400000) });
  assert.ok(view.bytes <= 128 * 1024);
  const client = await connect(t, view); await client.next(frame => frame.type === 'ready');
  client.socket.write('x'.repeat(32769)); await once(client.socket, 'close');
  assert.equal(inputs, 0); assert.equal(view.closed, false);
  const next = await connect(t, view); await next.next(frame => frame.type === 'ready');
  next.socket.destroy(); assert.equal(inputs, 0);
  await view.close(); await assert.rejects(stat(view.path), { code: 'ENOENT' });
});

test('native viewer renders output and /quit detaches without issuing a run control', { timeout: 10000 }, async t => {
  const received = [], { view } = await viewFixture(t, async request => { received.push(request); return { state: 'delivered' }; });
  const child = new ManagedProcess(process.execPath, [new URL('../run-console.mjs', import.meta.url).pathname, view.path]);
  t.after(() => child.stop());
  let output = '', ready;
  const shown = new Promise(resolve => { ready = resolve; });
  child.child.stdout.setEncoding('utf8');
  child.child.stdout.on('data', text => { output += text; if (output.includes('not the native harness UI')) ready(); });
  await shown;
  await child.send('/quit\n'); await child.exit;
  assert.deepEqual(received, []); assert.equal(view.closed, false);
  assert.match(output, /does not cancel native execution/);
});

test('private console directory permissions are enforced before hc is invoked', async t => {
  const { view, root } = await viewFixture(t);
  await view.close(); await chmod(join(root, 'consoles'), 0o755);
  let calls = 0;
  await assert.rejects(RunConsole.start({ config: { dataDirectory: root, herdr: { enabled: true } }, run: {}, redactor: new Redactor([]), input: () => {}, launch: async () => { calls++; } }), /exclusively/);
  assert.equal(calls, 0);
});

test('local input refreshes authorization and serializes server messages before durable once-only delivery', async t => {
  const { runner, active, messages, requests } = await activeFixture(t, async () => ({ leaseValid: true, messages: [{ id: 'server-one', text: 'Origin follow-up' }] }));
  const input = { id: 'local-one', action: 'followup', text: 'Console follow-up' };
  const results = await Promise.all([runner.consoleInput(active, input), runner.consoleInput(active, input)]);
  assert.deepEqual(messages, ['Origin follow-up', 'Console follow-up']);
  assert.equal(results[1].duplicate, true); assert.equal(requests.length, 2);
  const saved = await readJson(runner.ledger.path(active.run.id));
  assert.equal(saved.consoleInputs[0].state, 'delivered');
  assert.ok(!JSON.stringify(saved).includes('Console follow-up'));
  active.journal.record = saved;
  await runner.consoleInput(active, input); assert.equal(messages.length, 2);
  await assert.rejects(runner.consoleInput(active, { ...input, text: 'Different payload' }), /already used/);
});

test('durably admitted uncertain input is never replayed after a native send failure or reload', async t => {
  const { runner, active } = await activeFixture(t);
  let deliveries = 0;
  active.handle.message = async () => {
    deliveries++;
    const durable = await readJson(runner.ledger.path(active.run.id));
    assert.equal(durable.consoleInputs[0].state, 'admitted');
    throw Error('Native RPC send became uncertain');
  };
  const input = { id: 'uncertain', action: 'followup', text: 'Change one task file' };
  await assert.rejects(runner.consoleInput(active, input), /uncertain/);
  active.journal.record = await readJson(runner.ledger.path(active.run.id));
  assert.deepEqual(await runner.consoleInput(active, input), { state: 'uncertain', duplicate: true });
  assert.equal(deliveries, 1);
});

test('revoked authorization, closed runs, verification-only work and approval commands cannot inject model input', async t => {
  const rejected = await activeFixture(t, async () => ({ leaseValid: false }));
  await assert.rejects(rejected.runner.consoleInput(rejected.active, { id: 'revoked', action: 'followup', text: 'Do not send' }));
  assert.equal(rejected.active.leaseLost, true); assert.equal(rejected.active.abort.signal.aborted, true);
  assert.deepEqual(rejected.messages, []);
  const { runner, active, messages } = await activeFixture(t);
  active.finishing = true;
  await assert.rejects(runner.consoleInput(active, { id: 'finishing', action: 'followup', text: 'Start a model' }), /not accepting/);
  assert.throws(() => validateConsoleInput({ id: 'approve', action: 'followup', text: '/approve all' }));
  active.closing = true;
  await assert.rejects(runner.consoleInput(active, { id: 'closed', action: 'cancel' }), /closed/);
  assert.deepEqual(messages, []); assert.equal(active.abort.signal.aborted, false);
});

test('local cancel is durably admitted before abort and cannot resolve pending tool approval', async t => {
  const { runner, active } = await activeFixture(t);
  let permission;
  active.approvals.set('pending-tool', value => { permission = value; });
  assert.deepEqual(await runner.consoleInput(active, { id: 'cancel-one', action: 'cancel' }), { state: 'delivered' });
  assert.equal(active.abort.signal.aborted, true); assert.equal(permission, undefined);
  assert.equal((await readJson(runner.ledger.path(active.run.id))).consoleInputs[0].state, 'delivered');
});

test('heartbeat reports opt-in, schedules received grants and revokes plans on controller failure without awaiting native work', async t => {
  const root = await directory(t), schedules = [];
  let fail = false;
  const runner = new Runner({ dataDirectory: root, herdr: { enabled: true } }, {
    client: { request: async (_op, payload) => { assert.equal(payload.herdr.enabled, true); if (fail) throw Error('Offline'); return { herdrPlans: [{ name: 'authorized' }] }; } },
    herdrConnections: { report: () => ({ enabled: true, cloudConnections: true }), schedule: plans => { schedules.push(plans); return new Promise(() => {}); } },
  });
  await runner.heartbeat(); fail = true; await assert.rejects(runner.heartbeat(), /Offline/);
  assert.deepEqual(schedules, [[{ name: 'authorized' }], []]);
});

test('Rex and Herdr share one authenticated socket; either viewer can detach without cancelling the run', { timeout: 5000 }, async t => {
  const root = await directory(t), calls = [], inputs = [];
  const id = '00000000-0000-0000-0000-000000000001';
  const view = await RunConsole.start({
    config: { dataDirectory: root, herdr: { enabled: true }, rex: { enabled: true, server: 'unix:///private/rex.sock' } },
    run: { id: 'same-run' }, redactor: new Redactor(['private-secret']), input: async value => { inputs.push(value); return { state: 'delivered' }; },
    launch: async (executable, args, options) => {
      calls.push({ executable, args, options });
      if (executable === 'hc') return launcher()(executable, args, options);
      if (args[0] === 'version') return { stdout: 'rex 0.1.0-preview.13\ncommit: pinned\n' };
      if (args.includes('status')) return { stdout: JSON.stringify({ rex_version: '0.1.0-preview.13', instance_id: 'instance', you: { transport: 'unix' } }) };
      assert.ok(args.includes('--autostart=false'));
      assert.equal(options.env.REX_SESSION, undefined); assert.equal(options.env.REX_BLOCK, undefined);
      if (args.includes('session.create')) return { stdout: JSON.stringify({ session_id: `session:${id}` }) };
      if (args.includes('run')) return { stdout: JSON.stringify({ window_id: `window:${id}`, block_ids: [`block:${id}`] }) };
      assert.ok(args.includes('kill')); return { stdout: '' };
    },
  });
  t.after(() => view.close());
  assert.deepEqual(view.metadata.map(value => value.backend), ['herdr', 'rex']);
  const commands = calls.filter(value => value.args.includes('run'));
  assert.equal(commands.length, 2);
  for (const { args } of commands) assert.deepEqual(args.slice(args.indexOf('--') + 1), [process.execPath, new URL('../run-console.mjs', import.meta.url).pathname, view.path]);
  const rex = commands.find(value => value.executable === 'rex').args;
  assert.ok(rex.includes('--shell=none')); assert.ok(rex.includes('--focus=false'));
  assert.ok(!rex.includes('--keep-open')); assert.ok(!rex.includes('--interactive'));
  const first = await connect(t, view), second = await connect(t, view);
  await first.next(frame => frame.type === 'ready'); await second.next(frame => frame.type === 'ready');
  view.publish({ type: 'log', text: 'private-secret shared progress\n' });
  for (const client of [first, second]) assert.equal((await client.next(frame => frame.type === 'output' && frame.text.includes('shared progress'))).text, '[REDACTED] shared progress\n');
  first.socket.destroy(); assert.equal(view.closed, false); assert.deepEqual(inputs, []);
  second.send({ id: 'same-task', action: 'followup', text: 'Continue the task' });
  assert.equal((await second.next(frame => frame.type === 'reply')).state, 'delivered');
  assert.deepEqual(inputs, [{ id: 'same-task', action: 'followup', text: 'Continue the task' }]);
});

for (const failed of ['hc', 'rex']) test(`${failed} failure leaves the other console and shared IPC alive`, async t => {
  const root = await directory(t), id = '00000000-0000-0000-0000-000000000002';
  const view = await RunConsole.start({
    config: { dataDirectory: root, herdr: { enabled: true }, rex: { enabled: true } }, run: { id: 'run' }, redactor: new Redactor([]), input: async () => ({ state: 'delivered' }),
    launch: async (executable, args, options) => {
      if (executable === failed) throw Error('private native diagnostic');
      if (executable === 'hc') return launcher()(executable, args, options);
      if (args[0] === 'version') return { stdout: 'rex 0.1.0-preview.13\ncommit: pinned\n' };
      if (args.includes('status')) return { stdout: JSON.stringify({ rex_version: '0.1.0-preview.13', instance_id: 'instance', you: { transport: 'unix' } }) };
      return { stdout: JSON.stringify(args.includes('session.create') ? { session_id: `session:${id}` } : { window_id: `window:${id}`, block_ids: [`block:${id}`] }) };
    },
  });
  t.after(() => view.close());
  assert.equal(view.closed, false);
  assert.deepEqual(view.metadata.filter(event => event.type === 'terminal').map(event => event.backend), [failed === 'hc' ? 'rex' : 'herdr']);
  assert.equal(JSON.stringify(view.metadata).includes('private native diagnostic'), false);
  const client = await connect(t, view); await client.next(frame => frame.type === 'ready');
  client.send({ id: 'remaining', action: 'followup', text: 'Same run continues' });
  assert.equal((await client.next(frame => frame.type === 'reply')).state, 'delivered');
});
