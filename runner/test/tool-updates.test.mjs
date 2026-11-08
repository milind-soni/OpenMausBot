import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, readdir, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { atomicJson, readJson, VERSION, hash } from '../security.mjs';
import { TOOL_PACKAGES, validateToolMetadata, validateManagedManifest, checkToolUpdates, maintainTools, managedInstallation, applyManagedTool, rollbackManagedTool, initializeManagedTool, initializeManagedAccount, recoverManagedToolUpdates, ownershipAction } from '../tool-updates.mjs';
import { withMaintenanceLock, compatibleStable, checkRunnerUpdate, applyRunnerRelease, beginRunnerUpdate, confirmRunnerUpdate, recoverRunnerUpdate, pinRunnerUpdates, boundedUpdateReports } from '../service.mjs';
import { automaticUpdateDue, automaticUpdatePolicy } from '../maintenance.mjs';
import { Runner } from '../worker.mjs';
import { RunLedger } from '../protocol.mjs';

const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
function metadata(harness = 'codex', version = '2.0.0') {
  const name = TOOL_PACKAGES[harness].package;
  return { name, version, dist: { integrity, tarball: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz` } };
}
async function packageFiles(release, harness, version) {
  const spec = TOOL_PACKAGES[harness], directory = join(release, 'node_modules', spec.package);
  await mkdir(join(directory, 'bin'), { recursive: true, mode: 0o700 });
  await mkdir(join(release, 'node_modules/.bin'), { recursive: true, mode: 0o700 });
  await atomicJson(join(directory, 'package.json'), { name: spec.package, version, bin: { [spec.bin]: `bin/${spec.bin}.js` } });
  await writeFile(join(directory, 'bin', `${spec.bin}.js`), '#!/usr/bin/env node\n// Protocol test artifact; never executed.\n', { mode: 0o700 });
  await symlink(`../${spec.package}/bin/${spec.bin}.js`, join(release, 'node_modules/.bin', spec.bin));
  const manifest = { schemaVersion: 1, managedBy: 'origin-runner', harness, package: spec.package, version, integrity, executable: `node_modules/.bin/${spec.bin}` };
  await atomicJson(join(release, 'release.json'), manifest);
  return manifest;
}
async function fixture(t, { managed = true, latestVersion = '2.0.0' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'origin-tool-update-')); t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'runner'); await mkdir(data, { recursive: true, mode: 0o700 });
  const home = join(data, 'tools/codex'), release = join(home, 'releases/1.0.0');
  await packageFiles(release, 'codex', '1.0.0'); await symlink(release, join(home, 'current'));
  const binary = join(home, 'current/node_modules/.bin/codex');
  const config = { dataDirectory: data, ...(managed ? { managedTools: { schemaVersion: 1, root: join(data, 'tools') } } : {}) };
  const accounts = [{ binding: { id: 'one', harness: 'codex', executable: binary } }];
  const calls = []; let failure;
  const dependencies = {
    npm: '/fixture/npm', executable: async value => value === binary ? value : null,
    fetch: async (url, options) => { assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, undefined); return new Response(JSON.stringify(metadata('codex', latestVersion))); },
    command: async (file, args, options) => {
      calls.push({ file, args, options });
      assert.equal(options.env.ORIGIN_HOST_TOKEN, undefined); assert.equal(options.env.SSH_AUTH_SOCK, undefined);
      if (file === '/fixture/npm') {
        assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--no-audit')); assert.equal(args.includes('--global'), false);
        const stage = args[args.indexOf('--prefix') + 1]; assert.ok(stage.startsWith(`${home}/releases/.stage-`));
        await packageFiles(stage, 'codex', latestVersion);
        await atomicJson(join(stage, 'package-lock.json'), { packages: { '': { dependencies: { '@openai/codex': latestVersion } }, 'node_modules/@openai/codex': { version: latestVersion, integrity: failure === 'integrity' ? 'wrong' : integrity, resolved: metadata('codex', latestVersion).dist.tarball } } });
        return { code: 0, stdout: '', stderr: '' };
      }
      const release = dirname(dirname(dirname(file)));
      const manifest = await readJson(join(release, 'release.json'));
      if (failure === 'stop' && manifest.version === latestVersion) throw Object.assign(new Error('Unproven process stop'), { processStopUnproven: true });
      if (args[0] === '--version') return { code: 0, stdout: `codex-cli ${manifest.version}${failure === 'prerelease' ? '-beta.1' : ''}\n`, stderr: '' };
      if (failure === 'post-switch' && file.includes(`/releases/${latestVersion}/`) && args[0] === '--help') throw new Error('Native post-switch preflight failed');
      return { code: 0, stdout: failure === 'interface' && manifest.version === latestVersion ? 'unrelated interface' : 'app-server', stderr: '' };
    },
  };
  return { root, data, home, release, binary, config, accounts, calls, dependencies, fail: value => { failure = value; } };
}

test('stable metadata and managed manifests reject prereleases, foreign sources and ownership forgery', () => {
  for (const harness of Object.keys(TOOL_PACKAGES)) assert.equal(validateToolMetadata(harness, metadata(harness)).name, TOOL_PACKAGES[harness].package);
  assert.throws(() => validateToolMetadata('codex', metadata('codex', '2.0.0-beta.1')), /stable/);
  assert.throws(() => validateToolMetadata('codex', { ...metadata(), dist: { integrity, tarball: 'https://evil.invalid/codex.tgz' } }), /approved/);
  assert.throws(() => validateToolMetadata('codex', { ...metadata(), name: '@other/codex' }), /stable/);
  assert.throws(() => validateManagedManifest('codex', { schemaVersion: 1, managedBy: 'personal', version: '1.0.0' }), /ownership/);
});

test('checks deduplicate local profiles and return real stable source/ownership metadata without installing', async t => {
  const f = await fixture(t);
  const plans = await checkToolUpdates(f.config, [...f.accounts, ...f.accounts], f.dependencies);
  assert.equal(plans.length, 1); assert.equal(plans[0].report.currentVersion, '1.0.0'); assert.equal(plans[0].report.availableVersion, '2.0.0');
  assert.equal(plans[0].report.status, 'available'); assert.match(plans[0].report.message, /registry.npmjs.org/); assert.match(plans[0].report.message, /Ownership: origin-runner/);
  assert.equal(f.calls.length, 0);
});

test('unmanaged installs receive actionable exact-version instructions and are never applied', async t => {
  const f = await fixture(t, { managed: false });
  const reports = await maintainTools(f.config, f.accounts, { apply: true }, f.dependencies);
  assert.equal(reports[0].status, 'available'); assert.match(reports[0].message, /not runner-owned/); assert.match(reports[0].message, /@openai\/codex@2\.0\.0/);
  assert.equal(f.calls.length, 0); assert.equal(await realpath(join(f.home, 'current')), f.release);
});

test('registry uncertainty remains unknown rather than current or applied', async t => {
  const f = await fixture(t); f.dependencies.fetch = async () => new Response('', { status: 503 });
  const reports = await maintainTools(f.config, f.accounts, { apply: true }, f.dependencies);
  assert.equal(reports[0].status, 'unknown'); assert.equal(reports[0].currentVersion, '1.0.0'); assert.equal(reports[0].availableVersion, undefined);
  assert.match(reports[0].message, /Ownership: origin-runner/); assert.equal(f.calls.length, 0);
});

test('only explicit aliases within the private ownership root can be mutated', async t => {
  const f = await fixture(t);
  assert.equal(await managedInstallation(f.config, 'codex', join(f.release, 'node_modules/.bin/codex')), null);
  await assert.rejects(managedInstallation({ ...f.config, managedTools: { schemaVersion: 1, root: f.root } }, 'codex'), /dataDirectory\/tools/);
  const manifest = await readJson(join(f.release, 'release.json')); manifest.executable = '../../../personal'; await atomicJson(join(f.release, 'release.json'), manifest);
  await assert.rejects(managedInstallation(f.config, 'codex'), /ownership/);
});

test('managed stable apply preserves old release, requires idle lock, and supports explicit verified rollback', async t => {
  const f = await fixture(t); const oldBytes = await readFile(join(f.release, 'node_modules/@openai/codex/bin/codex.js'));
  const [plan] = await checkToolUpdates(f.config, f.accounts, f.dependencies);
  await assert.rejects(applyManagedTool(f.config, plan, f.dependencies), /exclusive ownership/);
  const reports = await maintainTools(f.config, f.accounts, { apply: true }, f.dependencies);
  assert.equal(reports[0].status, 'current'); assert.equal(reports[0].currentVersion, '2.0.0');
  assert.equal(await realpath(join(f.home, 'current')), join(f.home, 'releases/2.0.0'));
  assert.deepEqual(await readFile(join(f.release, 'node_modules/@openai/codex/bin/codex.js')), oldBytes);
  assert.equal((await readJson(join(f.home, 'rollback.json'))).previous, f.release);
  await assert.rejects(rollbackManagedTool(f.config, 'codex', false, f.dependencies), /approve/);
  const rolled = await rollbackManagedTool(f.config, 'codex', true, f.dependencies);
  assert.equal(rolled.currentVersion, '1.0.0'); assert.equal(await realpath(join(f.home, 'current')), f.release);
});

test('checksum and required-native-interface failures never switch current', async t => {
  for (const reason of ['integrity', 'interface', 'prerelease']) {
    const f = await fixture(t); f.fail(reason);
    const reports = await maintainTools(f.config, f.accounts, { apply: true }, f.dependencies);
    assert.equal(reports[0].status, 'failed', reason); assert.equal(await realpath(join(f.home, 'current')), f.release);
    assert.deepEqual(await readdir(join(f.home, 'releases')), ['1.0.0']);
  }
});

test('failed post-switch preflight restores the previous release and quarantines failed version', async t => {
  const f = await fixture(t); f.fail('post-switch');
  const reports = await maintainTools(f.config, f.accounts, { apply: true }, f.dependencies);
  assert.equal(reports[0].status, 'failed'); assert.equal(await realpath(join(f.home, 'current')), f.release);
  assert.ok((await readdir(join(f.home, 'releases'))).some(name => name.startsWith('.failed-2.0.0-')));
  assert.equal(await readJson(join(f.home, 'rollback.json'), null), null);
});

test('active runs, foreign worker locks and uncertain process stops fence tool maintenance', async t => {
  const f = await fixture(t);
  await atomicJson(join(f.data, 'status.json'), { activeRunId: 'running' });
  await assert.rejects(withMaintenanceLock(f.config, async () => {}), /idle/);
  await atomicJson(join(f.data, 'status.json'), { activeRunId: null });
  await atomicJson(join(f.data, 'worker.lock'), { pid: process.pid + 1000 });
  await assert.rejects(withMaintenanceLock(f.config, async () => {}), /another process/);
  await rm(join(f.data, 'worker.lock')); f.fail('stop');
  await assert.rejects(maintainTools(f.config, f.accounts, { apply: true }, f.dependencies), /Unproven/);
  assert.ok(await readJson(join(f.data, 'tool-maintenance-fence.json')));
  await assert.rejects(withMaintenanceLock(f.config, async () => {}), /fenced/);
  assert.equal(await realpath(join(f.home, 'current')), f.release);
});

test('known unmanaged package managers have explicit nonexecuted upgrade actions', async () => {
  assert.match((await ownershipAction('codex', '/opt/homebrew/Caskroom/codex/1/bin/codex', '2.0.0')).action, /brew upgrade --cask/);
  assert.match((await ownershipAction('claude-code', '/home/user/.local/share/claude/versions/1.0.0', '2.0.0')).action, /install '2.0.0'/);
  const npm = await ownershipAction('omp', '/home/user/.npm-global/lib/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js', '2.0.0', { directory: '/home/user/.npm-global/lib/node_modules/@oh-my-pi/pi-coding-agent' });
  assert.match(npm.action, /npm install --global --prefix '\/home\/user\/.npm-global'/);
});

test('automatic policy is explicitly opted in, daily by default and durable across restarts', async t => {
  assert.equal(automaticUpdatePolicy({}), null);
  assert.equal(automaticUpdateDue({}, {}, 100), false);
  assert.equal(automaticUpdateDue({ automaticUpdates: { enabled: 'true' } }, {}, 100), false);
  const config = { automaticUpdates: { schemaVersion: 1, enabled: true, tools: ['codex'], runner: false } };
  assert.equal(automaticUpdatePolicy(config).intervalHours, 24);
  assert.equal(automaticUpdateDue(config, {}, 100), true);
  const f = await fixture(t);
  await atomicJson(join(f.data, 'automatic-updates.json'), { nextCheckAt: 86400100 });
  const persisted = await readJson(join(f.data, 'automatic-updates.json'));
  assert.equal(automaticUpdateDue(config, persisted, 86400099), false);
  assert.equal(automaticUpdateDue(config, persisted, 86400100), true);
  assert.throws(() => automaticUpdatePolicy({ automaticUpdates: { ...config.automaticUpdates, intervalHours: 0 } }), /Invalid/);
});

test('stable compatibility boundaries require explicit approval, including pre-1.0 minor changes', async t => {
  assert.equal(compatibleStable('1.2.3', '1.9.0'), true);
  assert.equal(compatibleStable('1.2.3', '2.0.0'), false);
  assert.equal(compatibleStable('0.2.3', '0.2.9'), true);
  assert.equal(compatibleStable('0.2.3', '0.3.0'), false);
  assert.equal(compatibleStable('1.0.0-beta', '1.0.0'), false);
  const f = await fixture(t);
  const reports = await maintainTools(f.config, f.accounts, { apply: true, automatic: true }, f.dependencies);
  assert.equal(reports[0].status, 'available'); assert.match(reports[0].message, /Compatibility boundary/);
  assert.equal(f.calls.length, 0); assert.equal(await realpath(join(f.home, 'current')), f.release);
  assert.equal((await maintainTools(f.config, f.accounts, { apply: true }, f.dependencies))[0].status, 'current');
});

test('automatic native patch applies only selected private prefixes and never downgrades', async t => {
  const f = await fixture(t, { latestVersion: '1.0.1' });
  assert.deepEqual(await maintainTools(f.config, f.accounts, { apply: true, automatic: true, harnesses: [] }, f.dependencies), []);
  assert.equal(f.calls.length, 0);
  const reports = await maintainTools(f.config, f.accounts, { apply: true, automatic: true, harnesses: ['codex'] }, f.dependencies);
  assert.equal(reports[0].currentVersion, '1.0.1');
  const old = await fixture(t, { latestVersion: '0.9.0' });
  const [plan] = await checkToolUpdates(old.config, old.accounts, old.dependencies);
  await assert.rejects(withMaintenanceLock(old.config, () => applyManagedTool(old.config, { ...plan, report: { ...plan.report, status: 'available' } }, old.dependencies)), /newer/);
  assert.equal(old.calls.length, 0);
});

test('failed native versions stay quarantined on restart and explicit rollback prevents reapplication', async t => {
  const f = await fixture(t, { latestVersion: '1.0.1' }); f.fail('interface');
  assert.equal((await maintainTools(f.config, f.accounts, { apply: true, automatic: true }, f.dependencies))[0].status, 'failed');
  const calls = f.calls.length; f.fail(undefined);
  const reports = await maintainTools(structuredClone(f.config), f.accounts, { apply: true, automatic: true }, f.dependencies);
  assert.equal(reports[0].status, 'failed'); assert.match(reports[0].message, /quarantined/); assert.equal(f.calls.length, calls);
  const good = await fixture(t, { latestVersion: '1.0.1' });
  await maintainTools(good.config, good.accounts, { apply: true, automatic: true }, good.dependencies);
  await rollbackManagedTool(good.config, 'codex', true, good.dependencies);
  const count = good.calls.length;
  assert.equal((await maintainTools(good.config, good.accounts, { apply: true, automatic: true }, good.dependencies))[0].status, 'failed');
  assert.equal(good.calls.length, count); assert.equal(await realpath(join(good.home, 'current')), good.release);
});

test('initializer creates only an explicitly approved private prefix without copying selected auth', async t => {
  const f = await fixture(t, { managed: false });
  await rm(f.home, { recursive: true, force: true });
  const profile = join(f.root, 'personal-profile'); await mkdir(profile);
  await writeFile(join(profile, 'auth.json'), 'local-auth-sentinel');
  f.config.accounts = [{ id: 'personal', harness: 'codex', directory: profile, profile: 'chosen-profile', executable: '/personal/codex' }];
  const original = structuredClone(f.config.accounts);
  await assert.rejects(initializeManagedTool(f.config, 'codex', false, f.dependencies), /approve/);
  const result = await initializeManagedTool(f.config, 'codex', true, f.dependencies);
  assert.equal(result.executable, f.binary); assert.deepEqual(result.managedTools.tools, ['codex']);
  assert.equal(await readFile(join(profile, 'auth.json'), 'utf8'), 'local-auth-sentinel');
  assert.deepEqual(f.config.accounts, original);
  assert.equal(await readJson(join(f.home, 'releases/2.0.0/auth.json'), null), null);
  assert.ok(f.calls.every(call => call.options.env.HOME !== profile));
  const selected = { ...f.config, managedTools: result.managedTools, accounts: [{ ...original[0], executable: result.executable }] };
  assert.equal((await managedInstallation(selected, 'codex', result.executable)).manifest.version, '2.0.0');
});

test('initializer never adopts an unmarked or redirected tool home', async t => {
  const f = await fixture(t, { managed: false });
  await rm(join(f.home, 'current'));
  await assert.rejects(initializeManagedTool(f.config, 'codex', true, f.dependencies), /unmarked/);
  assert.equal(f.calls.length, 0);
  await rm(f.home, { recursive: true, force: true });
  const external = join(f.root, 'external'); await mkdir(external);
  await symlink(external, f.home);
  await assert.rejects(initializeManagedTool(f.config, 'codex', true, f.dependencies), /redirected/);
  assert.deepEqual(await readdir(external), []);
});

test('interrupted native cutover restores prior release before discovery and remains quarantined', async t => {
  const f = await fixture(t), next = join(f.home, 'releases/2.0.0');
  await packageFiles(next, 'codex', '2.0.0');
  await rm(join(f.home, 'current')); await symlink(next, join(f.home, 'current'));
  await atomicJson(join(f.home, 'pending-update.json'), { previous: f.release, next, version: '2.0.0', previousBackup: null });
  await recoverManagedToolUpdates(f.config, f.dependencies);
  assert.equal(await realpath(join(f.home, 'current')), f.release);
  assert.equal(await readJson(join(f.home, 'pending-update.json'), null), null);
  assert.equal((await checkToolUpdates(f.config, f.accounts, f.dependencies))[0].report.status, 'failed');
});

test('worker defers busy and unacknowledged stops; idle automatic deadline survives a new worker', async t => {
  const f = await fixture(t, { latestVersion: '1.0.1' });
  f.config.accounts = f.accounts.map(value => value.binding);
  f.config.automaticUpdates = { schemaVersion: 1, enabled: true, tools: ['codex'], runner: false };
  const client = { request: async () => ({}) };
  const runner = new Runner(f.config, { client, updates: f.dependencies });
  runner.active = { run: { id: 'busy' } }; await runner.performMaintenance(); runner.active = null;
  assert.equal(await readJson(join(f.data, 'automatic-updates.json'), null), null);
  const ledger = new RunLedger(f.data), record = await ledger.claim({ id: 'prior', leaseToken: 'local' });
  await assert.rejects(runner.performMaintenance(), /Uncertain/);
  await atomicJson(ledger.path(record.id), { ...record, state: 'stopped' });
  await runner.performMaintenance(); assert.equal(f.calls.length, 0);
  await atomicJson(ledger.path(record.id), { ...record, state: 'acknowledged' });
  await atomicJson(join(f.data, 'worker.lock'), { pid: process.pid });
  await runner.performMaintenance();
  const state = await readJson(join(f.data, 'automatic-updates.json'));
  assert.equal(state.nextCheckAt - state.checkedAt, 86400000);
  assert.equal(state.updates[0].currentVersion, '1.0.1');
  const calls = f.calls.length;
  await new Runner(f.config, { client, updates: f.dependencies }).performMaintenance();
  assert.equal(f.calls.length, calls);
  assert.equal((await readJson(join(f.data, 'worker.lock'))).pid, process.pid);
});

test('heartbeat publishes only bounded update reports using unchanged status fields', async t => {
  const f = await fixture(t), sent = [];
  const runner = new Runner(f.config, { client: { request: async (op, body) => { sent.push({ op, body }); return {}; } } });
  runner.updateReports = Array.from({ length: 25 }, (_, index) => ({ component: `tool-${index}`, currentVersion: '1.0.0', availableVersion: '1.0.1', status: 'available', checkedAt: 100, message: 'Checked stable metadata' }));
  await runner.heartbeat();
  assert.equal(sent[0].op, 'heartbeat');
  assert.equal(sent[0].body.updateReports.length, 20);
  assert.deepEqual(Object.keys(sent[0].body.updateReports[0]), ['component', 'currentVersion', 'availableVersion', 'status', 'checkedAt', 'message']);
});

async function signedFixture(t, { version, protocolVersion = 1, nodeMajor = 24 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'origin-signed-update-')); t.after(() => rm(root, { recursive: true, force: true }));
  const parts = VERSION.split('.').map(Number); version ??= `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  const config = { dataDirectory: root, controller: 'https://origin.example' };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const advertised = { baseUrl: 'https://origin.example/api/execution/releases/', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
  config.updates = await pinRunnerUpdates(config, advertised);
  const previous = join(root, 'installation/releases', VERSION);
  await mkdir(join(previous, 'runner'), { recursive: true, mode: 0o700 });
  await writeFile(join(previous, 'runner/cli.mjs'), 'prior-release-sentinel');
  await symlink(previous, join(root, 'installation/current'));
  const content = '// signed fixture; injected preflight never executes this file\n';
  const manifest = { version, channel: 'stable', protocolVersion, nodeMajor, files: [{ path: 'runner/cli.mjs', sha256: hash(content), bytes: Buffer.byteLength(content) }] };
  const envelope = () => ({ manifest, signature: sign(null, Buffer.from(JSON.stringify(manifest)), privateKey).toString('base64') });
  const calls = [], preflights = []; let fail;
  const dependencies = {
    fetch: async (url, options) => {
      calls.push(String(url)); assert.equal(options.redirect, 'error');
      return new Response(String(url).endsWith('.json') ? JSON.stringify(envelope()) : content);
    },
    preflight: async path => { preflights.push(path); if (fail === 'stage' || (fail === 'switched' && !path.includes('.stage-'))) throw new Error('Signed preflight rejected'); },
  };
  return { root, config, version, previous, manifest, advertised, dependencies, calls, preflights, fail: value => { fail = value; } };
}

test('enrollment pins same-Origin Ed25519 trust and refuses different keys and foreign sources', async t => {
  const f = await signedFixture(t);
  assert.deepEqual(await pinRunnerUpdates(f.config, f.advertised), f.config.updates);
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  await assert.rejects(pinRunnerUpdates(f.config, { ...f.advertised, publicKey: other }), /trust anchor differs/);
  await assert.rejects(pinRunnerUpdates(f.config, { ...f.advertised, baseUrl: 'https://foreign.example/releases/' }), /enrolled Origin/);
  assert.equal(await readFile(f.config.updates.publicKeyFile, 'utf8'), f.advertised.publicKey);
});

test('signed latest metadata reports real incompatible releases without authorizing an apply', async t => {
  const f = await signedFixture(t, { protocolVersion: 2 });
  const plan = await checkRunnerUpdate(f.config, f.dependencies);
  assert.equal(plan.report.availableVersion, f.version); assert.equal(plan.report.status, 'available');
  assert.equal(plan.compatible, false); assert.match(plan.report.message, /explicit owner approval/);
  await assert.rejects(withMaintenanceLock(f.config, () => applyRunnerRelease(f.config, plan, { supervised: true }, f.dependencies)), /compatible stable/);
  assert.equal(f.preflights.length, 0); assert.equal(await realpath(join(f.root, 'installation/current')), f.previous);
  f.dependencies.fetch = async () => new Response(JSON.stringify({ manifest: f.manifest, signature: Buffer.alloc(64).toString('base64') }));
  await assert.rejects(checkRunnerUpdate(f.config, f.dependencies), /not signed/);
});

test('signed runner preflight failures preserve previous executable and quarantine failed versions', async t => {
  for (const failure of ['stage', 'switched']) {
    const f = await signedFixture(t); f.fail(failure);
    const plan = await checkRunnerUpdate(f.config, f.dependencies);
    await assert.rejects(withMaintenanceLock(f.config, () => applyRunnerRelease(f.config, plan, { supervised: true }, f.dependencies)), /preflight rejected/);
    assert.equal(await realpath(join(f.root, 'installation/current')), f.previous);
    assert.equal(await readFile(join(f.previous, 'runner/cli.mjs'), 'utf8'), 'prior-release-sentinel');
    const count = f.calls.length;
    await assert.rejects(withMaintenanceLock(f.config, () => applyRunnerRelease(f.config, plan, { supervised: true }, f.dependencies)), /quarantined/);
    assert.equal(f.calls.length, count);
    assert.equal((await checkRunnerUpdate(f.config, f.dependencies)).report.status, 'failed');
  }
});

test('signed runner cutover preserves old release and interrupted startup rolls back without a retry loop', async t => {
  const f = await signedFixture(t), plan = await checkRunnerUpdate(f.config, f.dependencies);
  await withMaintenanceLock(f.config, () => applyRunnerRelease(f.config, plan, { supervised: true }, f.dependencies));
  assert.equal(await realpath(join(f.root, 'installation/current')), join(f.root, 'installation/releases', f.version));
  assert.equal((await readJson(join(f.root, 'installation/rollback.json'))).previous, f.previous);
  // This test process is still the old VERSION: a mismatched startup must recover, not claim work.
  assert.equal(await beginRunnerUpdate(f.config), true);
  assert.equal(await realpath(join(f.root, 'installation/current')), f.previous);
  assert.equal(await beginRunnerUpdate(f.config), false);
  assert.equal((await checkRunnerUpdate(f.config, f.dependencies)).report.status, 'failed');
});

test('runner restart waits for acknowledged stop receipts and confirms only the actual running version', async t => {
  const f = await signedFixture(t), plan = await checkRunnerUpdate(f.config, f.dependencies);
  const ledger = new RunLedger(f.root), record = await ledger.claim({ id: 'prior-run', leaseToken: 'local' });
  await atomicJson(ledger.path(record.id), { ...record, state: 'stopped' });
  await assert.rejects(withMaintenanceLock(f.config, () => applyRunnerRelease(f.config, plan, { supervised: true }, f.dependencies)), /receipt acknowledgement/);
  assert.equal(f.preflights.length, 0);
  await atomicJson(ledger.path(record.id), { ...record, state: 'acknowledged' });
  await atomicJson(join(f.root, 'installation/pending-update.json'), { previous: f.previous, next: f.previous, version: VERSION, launches: 0 });
  assert.equal(await beginRunnerUpdate(f.config), false);
  assert.equal((await readJson(join(f.root, 'installation/pending-update.json'))).launches, 1);
  await confirmRunnerUpdate(f.config);
  assert.equal(await readJson(join(f.root, 'installation/pending-update.json'), null), null);
  await recoverRunnerUpdate(f.config);
});

test('interrupted initializer cannot be adopted and recovery deselects its unconfirmed executable', async t => {
  const f = await fixture(t);
  await atomicJson(join(f.data, 'update-quarantine.json'), { codex: { '1.0.0': { at: 1, reason: 'Initialization interrupted' } } });
  await assert.rejects(initializeManagedTool(f.config, 'codex', true, f.dependencies), /quarantined/);
  await atomicJson(join(f.home, 'pending-update.json'), { previous: null, next: f.release, version: '1.0.0' });
  await recoverManagedToolUpdates(f.config, f.dependencies);
  await assert.rejects(realpath(join(f.home, 'current')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.release, 'node_modules/@openai/codex/bin/codex.js'), 'utf8'), '#!/usr/bin/env node\n// Protocol test artifact; never executed.\n');
});

test('signed manifest does not permit corrupted release bytes to reach preflight or replace current', async t => {
  const f = await signedFixture(t), plan = await checkRunnerUpdate(f.config, f.dependencies);
  f.dependencies.fetch = async () => new Response('tampered');
  await assert.rejects(withMaintenanceLock(f.config, () => applyRunnerRelease(f.config, plan, { supervised: true }, f.dependencies)), /integrity mismatch/);
  assert.equal(f.preflights.length, 0);
  assert.equal(await realpath(join(f.root, 'installation/current')), f.previous);
});

const oversizedReports = () => Array.from({ length: 25 }, (_, index) => ({
  component: `native-${index}`, currentVersion: '1.0.0', availableVersion: '1.0.1', status: 'failed',
  checkedAt: 100, message: `host-token-sentinel ${'native stderr '.repeat(200)}`,
  manifest: { mustNotBeTransmitted: true },
}));
function assertBoundedReports(reports) {
  assert.ok(reports.length <= 20);
  for (const report of reports) {
    assert.ok(report.message.length <= 1000);
    assert.equal(report.message.includes('host-token-sentinel'), false);
    assert.equal('manifest' in report, false);
  }
}

test('long native command failures are bounded before automatic persistence and heartbeat transmission', async t => {
  const f = await fixture(t, { latestVersion: '1.0.1' });
  f.config.hostToken = 'host-token-sentinel';
  f.config.accounts = f.accounts.map(value => value.binding);
  f.config.automaticUpdates = { schemaVersion: 1, enabled: true, tools: ['codex'], runner: false };
  f.dependencies.command = async () => { throw new Error(`host-token-sentinel ${'npm stderr '.repeat(300)}`); };
  const runner = new Runner(f.config, { updates: f.dependencies, client: { request: async (op, body) => {
    if (op === 'heartbeat') assertBoundedReports(body.updateReports);
    return {};
  } } });
  await runner.performMaintenance();
  const persisted = await readJson(join(f.data, 'automatic-updates.json'));
  assert.equal(persisted.updates[0].status, 'failed');
  assertBoundedReports(persisted.updates);
  await runner.heartbeat();
  assertBoundedReports((await readJson(join(f.data, 'status.json'))).updates);
});

test('oversized persisted reports are repaired before the first startup heartbeat and maintenance replay', async t => {
  const f = await fixture(t); f.config.hostToken = 'host-token-sentinel';
  await atomicJson(join(f.data, 'automatic-updates.json'), { nextCheckAt: Date.now() + 86400000, updates: oversizedReports() });
  await atomicJson(join(f.data, 'maintenance.json'), { old: { updates: oversizedReports() } });
  let heartbeats = 0, replayed = 0, runner;
  runner = new Runner(f.config, { discover: async () => [], client: { request: async (op, body) => {
    assert.equal(op, 'heartbeat'); heartbeats++;
    assert.equal(body.updateReports.length, 20); assertBoundedReports(body.updateReports);
    runner.stopping = true;
    return {};
  } } });
  await runner.run();
  assert.equal(heartbeats, 1);
  assertBoundedReports((await readJson(join(f.data, 'automatic-updates.json'))).updates);
  const resumed = new Runner(f.config, { client: { request: async (op, body) => {
    assert.equal(op, 'maintenanceResult'); assert.equal(body.id, 'old');
    assert.equal(body.updates.length, 20); assertBoundedReports(body.updates); replayed++;
    return {};
  } } });
  resumed.collectUpdates = async () => { throw new Error('Persisted receipt must not reapply'); };
  resumed.maintenance.set('old', { op: 'applyUpdates' });
  await resumed.performMaintenance();
  assert.equal(replayed, 1); assert.equal(resumed.maintenance.size, 0);
  assertBoundedReports((await readJson(join(f.data, 'maintenance.json'))).old.updates);
});

test('new maintenance results and durable retries honor the same twenty-report batch bound', async t => {
  const f = await fixture(t); f.config.hostToken = 'host-token-sentinel';
  let collections = 0, transmissions = 0;
  const client = { request: async (op, body) => {
    assert.equal(op, 'maintenanceResult');
    assert.equal(body.updates.length, 20); assertBoundedReports(body.updates);
    if (++transmissions === 1) throw new Error('Lost acknowledgement');
    return {};
  } };
  const runner = new Runner(f.config, { client });
  runner.collectUpdates = async () => { collections++; return oversizedReports(); };
  runner.maintenance.set('batch', { op: 'applyUpdates' });
  await runner.performMaintenance();
  assert.equal(collections, 1); assert.equal(runner.maintenance.size, 1);
  assertBoundedReports((await readJson(join(f.data, 'maintenance.json'))).batch.updates);
  const restarted = new Runner(f.config, { client });
  restarted.collectUpdates = async () => { throw new Error('Must replay, never reapply'); };
  restarted.maintenance.set('batch', { op: 'applyUpdates' });
  await restarted.performMaintenance();
  assert.equal(transmissions, 2); assert.equal(restarted.maintenance.size, 0);
  assert.equal(boundedUpdateReports([{ component: 'x', status: 'not-a-status', checkedAt: -1 }])[0].status, 'unknown');
});

test('shutdown cancels signed downloads and staged preflight, releases locks and permits a clean restart', { timeout: 10000 }, async t => {
  for (const phase of ['download', 'body', 'preflight']) {
    const f = await signedFixture(t);
    f.config.automaticUpdates = { schemaVersion: 1, enabled: true, tools: [], runner: true };
    f.manifest.files.push({ ...f.manifest.files[0], path: 'runner/second.mjs' });
    const entered = Promise.withResolvers(), baseFetch = f.dependencies.fetch;
    let downloads = 0, claims = 0;
    const waitForAbort = signal => {
      assert.ok(signal instanceof AbortSignal);
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        entered.resolve();
      });
    };
    f.dependencies.fetch = async (url, options) => {
      if (String(url).endsWith('.mjs')) {
        downloads++;
        if (phase === 'download') return waitForAbort(options.signal);
        if (phase === 'body') return new Response(new ReadableStream({ start(controller) {
          options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
          entered.resolve();
        } }));
      }
      return baseFetch(url, options);
    };
    if (phase === 'preflight') f.dependencies.preflight = async (path, version, options) => {
      assert.ok(path.includes('.stage-')); return waitForAbort(options.signal);
    };
    const runner = new Runner(f.config, { discover: async () => [], updates: f.dependencies, client: { request: async op => {
      if (op === 'claim') claims++;
      return {};
    } } });
    const running = runner.run();
    await entered.promise;
    runner.stopping = true; runner.abort.abort(new Error('Owner shutdown during maintenance'));
    await running;
    assert.equal(claims, 0);
    assert.equal(downloads, phase === 'preflight' ? 2 : 1);
    assert.equal(await realpath(join(f.root, 'installation/current')), f.previous);
    assert.equal(await readJson(join(f.root, 'worker.lock'), null), null);
    assert.equal(await readJson(join(f.root, 'tool-update.lock'), null), null);
    assert.equal((await readdir(join(f.root, 'installation/releases'))).some(name => name.startsWith('.stage-')), false);
    let restarted;
    restarted = new Runner(f.config, { discover: async () => [], client: { request: async op => {
      assert.equal(op, 'heartbeat'); restarted.stopping = true; return {};
    } } });
    await restarted.run();
    assert.equal(await readJson(join(f.root, 'worker.lock'), null), null);
  }
});

