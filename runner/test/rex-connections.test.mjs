import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RexConnections, validateCloudRexPlan } from '../rex-connections.mjs';
import { REX_SOCKET, REX_VERSION, rexCommand } from '../rex.mjs';

function plan(patch = {}, now = Date.now()) {
  return { schemaVersion: 1, allocationId: 'allocation', hostId: 'cloud-host', provider: 'boxd', desktop: 'nixos', machineId: 'machine', machineName: 'machine', name: `origin-rex-boxd-${createHash('sha256').update(JSON.stringify(['allocation', 'nixos'])).digest('hex').slice(0, 20)}`, issuedAt: now, expiresAt: now + 60000, core: { version: REX_VERSION, socket: REX_SOCKET, user: 'origin-runner' }, ...patch };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'orx-'));
  const registry = [], calls = [];
  const config = { kind: 'nixos', dataDirectory: root, rex: { enabled: true, cloudConnections: true } };
  const launch = async (executable, args) => {
    calls.push({ executable, args });
    if (args[0] === 'version') return { stdout: `rex ${REX_VERSION}\ncommit: pinned\n` };
    if (args.includes('status')) return { stdout: JSON.stringify({ rex_version: REX_VERSION, instance_id: 'instance', you: { transport: 'unix' } }) };
    const index = args.indexOf('hosts');
    if (args[index + 1] === 'add') registry.push({ host: { label: args[index + 2], endpoints: [args[index + 3]] } });
    else if (args[index + 1] === 'remove') registry.splice(registry.findIndex(row => row.host.label === args[index + 2]), 1);
    return { stdout: JSON.stringify({ hosts: registry }) };
  };
  const helper = new RexConnections(config, { launch, spawnRelay: () => { throw Error('SSH must not be reached'); } });
  t.after(async () => { await helper.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, registry, calls, config, helper, launch };
}
async function settled(helper) { while (helper.running) await helper.running; }

test('Rex grants reject arbitrary targets, commands, expired leases and changed ownership before native access', () => {
  const now = 1800000000000;
  assert.equal(validateCloudRexPlan(plan({}, now), now).core.socket, REX_SOCKET);
  for (const patch of [{ expiresAt: now }, { expiresAt: now + 60001 }, { issuedAt: now + 5001 }, { name: 'personal' }, { machineId: '--option' }, { machineId: 123 }, { remotePrefix: 'sh -c' }, { command: 'run-model' }, { core: { version: REX_VERSION, socket: '/root/rex.sock', user: 'root' } }]) {
    assert.throws(() => validateCloudRexPlan(plan(patch, now), now));
  }
  for (const server of ['http://127.0.0.1:7297', 'https://personal.example', 'unix://relative', 'unix:///private\n--option']) assert.throws(() => rexCommand({ rex: { server } }));
});

test('revocation fences a connection while native provider discovery is blocked', async t => {
  const f = await fixture(t);
  f.helper.schedule([plan()]); await settled(f.helper);
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  f.helper.launch = async (executable, args, options) => {
    if (executable === 'boxd') { reached(); await new Promise(resolve => { release = resolve; }); return { stdout: JSON.stringify({ id: 'machine', status: 'running' }) }; }
    return f.launch(executable, args, options);
  };
  const entry = [...f.helper.entries.values()][0];
  const socket = createConnection(join(f.helper.root, `${entry.plan.name}.sock`)); socket.on('error', () => {});
  t.after(() => socket.destroy()); await waiting;
  const closed = once(socket, 'close'); f.helper.schedule([]);
  assert.equal(entry.closed, true); assert.equal(entry.abort.signal.aborted, true);
  release(); await closed; await settled(f.helper);
  assert.equal(entry.children.size, 0); assert.deepEqual(f.registry, []);
});

test('expiry closes owned listeners without a new heartbeat and never touches the private Rex server', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1800000000000 });
  const f = await fixture(t);
  f.helper.schedule([plan()]); await settled(f.helper);
  const entry = [...f.helper.entries.values()][0];
  t.mock.timers.tick(60001);
  assert.equal(entry.closed, true); assert.equal(entry.abort.signal.aborted, true);
  assert.equal(f.calls.some(({ args }) => args.includes('stop') || args.includes('kill')), false);
  await f.helper.stop(); assert.deepEqual(f.registry, []);
});

test('stopped or uncertain cloud machines cannot reach SSH even with an unexpired grant', async t => {
  for (const status of ['stopped', 'starting', 'unknown']) {
    const f = await fixture(t); f.helper.schedule([plan()]); await settled(f.helper);
    f.helper.launch = async (executable, args, options) => executable === 'boxd' ? { stdout: JSON.stringify({ id: 'machine', status }) } : f.launch(executable, args, options);
    const entry = [...f.helper.entries.values()][0];
    const socket = createConnection(join(f.helper.root, `${entry.plan.name}.sock`)); socket.on('error', () => {});
    await once(socket, 'close'); assert.equal(entry.closed, true); assert.equal(entry.children.size, 0);
    assert.equal(f.helper.report().status, 'needs_auth');
  }
});

test('changed native registry endpoints are never removed as Origin-owned state', async t => {
  const f = await fixture(t); f.helper.schedule([plan()]); await settled(f.helper);
  f.registry[0].host.endpoints = ['unix:///personal/socket'];
  f.helper.schedule([]); await settled(f.helper);
  assert.equal(f.registry.length, 1); assert.equal(f.registry[0].host.endpoints[0], 'unix:///personal/socket');
  assert.equal(f.helper.entries.size, 0);
});

test('Rex preferences preserve Herdr and private configuration and never shut down a server', async t => {
  const f = await fixture(t), path = join(f.root, 'config.json');
  const original = { controller: 'https://origin.example.test', hostId: 'host', hostToken: 'owner-secret', dataDirectory: f.root, kind: 'nixos', herdr: { enabled: true, cloudConnections: true }, rex: { executable: '/missing/private/rex', server: 'unix:///private/socket' }, accounts: [{ id: 'account', directory: '/personal/auth' }] };
  await writeFile(path, JSON.stringify(original), { mode: 0o600 });
  const run = (...args) => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'rex', ...args, '--config', path]);
  await writeFile(join(f.root, 'worker.lock'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  await assert.rejects(run('enable', '--cloud'), /Stop the runner/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), original);
  await rm(join(f.root, 'worker.lock'));
  await run('enable', '--cloud');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).rex.cloudConnections, true);
  const report = (await run('status')).stdout;
  assert.equal(JSON.parse(report).rex.status, 'unavailable'); assert.equal(report.includes('owner-secret'), false);
  await run('disable');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ...original, rex: { ...original.rex, enabled: false, cloudConnections: false } });
});
