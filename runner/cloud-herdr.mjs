#!/usr/bin/env node
// Explicit desktop action only: node cloud-herdr.mjs add /private/plan.json
// Plans come from Origin's authorized cloudHerdrConnectionPlan resolver.
// Native provider login on THIS desktop is required; no vault keys are copied.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, rm, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'origin-runner/cloud-herdr');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function validateCloudHerdrPlan(plan, now = Date.now()) {
  if (!plan || plan.schemaVersion !== 1 || !['boxd', 'boat'].includes(plan.provider) || !['nixos', 'macos'].includes(plan.desktop) || typeof plan.allocationId !== 'string' || !plan.allocationId || typeof plan.hostId !== 'string' || !plan.hostId || typeof plan.machineId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(plan.machineId) || typeof plan.machineName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(plan.machineName) || plan.core?.version !== '0.1.18' || plan.core?.session !== 'origin-cloud' || plan.core?.user !== 'origin-runner' || !Number.isSafeInteger(plan.issuedAt) || !Number.isSafeInteger(plan.expiresAt) || plan.issuedAt > now + 5000 || plan.expiresAt <= now || plan.expiresAt <= plan.issuedAt || plan.expiresAt - plan.issuedAt > 60000 || typeof plan.remotePrefix !== 'string' || !/^sudo -n -u origin-runner env -i (?:[A-Z_]+=[a-zA-Z0-9_/:.,-]+ )+bash -c$/.test(plan.remotePrefix)) throw Error('Invalid or expired Origin cloud connection plan');
  const name = `origin-${plan.provider}-${createHash('sha256').update(JSON.stringify([plan.allocationId, plan.desktop])).digest('hex').slice(0, 20)}`;
  if (plan.name !== name) throw Error('Cloud connection alias is not Origin-owned');
  return plan;
}
export function requireRunningCloudMachine(provider, id, data) {
  const machine = provider === 'boat' ? data.sandbox ?? data : data.machine ?? data;
  if (machine.id !== id || (provider === 'boat' ? !['ready', 'idle', 'running'].includes(machine.state) : machine.status !== 'running')) throw Error('Cloud machine is not confirmed running; no SSH/start/wake was attempted');
}
function nativeEnv() {
  const env = { ...process.env, BOAT_NO_UPDATE: '1', BOAT_API_URL: 'https://boat.dev/api/v1' };
  delete env.BOAT_API_KEY; delete env.BOX_API_KEY; delete env.BOXD_API_KEY;
  return env;
}
async function privateJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('Connection metadata must be an owner-only regular file');
  return JSON.parse(await readFile(path, 'utf8'));
}
function containsAlias(value, alias) {
  if (!value || typeof value !== 'object') return value === alias;
  return Object.values(value).some(child => containsAlias(child, alias));
}
async function removeOwned(path, issuedAt) {
  let saved;
  try { saved = await privateJson(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (issuedAt !== undefined && saved.issuedAt !== issuedAt) return;
  // Ownership is established before add, after checking the native registry.
  if (!saved.originOwned || dirname(path) !== root || saved.name !== `origin-${saved.provider}-${createHash('sha256').update(JSON.stringify([saved.allocationId, saved.desktop])).digest('hex').slice(0, 20)}`) throw Error('Refusing to remove an unowned machine');
  const registry = JSON.parse(execFileSync('hc', ['machine', 'ls', '--json'], { encoding: 'utf8', timeout: 10000 }));
  if (containsAlias(registry, saved.name)) execFileSync('hc', ['machine', 'rm', saved.name], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 10000 });
  await rm(path, { force: true });
}
async function via(path, shellLine) {
  const plan = validateCloudHerdrPlan(await privateJson(path));
  if (!plan.originOwned || typeof shellLine !== 'string' || !shellLine) throw Error('An owned Herdr transport command is required');
  const env = nativeEnv();
  const query = plan.provider === 'boxd' ? ['machine', 'get', plan.machineId, '--json'] : ['info', plan.machineId, '--json'];
  const data = JSON.parse(execFileSync(plan.provider, query, { env, encoding: 'utf8', timeout: Math.min(10000, plan.expiresAt - Date.now()), stdio: ['ignore', 'pipe', 'pipe'] }));
  requireRunningCloudMachine(plan.provider, plan.machineId, data);
  validateCloudHerdrPlan(plan);
  const remote = `${plan.remotePrefix} ${quote(shellLine)}`;
  // Boat resolves a fresh endpoint and host key for EVERY invocation, including
  // reconnect after resume. Never cache its IP or disable host-key checking.
  const executable = plan.provider === 'boxd' ? 'ssh' : 'boat';
  const args = plan.provider === 'boxd'
    ? ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=10', `${plan.machineName}.boxd`, remote]
    : ['ssh', plan.machineId, remote];
  const child = spawn(executable, args, { env, stdio: 'inherit', detached: true });
  const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  // Only a new Origin-authorized plan can extend the local transport lease.
  // Reading this private local file never touches or extends a provider VM.
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const renewed = validateCloudHerdrPlan(await privateJson(path));
      if (!renewed.originOwned || renewed.name !== plan.name || renewed.machineId !== plan.machineId || renewed.hostId !== plan.hostId || renewed.remotePrefix !== plan.remotePrefix) stop();
    } catch { stop(); }
    finally { checking = false; }
  }, 250);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => { process.exitCode = code ?? 1; resolveExit(); }); });
  clearInterval(timer);
}
async function main() {
  const [action, input, shellLine] = process.argv.slice(2);
  if (!input || !['add', 'refresh', 'remove', 'via', 'expire'].includes(action)) throw Error('Usage: cloud-herdr.mjs add PLAN | refresh PLAN | remove OWNED_PLAN');
  if (action === 'via') return via(resolve(input), shellLine);
  if (action === 'remove') return removeOwned(resolve(input));
  if (action === 'expire') {
    const plan = await privateJson(input);
    await new Promise(done => setTimeout(done, Math.max(1, plan.expiresAt - Date.now())));
    return removeOwned(resolve(input), plan.issuedAt);
  }
  const plan = validateCloudHerdrPlan(await privateJson(resolve(input)));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${plan.name}.json`);
  if (action === 'refresh') {
    const previous = validateCloudHerdrPlan(await privateJson(path));
    if (!previous.originOwned || previous.name !== plan.name || previous.machineId !== plan.machineId || previous.hostId !== plan.hostId || previous.remotePrefix !== plan.remotePrefix || plan.issuedAt <= previous.issuedAt) throw Error('Cannot refresh an unowned, replaced or expired connection');
    const stage = `${path}.${process.pid}`;
    try {
      await writeFile(stage, JSON.stringify({ ...plan, originOwned: true }), { mode: 0o600, flag: 'wx' });
      await rename(stage, path);
    } finally { await rm(stage, { force: true }); }
    const watchdog = spawn(process.execPath, [self, 'expire', path], { detached: true, stdio: 'ignore' });
    watchdog.unref();
    console.log(JSON.stringify({ name: plan.name, expiresAt: plan.expiresAt, ownedPlan: path }));
    return;
  }
  const registry = JSON.parse(execFileSync('hc', ['machine', 'ls', '--json'], { encoding: 'utf8', timeout: 10000 }));
  if (containsAlias(registry, plan.name)) throw Error('Alias already exists; remove the previous Origin-owned connection explicitly before adding another');
  await writeFile(path, JSON.stringify({ ...plan, originOwned: true }), { mode: 0o600, flag: 'wx' });
  // Independent expiry survives the initiating shell. --temp alone does not.
  const watchdog = spawn(process.execPath, [self, 'expire', path], { detached: true, stdio: 'ignore' });
  watchdog.unref();
  try {
    const viaCommand = [process.execPath, self, 'via', path].map(quote).join(' ');
    execFileSync('hc', ['machine', 'add', '--name', plan.name, '--temp', '--session', plan.core.session, '--via', viaCommand], { stdio: ['ignore', 'inherit', 'inherit'], timeout: Math.max(1, plan.expiresAt - Date.now()) });
    console.log(JSON.stringify({ name: plan.name, expiresAt: plan.expiresAt, ownedPlan: path }));
  } catch (error) { await removeOwned(path); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === self) main().catch(() => { console.error('Cloud Herdr connection unavailable. Check the private plan, local native provider login, verified SSH host key and nonroot worker setup. No provider was switched or started.'); process.exitCode = 1; });
