import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson } from './security.mjs';
import { validateCloudHerdrPlan } from './cloud-herdr.mjs';

const helper = fileURLToPath(new URL('./cloud-herdr.mjs', import.meta.url));
const aliasPattern = /^origin-(boxd|boat)-[a-f0-9]{20}\.json$/;
const unavailable = 'Herdr is unavailable. Install the native hc client; no model or provider was started.';
const needsAuth = 'Cloud connection unavailable. Check local native provider login, verified SSH host key and Herdr setup. No provider was switched or started.';

// Never relay CLI output (which can include native account details) to Origin.
function nativeCommand(executable, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, BOAT_NO_UPDATE: '1', BOAT_API_URL: 'https://boat.dev/api/v1' };
    delete env.BOAT_API_KEY; delete env.BOX_API_KEY; delete env.BOXD_API_KEY;
    const child = spawn(executable, args, { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', failed = false;
    const kill = () => { failed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(kill, 20000);
    child.stdout.on('data', chunk => { if (output.length + chunk.length > 32768) kill(); else output += chunk; });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Native command unavailable')); });
    child.once('close', code => { clearTimeout(timer); if (code !== 0 || failed) reject(new Error('Native command unavailable')); else resolve(output); });
  });
}

function safePlan(value) {
  if (!value || JSON.stringify(value).length > 16384) throw new Error('Invalid connection plan');
  const { schemaVersion, allocationId, hostId, provider, desktop, machineId, machineName, name, issuedAt, expiresAt, remotePrefix } = value;
  const core = { version: value.core?.version, session: value.core?.session, user: value.core?.user };
  return validateCloudHerdrPlan({ schemaVersion, allocationId, hostId, provider, desktop, machineId, machineName, name, issuedAt, expiresAt, remotePrefix, core });
}

export class HerdrConnections {
  constructor(config, { command = nativeCommand, stateRoot = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'origin-runner/cloud-herdr') } = {}) {
    this.config = config;
    this.command = command;
    this.root = stateRoot;
    this.inputRoot = join(config.dataDirectory, 'herdr-plans');
    this.pending = null;
    this.running = null;
    this.stopped = false;
    this.observation = {};
  }
  report() {
    const enabled = this.config.herdr?.enabled === true;
    return { enabled, cloudConnections: enabled && this.config.herdr?.cloudConnections === true, ...(enabled ? this.observation : {}) };
  }
  schedule(plans) {
    if (this.stopped) return;
    const report = this.report();
    const desired = new Map();
    if (report.cloudConnections && ['nixos', 'mac'].includes(this.config.kind) && Array.isArray(plans)) {
      for (const value of plans.slice(0, 32)) {
        try {
          const plan = safePlan(value);
          if (plan.desktop === (this.config.kind === 'mac' ? 'macos' : 'nixos')) desired.set(plan.name, plan);
        } catch { /* Invalid/expired input is a revocation, never a native command. */ }
      }
    }
    // Only one pending snapshot exists; a slow native login cannot grow a queue.
    this.pending = desired;
    this.start();
  }
  start() {
    if (this.running) return;
    this.running = Promise.resolve().then(async () => {
      while (this.pending !== null) {
        const desired = this.pending;
        this.pending = null;
        try { await this.reconcile(desired); }
        catch { this.observation = { status: 'unavailable', message: unavailable }; }
      }
    }).finally(() => { this.running = null; if (this.pending !== null) this.start(); });
  }
  async owned() {
    let names;
    try { names = await readdir(this.root); } catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
    const result = new Map();
    for (const name of names.filter(name => aliasPattern.test(name)).slice(0, 64)) {
      const path = join(this.root, name);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16384 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) continue;
        const plan = JSON.parse(await readFile(path, 'utf8'));
        if (plan.originOwned === true && `${plan.name}.json` === name) result.set(plan.name, plan);
      } catch { /* The cloud helper independently checks ownership before removal. */ }
    }
    return result;
  }
  async remove(name) {
    try { await this.command(process.execPath, [helper, 'remove', join(this.root, `${name}.json`)]); }
    catch { this.observation = { status: 'needs_auth', message: needsAuth }; }
  }
  async reconcile(desired) {
    const owned = await this.owned();
    for (const name of owned.keys()) if (!desired.has(name)) await this.remove(name);
    if (this.stopped || !this.report().enabled) return;
    if (!this.observation.version) {
      try {
        const version = (await this.command('hc', ['--version'])).trim();
        if (version.length > 123 || !/^hc \d+\.\d+\.\d+$/.test(version)) throw new Error('Unsupported native version');
        this.observation = { version: version.slice(3), status: 'ready' };
      } catch { this.observation = { status: 'unavailable', message: unavailable }; return; }
    }
    for (const [name, plan] of desired) {
      if (this.pending !== null || this.stopped) break;
      const input = join(this.inputRoot, `${name}.json`);
      try {
        validateCloudHerdrPlan(plan);
        await mkdir(this.inputRoot, { recursive: true, mode: 0o700 });
        const previous = owned.get(name);
        let refresh = false;
        if (previous) {
          try {
            validateCloudHerdrPlan(previous);
            refresh = previous.machineId === plan.machineId && previous.hostId === plan.hostId && previous.remotePrefix === plan.remotePrefix;
          } catch {}
          if (refresh && previous.issuedAt >= plan.issuedAt) continue;
          if (!refresh) await this.remove(name);
        }
        await atomicJson(input, plan);
        await this.command(process.execPath, [helper, refresh ? 'refresh' : 'add', input]);
        this.observation = { version: this.observation.version, status: 'ready' };
      } catch { this.observation = { version: this.observation.version, status: 'needs_auth', message: needsAuth }; }
      finally { await rm(input, { force: true }).catch(() => {}); }
    }
  }
  async stop() {
    this.stopped = true;
    this.pending = new Map();
    this.start();
    while (this.running) await this.running;
  }
}