test('abort after staged signed preflight cannot promote or switch the release', async t => {
  const f = await signedFixture(t), abort = new AbortController();
  const plan = await checkRunnerUpdate(f.config, f.dependencies);
  f.dependencies.signal = abort.signal;
  f.dependencies.preflight = async path => { assert.ok(path.includes('.stage-')); abort.abort(new Error('Stop before cutover')); };
  await assert.rejects(withMaintenanceLock(f.config, () => applyRunnerRelease(f.config, plan, { supervised: true }, f.dependencies)), /Stop before cutover/);
  assert.equal(await realpath(join(f.root, 'installation/current')), f.previous);
  assert.deepEqual(await readdir(join(f.root, 'installation/releases')), [VERSION]);
});

test('native npm staging observes shutdown and cannot leave maintenance locks or cut over', { timeout: 10000 }, async t => {
  const f = await fixture(t, { latestVersion: '1.0.1' }), abort = new AbortController(), entered = Promise.withResolvers();
  f.dependencies.signal = abort.signal;
  f.dependencies.command = async (file, args, options) => {
    assert.equal(file, '/fixture/npm'); assert.equal(options.signal, abort.signal);
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      entered.resolve();
    });
  };
  const applying = maintainTools(f.config, f.accounts, { apply: true, automatic: true }, f.dependencies);
  await entered.promise; abort.abort(new Error('Native maintenance shutdown'));
  await assert.rejects(applying, /Native maintenance shutdown/);
  assert.equal(await realpath(join(f.home, 'current')), f.release);
  assert.equal(await readJson(join(f.data, 'worker.lock'), null), null);
  assert.equal(await readJson(join(f.data, 'tool-update.lock'), null), null);
  assert.deepEqual(await readdir(join(f.home, 'releases')), ['1.0.0']);
});

