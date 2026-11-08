import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { ManagedProcess, command } from '../process.mjs';
import { Workspace, temporaryEnvironment } from '../git.mjs';
import { Redactor, RunError, sleep, baseEnvironment, readJson } from '../security.mjs';
import { Runner } from '../worker.mjs';

async function fixture(t, name) {
  const root = await mkdtemp(join(tmpdir(), `origin-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function processAlive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') { const value = await readFile(`/proc/${pid}/stat`, 'utf8'); return value.slice(value.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'; }
    return true;
  } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return false; throw error; }
}

test('cancellation stops the leader and subprocess tree before stopped receipt', async t => {
  const root = await fixture(t, 'process');
  const childFile = join(root, 'child.mjs');
  await writeFile(childFile, `import { spawn } from 'node:child_process';\nconst child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });\nconsole.log(child.pid);\nprocess.on('SIGTERM',()=>{});\nsetInterval(()=>{},1000);\n`);
  const abort = new AbortController();
  const child = new ManagedProcess(process.execPath, [childFile], { signal: abort.signal });
  t.after(() => child.stop());
  const [data] = await once(child.child.stdout, 'data'); const descendant = Number(data.toString().trim());
  assert.ok(await processAlive(descendant));
  abort.abort(new RunError('cancelled', 'lease invalid'));
  assert.deepEqual(await child.stop(30), { processStopped: true });
  assert.equal(await processAlive(child.pid), false); assert.equal(await processAlive(descendant), false);
});

test('guardian kills a subprocess tree when its worker crashes', async t => {
  const root = await fixture(t, 'crash');
  const worker = join(root, 'worker.mjs');
  const processModule = new URL('../process.mjs', import.meta.url).href;
  await writeFile(worker, `import { ManagedProcess } from ${JSON.stringify(processModule)};\nconst child = new ManagedProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)']);\nconsole.log(child.pid);\nsetTimeout(()=>process.exit(9),300);\n`);
  const parent = new ManagedProcess(process.execPath, [worker]); t.after(() => parent.stop());
  const [data] = await once(parent.child.stdout, 'data'); const child = Number(data.toString().trim());
  await parent.exit;
  for (let i = 0; i < 40 && await processAlive(child); i++) await sleep(100);
  assert.equal(await processAlive(child), false);
});

test('guardian startup is independent of parent Node execution flags', async () => {
  const processModule = new URL('../process.mjs', import.meta.url).href;
  const script = `import { ManagedProcess } from ${JSON.stringify(processModule)}; const child = new ManagedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)']); const receipt = await child.stop(); console.log(JSON.stringify({pid:child.pid,...receipt}));`;
  const result = await command(process.execPath, ['--input-type=module', '-e', script], { timeoutMs: 15000 });
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.processStopped, true);
  assert.equal(await processAlive(receipt.pid), false);
});

