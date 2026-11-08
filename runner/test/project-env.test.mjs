import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { command } from '../process.mjs';
import { temporaryEnvironment, Workspace } from '../git.mjs';
import { baseEnvironment, Redactor } from '../security.mjs';

const launcher = fileURLToPath(new URL('../project-env.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'origin-project-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const variables = { OPENAI_API_KEY: 'scoped-application-openai', ANTHROPIC_API_KEY: 'scoped-application-anthropic', GEMINI_API_KEY: 'scoped-application-gemini', NODE_ENV: 'test' };

test('application launcher supplies project provider keys without inherited controller or native auth overrides', async t => {
  const root = await fixture(t), temporary = await temporaryEnvironment(root, { environmentVariables: variables });
  const script = 'console.log(JSON.stringify({openai:process.env.OPENAI_API_KEY,anthropic:process.env.ANTHROPIC_API_KEY,gemini:process.env.GEMINI_API_KEY,controller:process.env.ORIGIN_HOST_TOKEN??null,codexHome:process.env.CODEX_HOME??null}))';
  const result = await command(process.execPath, [launcher, '--file', temporary.environmentFile, '--', process.execPath, '-e', script], { env: baseEnvironment({ ORIGIN_HOST_TOKEN: 'never-inherited-controller', OPENAI_API_KEY: 'ambient-native-key', CODEX_HOME: '/native/profile' }), timeoutMs: 10000 });
  assert.deepEqual(JSON.parse(result.stdout), { openai: variables.OPENAI_API_KEY, anthropic: variables.ANTHROPIC_API_KEY, gemini: variables.GEMINI_API_KEY, controller: null, codexHome: null });
  assert.equal((await stat(temporary.environmentFile)).mode & 0o077, 0);
  await temporary.dispose(); await assert.rejects(stat(temporary.environmentFile), { code: 'ENOENT' });
});

test('configured verification and smoke receive project keys directly, outside the checkout', async t => {
  const root = await fixture(t), temporary = await temporaryEnvironment(root, { environmentVariables: variables });
  const verify = `${JSON.stringify(process.execPath)} -e 'if (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY) process.exit(9)'`;
  const smoke = `${JSON.stringify(process.execPath)} -e 'if (!process.env.GEMINI_API_KEY) process.exit(9)'`;
  const workspace = new Workspace(root, { id: 'run', repositoryUrl: 'https://github.com/example/private', verificationCommands: [verify], smokeCommand: smoke, timeoutSeconds: 10 }, temporary);
  await mkdir(workspace.path, { recursive: true });
  assert.equal(temporary.environmentFile.startsWith(`${workspace.path}/`), false);
  const results = await workspace.verify(new Redactor(Object.values(variables)));
  assert.deepEqual(results.map(value => value.exitCode), [0, 0]); await temporary.dispose();
});

test('bad permissions, malformed files and reserved injection variables fail without logging secret contents', async t => {
  const root = await fixture(t), file = join(root, 'environment.json');
  for (const content of ['not-json-secret-value', JSON.stringify({ NODE_OPTIONS: '--import=secret-value' }), JSON.stringify(variables)]) {
    await writeFile(file, content, { mode: 0o600 });
    if (content === JSON.stringify(variables)) await chmod(file, 0o644);
    const result = await command(process.execPath, [launcher, '--file', file, '--', process.execPath, '-e', 'throw new Error("must not launch")'], { timeoutMs: 10000, allowFailure: true });
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /not-json-secret|--import=secret|scoped-application|must not launch/);
  }
});

test('application exit status propagates without inventing a successful command', async t => {
  const root = await fixture(t), temporary = await temporaryEnvironment(root, { environmentVariables: variables });
  const result = await command(process.execPath, [launcher, '--file', temporary.environmentFile, '--', process.execPath, '-e', 'process.exit(7)'], { timeoutMs: 10000, allowFailure: true });
  assert.equal(result.code, 7); await temporary.dispose();
});
