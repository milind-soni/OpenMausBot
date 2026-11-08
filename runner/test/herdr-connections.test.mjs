import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HerdrConnections } from '../herdr-connections.mjs';

function plan(id = 'allocation', patch = {}) {
  const issuedAt = Date.now();
  return { schemaVersion: 1, allocationId: id, hostId: 'cloud-host', provider: 'boxd', desktop: 'nixos', machineId: 'vm-1', machineName: 'vm-one', name: `origin-boxd-${createHash('sha256').update(JSON.stringify([id, 'nixos'])).digest('hex').slice(0, 20)}`, issuedAt, expiresAt: issuedAt + 60000, core: { version: '0.1.18', session: 'origin-cloud', user: 'origin-runner' }, remotePrefix: 'sudo -n -u origin-runner env -i HOME=/var/lib/origin-runner PATH=/usr/bin bash -c', ...patch };
}
async function fixture(t, herdr = { enabled: true, cloudConnections: true }) {
  const directory = await mkdtemp(join(tmpdir(), 'origin-herdr-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'owned');
  await mkdir(root, { mode: 0o700 });
  const config = { kind: 'nixos', dataDirectory: directory, herdr };
  const calls = [];
  const command = async (executable, args) => {
    calls.push({ executable, args });
    if (executable === 'hc') return 'hc 0.1.18\n';
    const [, action, path] = args;
    if (action === 'remove') { await rm(path, { force: true }); return ''; }
    const saved = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(join(root, `${saved.name}.json`), JSON.stringify({ ...saved, originOwned: true }), { mode: 0o600 });
    return '';
  };
  return { directory, root, config, calls, command, helper: new HerdrConnections(config, { stateRoot: root, command }) };
}
async function settled(helper) { while (helper.running) await helper.running; }

test('default and console-only opt-in never connect cloud plans', async t => {
  const f = await fixture(t, undefined);
  delete f.config.herdr;
  assert.deepEqual(f.helper.report(), { enabled: false, cloudConnections: false });
  assert.equal(f.helper.schedule([plan()]), undefined);
  await settled(f.helper);
  assert.equal(f.calls.length, 0);
  f.config.herdr = { enabled: true, cloudConnections: false };
  f.helper.schedule([plan()]);
  await settled(f.helper);
  assert.deepEqual(f.calls.map(call => call.executable), ['hc']);
  await f.helper.stop();
});

test('renewal replaces only Origin plans, strips extra fields and revokes absent aliases', async t => {
  const f = await fixture(t), first = plan();
  const personal = join(f.root, 'personal.json');
  await writeFile(personal, '{"name":"personal","originOwned":false}', { mode: 0o600 });
  f.helper.schedule([{ ...first, providerCredentials: 'never-persist-this' }]);
  await settled(f.helper);
  const owned = join(f.root, `${first.name}.json`);
  assert.equal((await readFile(owned, 'utf8')).includes('never-persist-this'), false);
  f.helper.schedule([{ ...first, issuedAt: first.issuedAt + 1, expiresAt: first.expiresAt + 1 }]);
  await settled(f.helper);
  assert.deepEqual(f.calls.filter(call => call.executable !== 'hc').map(call => call.args[1]), ['add', 'refresh']);
  f.helper.schedule([]);
  await settled(f.helper);
  await assert.rejects(access(owned));
  await access(personal);
  assert.deepEqual(Object.keys(f.helper.report()).sort(), ['cloudConnections', 'enabled', 'status', 'version']);
  await f.helper.stop();
});

test('slow native operations never block scheduling and pending grants are coalesced', async t => {
  const f = await fixture(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const helper = new HerdrConnections(f.config, { stateRoot: f.root, command: async (...args) => { if (args[0] === 'hc') { entered(); await blocked; } return f.command(...args); } });
  assert.equal(helper.schedule([plan()]), undefined);
  await started;
  for (let i = 0; i < 100; i++) assert.equal(helper.schedule([plan(`allocation-${i}`)]), undefined);
  helper.schedule([]);
  release();
  await settled(helper);
  assert.equal(f.calls.some(call => call.args[1] === 'add'), false);
  await helper.stop();
});

test('expired grants revoke owned aliases and provider login failures are safely reported', async t => {
  const f = await fixture(t), first = plan();
  f.helper.schedule([first]);
  await settled(f.helper);
  f.helper.schedule([{ ...first, issuedAt: Date.now() - 60001, expiresAt: Date.now() - 1 }]);
  await settled(f.helper);
  await assert.rejects(access(join(f.root, `${first.name}.json`)));
  f.helper.command = async () => { throw new Error('secret-provider-key native-user@example.test'); };
  f.helper.schedule([plan()]);
  await settled(f.helper);
  assert.equal(f.helper.report().status, 'needs_auth');
  assert.equal(JSON.stringify(f.helper.report()).includes('secret-provider-key'), false);
  assert.equal(JSON.stringify(f.helper.report()).includes('native-user@'), false);
  await f.helper.stop();
});

test('shutdown removes Origin aliases but never personal metadata', async t => {
  const f = await fixture(t), first = plan();
  f.helper.schedule([first]);
  await settled(f.helper);
  await f.helper.stop();
  await assert.rejects(access(join(f.root, `${first.name}.json`)));
  f.helper.schedule([first]);
  await settled(f.helper);
  assert.equal(f.calls.filter(call => call.args[1] === 'add').length, 1);
});

test('CLI requires explicit cloud opt-in and preserves auth/config through enable/status/disable', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'config.json');
  const original = { controller: 'https://origin.example.test', hostId: 'host', hostToken: 'owner-secret', dataDirectory: f.directory, kind: 'nixos', accounts: [{ id: 'native', directory: '/private/native-auth', profile: 'personal' }], updates: { publicKey: 'existing-trust' }, herdr: { personalSetting: 'keep' } };
  await writeFile(path, JSON.stringify(original), { mode: 0o600 });
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const run = (...args) => promisify(execFile)(process.execPath, [cli, 'herdr', ...args, '--config', path], { env: { ...process.env, XDG_STATE_HOME: join(f.directory, 'xdg-state') } });
  assert.deepEqual(JSON.parse((await run('status')).stdout).herdr, { enabled: false, cloudConnections: false });
  await run('enable');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).herdr.cloudConnections, false);
  await run('enable', '--cloud');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).herdr.cloudConnections, true);
  await run('disable');
  const current = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(current, { ...original, herdr: { personalSetting: 'keep', enabled: false, cloudConnections: false } });
  assert.equal((await run('status')).stdout.includes('owner-secret'), false);
});
