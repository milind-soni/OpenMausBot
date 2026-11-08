import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, link, symlink, unlink, readFile, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { serviceDefinition } from '../service.mjs';

const execute = promisify(execFile);
test('installed runner remains operable after a package manager replaces versioned Node', { timeout: 30000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'origin-node-upgrade-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'bin'), previous = join(home, 'node-old'), next = join(home, 'node-new');
  await mkdir(bin);
  await copyFile(process.execPath, previous, constants.COPYFILE_FICLONE);
  await link(previous, next);
  await symlink(previous, join(bin, 'node'));
  const env = { HOME: home, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
  await mkdir(join(home, '.config/origin-runner'), { recursive: true, mode: 0o700 });
  await writeFile(join(home, '.config/origin-runner/config.json'), JSON.stringify({ controller: 'https://origin.example.test', hostId: 'fixture-host', hostToken: 'test-only-token' }), { mode: 0o600 });
  await execute(previous, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'install', '--files-only'], { env });
  await unlink(join(bin, 'node'));
  await symlink(next, join(bin, 'node'));
  await unlink(previous);
  const command = join(home, '.local/bin/origin-runner');
  const state = join(home, '.local/share/origin-runner/control.json');
  await execute(command, ['pause'], { env });
  assert.equal(JSON.parse(await readFile(state, 'utf8')).paused, true);
  await execute(command, ['resume'], { env });
  assert.equal(JSON.parse(await readFile(state, 'utf8')).paused, false);
});

test('systemd accepts the generated service with spaces and literal specifiers in its working directory', { skip: process.platform !== 'linux' }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'origin-service-parse-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataDirectory = join(home, 'state with % literal');
  await mkdir(dataDirectory);
  const unit = serviceDefinition({
    platform: 'linux', node: process.execPath,
    launcher: fileURLToPath(new URL('../cli.mjs', import.meta.url)),
    config: join(home, 'config.json'), dataDirectory, path: process.env.PATH ?? '/usr/bin:/bin',
  });
  const filename = join(home, 'origin-parser-test.service');
  await writeFile(filename, unit.content);
  const parsed = spawnSync('systemd-analyze', ['--user', 'verify', filename], { encoding: 'utf8', timeout: 15000 });
  if (parsed.error?.code === 'ENOENT') return t.skip('systemd-analyze is not installed on this host');
  assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
});