test('account initialization rereads and commits configuration under one exclusive lock', { timeout: 10000 }, async t => {
  const f = await fixture(t), configPath = join(f.root, 'config.json');
  const piHome = join(f.data, 'tools/pi'), piRelease = join(piHome, 'releases/1.0.0');
  await packageFiles(piRelease, 'pi', '1.0.0'); await symlink(piRelease, join(piHome, 'current'));
  const initial = { ...f.config, accounts: [
    { id: 'one', harness: 'codex', executable: '/personal/codex', directory: '/personal/codex-profile', profile: 'selected-codex' },
    { id: 'two', harness: 'pi', executable: '/personal/pi', directory: '/personal/pi-profile', profile: 'selected-pi' },
  ], ownerSetting: 'preserved' };
  await atomicJson(configPath, initial);
  const staleFirst = structuredClone(initial), staleSecond = structuredClone(initial);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const first = initializeManagedAccount(staleFirst, configPath, 'codex', 'one', true, { ...f.dependencies, readConfig: async path => {
    assert.equal((await readJson(join(f.data, 'tool-update.lock'))).pid, process.pid);
    const current = await readJson(path); entered.resolve(); await release.promise; return current;
  } });
  await entered.promise;
  await assert.rejects(initializeManagedAccount(staleSecond, configPath, 'pi', 'two', true, f.dependencies), { code: 'EEXIST' });
  assert.equal((await readJson(join(f.data, 'tool-update.lock'))).pid, process.pid);
  release.resolve(); await first;
  // Retrying with the original stale snapshot must reread the first initializer's committed bindings.
  await initializeManagedAccount(staleSecond, configPath, 'pi', 'two', true, f.dependencies);
  const saved = await readJson(configPath);
  assert.equal(saved.accounts[0].executable, f.binary);
  assert.equal(saved.accounts[1].executable, join(piHome, 'current/node_modules/.bin/pi'));
  assert.deepEqual(saved.managedTools.tools, ['codex', 'pi']);
  assert.equal(saved.accounts[0].directory, initial.accounts[0].directory);
  assert.equal(saved.accounts[1].profile, initial.accounts[1].profile);
  assert.equal(saved.ownerSetting, 'preserved');
  assert.equal(await readJson(join(f.data, 'worker.lock'), null), null);
  assert.equal(await readJson(join(f.data, 'tool-update.lock'), null), null);
});
