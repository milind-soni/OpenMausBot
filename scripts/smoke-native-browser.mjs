import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { buildNativeBrowserSmoke } from './build-native-browser-smoke.mjs';

const executable = process.env.OMB_ELECTRON_PATH;
if (!executable || !/^electron(?:\.exe)?$/i.test(basename(executable))) throw Error('Set OMB_ELECTRON_PATH to an explicit Electron development binary.');
const directory = await mkdtemp(join(process.env.OMB_NATIVE_TEST_TMP ?? tmpdir(), 'omb-native-browser-'));
const application = join(directory, 'app');
const home = join(directory, 'home');
const output = join(directory, 'result.json');
const worker = join(directory, 'worker.mjs');
await mkdir(application); await mkdir(home);
await writeFile(join(application, 'package.json'), JSON.stringify({ name: 'omb-native-browser-smoke', type: 'module', main: 'main.mjs' }));
await writeFile(join(application, 'main.mjs'), `import ${JSON.stringify(new URL('../electron/testing/native-browser-smoke.mjs', import.meta.url).href)};`);
await buildNativeBrowserSmoke(worker);
const env = { ...process.env, OMB_NATIVE_SMOKE_HOME: home, OMB_NATIVE_SMOKE_OUTPUT: output, OMB_NATIVE_SMOKE_WORKER: worker };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(resolve(executable), [application], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
const timer = setTimeout(() => child.kill(), 135_000);
const interrupt = () => child.kill();
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await writeFile(join(directory, 'electron.log'), log);
  const result = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(code, 0, result.error ?? log);
  assert.equal(result.pass, true, result.error);
  console.log(JSON.stringify({ checks: result.checks, electron: result.electron, chromium: result.chromium, evidence: directory }, null, 2));
} finally {
  clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  if (child.exitCode === null) child.kill();
}