async function repository(root) {
  const source = join(root, 'personal'); await mkdir(source);
  const env = baseEnvironment({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
  const git = args => command('git', args, { cwd: source, env });
  await git(['init', '-b', 'main']); await writeFile(join(source, 'app.txt'), 'base\n'); await git(['add', '.']); await git(['commit', '-m', 'base']);
  return { source, git, sha: (await git(['rev-parse', 'HEAD'])).stdout.trim() };
}

test('worktrees isolate personal checkout, checkpoint and push the exact verified head', async t => {
  const root = await fixture(t, 'worktree'); const repo = await repository(root);
  const run = { id: 'task-one', repositoryUrl: repo.source, baseBranch: 'main', branch: 'origin/run-one', environmentVariables: { SCOPED_SERVICE_SECRET: 'secret-only-in-temporary-environment' }, verificationCommands: ["test -f app.txt"], smokeCommand: "test -s app.txt", timeoutSeconds: 30 };
  const temporary = await temporaryEnvironment(join(root, 'runner'), run); t.after(() => temporary.dispose());
  assert.equal((await stat(temporary.environmentFile)).mode & 0o777, 0o600);
  const workspace = new Workspace(join(root, 'runner'), run, temporary, { allowLocal: true }); await workspace.prepare();
  await writeFile(join(workspace.path, 'app.txt'), 'implemented\n');
  assert.equal(await readFile(join(repo.source, 'app.txt'), 'utf8'), 'base\n');
  const redactor = new Redactor(Object.values(run.environmentVariables));
  const checkpoint = await workspace.checkpoint('test checkpoint', redactor, { push: false });
  assert.notEqual(checkpoint.sha, repo.sha);
  assert.deepEqual((await workspace.verify(redactor)).map(result => result.exitCode), [0, 0]);
  const pushed = await workspace.checkpoint('verified', redactor);
  assert.equal(pushed.sha, checkpoint.sha);
  assert.equal((await repo.git(['rev-parse', run.branch])).stdout.trim(), pushed.sha);
  assert.equal((await repo.git(['rev-parse', 'main'])).stdout.trim(), repo.sha);
  const second = new Workspace(join(root, 'runner'), { ...run, id: 'task-two', branch: 'origin/run-two' }, temporary, { allowLocal: true });
  await second.prepare(); assert.notEqual(second.path, workspace.path); assert.equal(await readFile(join(second.path, 'app.txt'), 'utf8'), 'base\n');
});

test('secret-containing git objects never push, even if harness committed them earlier', async t => {
  const root = await fixture(t, 'secret-object'); const repo = await repository(root);
  const run = { id: 'secret', repositoryUrl: repo.source, baseBranch: 'main', branch: 'origin/secret', environmentVariables: {} };
  const temporary = await temporaryEnvironment(join(root, 'runner'), run); t.after(() => temporary.dispose());
  const workspace = new Workspace(join(root, 'runner'), run, temporary, { allowLocal: true }); await workspace.prepare();
  await writeFile(join(workspace.path, 'leak.txt'), 'secret-value-never-push');
  await workspace.git(['add', '.']); await workspace.git(['commit', '-m', 'harness commit']);
  await rm(join(workspace.path, 'leak.txt')); await workspace.git(['add', '.']); await workspace.git(['commit', '-m', 'delete leak']);
  await assert.rejects(workspace.checkpoint('checkpoint', new Redactor(['secret-value-never-push'])), /possible secret/);
  const remote = await repo.git(['ls-remote', '--heads', repo.source, run.branch]); assert.equal(remote.stdout, '');
});

function testRun(overrides = {}) {
  return { id: 'run', leaseToken: 'lease', projectId: 'project', taskId: 'task', repositoryUrl: 'https://github.com/example/private', baseBranch: 'main', branch: 'origin/run', environment: 'test', environmentVariables: {}, prompt: 'Do work', selection: { accountId: 'local', harness: 'codex', model: 'exact' }, billingKind: 'subscription', verificationCommands: ['test'], smokeCommand: 'smoke', timeoutSeconds: 30, permissionMode: 'ask', gitCredential: { username: 'x-access-token', token: 'scoped', expiresAt: Date.now() + 3600000 }, ...overrides };
}
function fakeWorkspace(root, run) {
  this.path = join(root, 'isolated'); this.run = run;
  this.prepare = () => mkdir(this.path, { recursive: true });
  this.checkpoint = async () => ({ sha: 'a'.repeat(40), branch: run.branch, summary: 'checkpoint' });
  this.verify = async () => [{ kind: 'test', command: 'test', exitCode: 0 }, { kind: 'smoke', command: 'smoke', exitCode: 0 }];
  this.git = async args => ({ stdout: args[0] === 'status' ? '' : 'a'.repeat(40) });
}
const account = { binding: { id: 'local', harness: 'codex' }, report: { id: 'local', identityHash: 'account-fingerprint', provider: 'openai', authenticated: true, authKind: 'subscription', models: [{ id: 'exact' }], quota: { status: 'unknown', observedAt: 0, windows: [] } } };

test('lease rejection stops actual child before finished and never re-executes duplicate run', async t => {
  const root = await fixture(t, 'lease'); let child; let models = 0; const events = [];
  const client = { request: async (op, input) => {
    if (op === 'control') { if (child) return { leaseValid: false }; return { leaseValid: true, leaseDurationSeconds: 0.1, messages: [], approvals: [] }; }
    if (op === 'event') { if (input.event.type === 'finished') assert.equal(await processAlive(child.pid), false); events.push(input.event); return { accepted: true }; }
    return {};
  } };
  const runner = new Runner({ dataDirectory: root, hostToken: 'private', hostId: 'host' }, { client, discover: async () => [account], Workspace: fakeWorkspace,
    startHarness: async context => {
      models++; child = new ManagedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: context.signal });
      return { stop: () => child.stop(20), message: async () => {}, done: child.exit.then(() => { throw context.signal.reason ?? new Error('unexpected exit'); }) };
    },
  });
  runner.accounts = [account]; await runner.execute(testRun());
  const finished = events.find(value => value.type === 'finished');
  assert.equal(finished.result, 'cancelled'); assert.equal(finished.processStopped, true); assert.equal(finished.checkpointSha, undefined);
  await assert.rejects(runner.execute(testRun()), /Duplicate/); assert.equal(models, 1);
});

test('denied approval is needs_approval, not quota or a successful harness assertion', async t => {
  const root = await fixture(t, 'approval'); const events = [];
  const client = { request: async (op, input) => { if (op === 'control') return { leaseValid: true, messages: [], approvals: [] }; if (op === 'event') { events.push(input.event); return { accepted: true }; } return {}; } };
  const runner = new Runner({ dataDirectory: root, hostToken: 'private', hostId: 'host' }, { client, discover: async () => [account], Workspace: fakeWorkspace,
    startHarness: async context => {
      const done = (async () => {
        const answer = context.approve('Bash', { command: 'dangerous action' });
        while (!runner.active.approvals.size) await sleep(1);
        [...runner.active.approvals.values()][0](false);
        assert.equal(await answer, false); throw context.signal.reason;
      })();
      return { done, stop: async () => ({ processStopped: true }), message: async () => {} };
    },
  }); runner.accounts = [account]; await runner.execute(testRun());
  assert.equal(events.find(value => value.type === 'finished').result, 'needs_approval');
  assert.ok(events.some(value => value.type === 'approval'));
});

test('partial-work quota handoff includes only a pushed checkpoint and activity evidence', async t => {
  const root = await fixture(t, 'quota'); const events = [];
  const runner = new Runner({ dataDirectory: root, hostToken: 'private', hostId: 'host' }, { client: { request: async (op, input) => { if (op === 'control') return { leaseValid: true, messages: [], approvals: [] }; if (op === 'event') { events.push(input.event); return { accepted: true }; } } }, discover: async () => [account], Workspace: fakeWorkspace,
    startHarness: async () => ({ done: Promise.reject(new RunError('quota', 'native confirmed exhaustion')), stop: async () => ({ processStopped: true }), message: async () => {} }),
  }); runner.accounts = [account]; await runner.execute(testRun());
  const result = events.find(value => value.type === 'finished'); assert.equal(result.result, 'quota'); assert.equal(result.activityStarted, true); assert.equal(result.checkpointSha, 'a'.repeat(40));
  assert.equal((await readJson(runner.ledger.path('run'))).state, 'acknowledged');
});

test('durable controls deduplicate messages and approvals and replace refreshed git binding', { timeout: 10000 }, async t => {
  const root = await fixture(t, 'controls'); const messages = [], requests = [];
  let finish, approvalId;
  const done = new Promise(resolve => { finish = resolve; });
  const client = { request: async (op, input) => {
    if (op === 'control') {
      requests.push(input);
      return { leaseValid: true, messages: [{ id: 'message-one', text: 'Only once' }], approvals: approvalId ? [{ approvalId, decision: 'allow' }] : [], gitCredential: { username: 'installation', token: 'refreshed-repository-secret', expiresAt: Date.now() + 3600000 } };
    }
    if (op === 'event') return { accepted: true };
    return {};
  } };
  const runner = new Runner({ dataDirectory: root, hostToken: 'private', hostId: 'host' }, { client, discover: async () => [account], Workspace: fakeWorkspace,
    startHarness: async () => ({ done, stop: async () => {}, message: async text => { messages.push(text); } }),
  });
  runner.accounts = [account]; const execution = runner.execute(testRun());
  while (!runner.active?.handle) await sleep(1);
  const active = runner.active;
  const answer = runner.approve(active, active.journal.redactor, 'Bash', { command: 'test' });
  while (!active.approvals.size) await sleep(1);
  approvalId = [...active.approvals.keys()][0];
  await Promise.all([runner.control(active), runner.control(active)]);
  assert.equal(await answer, true);
  assert.deepEqual(messages, ['Only once']);
  assert.ok(requests.at(-1).ackMessageIds.includes('message-one'));
  assert.ok(requests.at(-1).ackApprovalIds.includes(approvalId));
  assert.equal(active.temporary.gitEnv.ORIGIN_GIT_TOKEN, 'refreshed-repository-secret');
  assert.equal(active.journal.redactor.text('refreshed-repository-secret'), '[REDACTED]');
  finish({ summary: 'Done' }); await execution;
});

test('429 refresh failures, missing/stale quotas and other-model limits never mean exhaustion', { timeout: 15000 }, async t => {
  for (const kind of ['unavailable', 'unknown', 'stale', 'other-model', 'exhausted']) {
    const root = await fixture(t, `quota-${kind}`); const events = []; let reads = 0;
    const selected = { ...account, report: { ...account.report, quota: { status: 'unknown', observedAt: Date.now(), windows: [] } } };
    const discover = async () => {
      if (++reads === 1) return [selected];
      if (kind === 'unavailable') throw new Error('native telemetry transport failed');
      return [{ ...selected, report: { ...selected.report, quota: { status: kind === 'unknown' ? 'unknown' : 'available', observedAt: Date.now() - (kind === 'stale' ? 300000 : 0), windows: [{ scope: kind === 'other-model' ? 'model' : 'account', modelIds: ['different-model'], usedPercent: 100, resetsAt: Date.now() + 3600000 }] } } }];
    };
    const runner = new Runner({ dataDirectory: root, hostToken: 'private', hostId: 'host' }, {
      client: { request: async (op, input) => { if (op === 'control') return { leaseValid: true }; if (op === 'event') { events.push(input.event); return { accepted: true }; } return {}; } },
      discover, Workspace: fakeWorkspace,
      startHarness: async () => ({ done: Promise.reject(Object.assign(new RunError('failed', 'rate limited'), { httpStatus: 429 })), stop: async () => {}, message: async () => {} }),
    });
    runner.accounts = [selected]; await runner.execute(testRun());
    assert.equal(events.find(event => event.type === 'finished').result, kind === 'exhausted' ? 'quota' : 'failed', kind);
  }
});

test('partially created temporary credentials are removed before propagating setup failure', async t => {
  const root = await fixture(t, 'partial-environment'); let reads = 0;
  const run = { environmentVariables: { DATABASE_URL: 'private-environment-value' }, get gitCredential() { if (++reads === 2) throw new Error('injected credential binding failure'); return {}; } };
  await assert.rejects(temporaryEnvironment(root, run), /injected/);
  assert.deepEqual(await readdir(join(root, 'temporary')), []);
});

test('finished stopped proof is sent only after process stop and temporary cleanup', async t => {
  const root = await fixture(t, 'terminal-cleanup'); let stopped = false, finished = false;
  const client = { request: async (op, input) => {
    if (op === 'control') return { leaseValid: true };
    if (op === 'event' && input.event.type === 'finished') {
      assert.equal(stopped, true); assert.deepEqual(await readdir(join(root, 'temporary')), []);
      assert.equal(input.event.processStopped, true); finished = true;
    }
    return { accepted: true };
  } };
  const runner = new Runner({ dataDirectory: root, hostToken: 'private', hostId: 'host' }, { client, discover: async () => [account], Workspace: fakeWorkspace,
    startHarness: async () => ({ done: Promise.resolve({ summary: 'Done' }), stop: async () => { stopped = true; }, message: async () => {} }),
  });
  runner.accounts = [account]; await runner.execute(testRun()); assert.equal(finished, true);
});

test('failed process-tree stop never emits a stopped receipt', async t => {
  const root = await fixture(t, 'unproven-stop'); const events = [];
  const runner = new Runner({ dataDirectory: root, hostToken: 'private', hostId: 'host' }, {
    client: { request: async (op, input) => { if (op === 'control') return { leaseValid: true }; if (op === 'event') events.push(input.event); return { accepted: true }; } },
    discover: async () => [account], Workspace: fakeWorkspace,
    startHarness: async () => ({ done: Promise.resolve({ summary: 'Done' }), stop: async () => { throw new Error('Cannot prove subprocess tree stopped'); }, message: async () => {} }),
  });
  runner.accounts = [account]; await assert.rejects(runner.execute(testRun()), /Cannot prove/);
  assert.equal(events.some(event => event.type === 'finished'), false);
  assert.deepEqual(await readdir(join(root, 'temporary')), []);
});

test('unproven auxiliary-process stop fences the daemon without another claim or receipt', async t => {
  for (const phase of ['startup', 'verification', 'checkpoint', 'quota-refresh']) {
    const root = await fixture(t, `stop-${phase}`); const events = []; let claims = 0, reads = 0;
    const unproven = () => Object.assign(new Error('Unproven process-tree stop'), { processStopUnproven: true });
    function WorkspaceFixture(root, run) {
      fakeWorkspace.call(this, root, run);
      if (phase === 'verification') this.verify = async () => { throw unproven(); };
      if (phase === 'checkpoint') this.checkpoint = async () => { throw unproven(); };
    }
    const runner = new Runner({ dataDirectory: root, hostToken: 'private', hostId: 'host' }, {
      client: { request: async (op, input) => {
        if (op === 'claim') { claims++; return { run: testRun() }; }
        if (op === 'control') return { leaseValid: true };
        if (op === 'event') events.push(input.event);
        return { accepted: true };
      } },
      discover: async () => { if (++reads > 2 && phase === 'quota-refresh') throw unproven(); return [account]; },
      Workspace: WorkspaceFixture,
      startHarness: async () => {
        if (phase === 'startup') throw unproven();
        const done = ['checkpoint', 'quota-refresh'].includes(phase) ? Promise.reject(Object.assign(new RunError('failed', 'Native rejection'), { httpStatus: 429 })) : Promise.resolve({ summary: 'Done' });
        return { done, stop: async () => {}, message: async () => {} };
      },
    });
    await assert.rejects(runner.run(), /Unproven/);
    assert.equal(claims, 1, phase); assert.equal(events.some(event => event.type === 'finished'), false, phase);
    assert.deepEqual(await readdir(join(root, 'temporary')), []);
  }
});
