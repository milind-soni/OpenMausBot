import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { lstat, mkdir, chmod, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from './security.mjs';
import { command } from './process.mjs';
import { requireRunningCloudMachine } from './cloud-herdr.mjs';
import { rexCommand, rexEnvironment, rexStatus, REX_VERSION, REX_SOCKET } from './rex.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const alias = /^origin-rex-(boxd|boat)-[a-f0-9]{20}$/;
const unavailable = 'Rex unavailable: install the pinned 0.1.0-preview.13 client and start the configured private Unix-socket server explicitly. No server or model was started.';
const needsAuth = 'Rex cloud connection unavailable: local native Boxd/Boat login, verified SSH host key, nonroot origin-runner and its private Rex socket are required. No machine was started or provider changed.';
export function validateCloudRexPlan(plan, now = Date.now()) {
  if (typeof plan?.machineId !== 'string' || typeof plan?.machineName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(plan.machineId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(plan.machineName) || JSON.stringify(plan).length > 16384) throw Error('Invalid Rex machine identity');
  if (plan.schemaVersion !== 1 || !['boxd', 'boat'].includes(plan.provider) || !['nixos', 'macos'].includes(plan.desktop) || typeof plan.allocationId !== 'string' || !plan.allocationId || typeof plan.hostId !== 'string' || !plan.hostId || plan.core?.version !== REX_VERSION || plan.core?.socket !== REX_SOCKET || plan.core?.user !== 'origin-runner' || !Number.isSafeInteger(plan.issuedAt) || !Number.isSafeInteger(plan.expiresAt) || plan.issuedAt > now + 5000 || plan.expiresAt <= now || plan.expiresAt <= plan.issuedAt || plan.expiresAt - plan.issuedAt > 60000) throw Error('Invalid or expired Rex allocation grant');
  const name = `origin-rex-${plan.provider}-${createHash('sha256').update(JSON.stringify([plan.allocationId, plan.desktop])).digest('hex').slice(0, 20)}`;
  if (plan.name !== name || Object.keys(plan).some(key => !['schemaVersion', 'allocationId', 'hostId', 'provider', 'desktop', 'machineId', 'machineName', 'name', 'issuedAt', 'expiresAt', 'core'].includes(key))) throw Error('Rex grant is not an Origin-owned fixed transport');
  return plan;
}
function contains(value, target) {
  return value && typeof value === 'object' ? Object.values(value).some(child => contains(child, target)) : value === target;
}
async function ownerOnly(path, kind) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info[kind]() || info.uid !== process.getuid() || info.mode & 0o077) throw Error('Rex connection state must be owner-only');
}

// The worker owns the listener and every SSH relay. A worker crash closes all
// transports; expiry/revocation closes them even while a native CLI is blocked.
export class RexConnections {
  constructor(config, { launch = command, spawnRelay = spawn } = {}) {
    this.config = config; this.launch = launch; this.spawnRelay = spawnRelay;
    this.root = join(config.dataDirectory, 'rex-links'); this.entries = new Map();
    this.observation = {}; this.pending = null; this.running = null; this.stopped = false;
  }
  report() {
    const enabled = this.config.rex?.enabled === true;
    return { enabled, cloudConnections: enabled && this.config.rex?.cloudConnections === true, ...(enabled ? this.observation : {}) };
  }
  async observe() {
    if (!this.report().enabled) return;
    try { this.observation = await rexStatus(this.config, this.launch); }
    catch { this.observation = { status: 'unavailable', message: unavailable }; }
  }
  schedule(plans) {
    if (this.stopped) return;
    const desired = new Map();
    if (this.report().cloudConnections && ['nixos', 'mac'].includes(this.config.kind) && Array.isArray(plans)) {
      for (const plan of plans.slice(0, 32)) try {
        validateCloudRexPlan(plan);
        if (plan.desktop === (this.config.kind === 'mac' ? 'macos' : 'nixos')) desired.set(plan.name, plan);
      } catch {}
    }
    // Fence immediately, rather than waiting for native discovery/add/remove.
    for (const [name, entry] of this.entries) {
      const next = desired.get(name);
      if (!next || next.machineId !== entry.plan.machineId || next.hostId !== entry.plan.hostId || next.machineName !== entry.plan.machineName) this.fence(entry);
      else if (next.issuedAt >= entry.plan.issuedAt) entry.plan = next;
    }
    this.pending = desired;
    if (!this.running) this.start();
  }
  start() {
    this.running = Promise.resolve().then(async () => {
      while (this.pending !== null) {
        const desired = this.pending; this.pending = null;
        try { await this.reconcile(desired); } catch { this.observation = { status: 'needs_auth', message: needsAuth }; }
      }
    }).finally(() => { this.running = null; if (this.pending !== null) this.start(); });
  }
  async native(args, options = {}) {
    const { executable, args: prefix } = rexCommand(this.config);
    return this.launch(executable, [...prefix, ...args], { env: rexEnvironment(), timeoutMs: 10000, maxOutput: 65536, ...options });
  }
  fence(entry) {
    if (entry.closed) return;
    entry.closed = true; clearInterval(entry.timer); entry.abort.abort();
    entry.server.close(() => {});
    for (const socket of entry.sockets) socket.destroy();
    for (const child of entry.children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }
  async removeOwned(name) {
    const path = join(this.root, `${name}.json`);
    try {
      await ownerOnly(path, 'isFile');
      const receipt = JSON.parse(await readFile(path, 'utf8'));
      const endpoint = `unix://${join(this.root, `${name}.sock`)}`;
      if (receipt.name !== name || receipt.endpoint !== endpoint || receipt.originOwned !== true) throw Error('Not an owned Rex alias');
      const registry = JSON.parse((await this.native(['hosts', '--json'])).stdout);
      if (contains(registry, name)) {
        // A changed registry entry is personal state, never ours to remove.
        const rows = registry.hosts;
        if (!Array.isArray(rows) || !rows.some(row => row.host?.label === name && Array.isArray(row.host.endpoints) && row.host.endpoints.length === 1 && row.host.endpoints[0] === endpoint)) throw Error('Rex alias was changed outside Origin');
        await this.native(['hosts', 'remove', name]);
      }
      await rm(path, { force: true }); await rm(join(this.root, `${name}.sock`), { force: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async reconcile(desired) {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await ownerOnly(this.root, 'isDirectory');
    for (const [name, entry] of this.entries) if (entry.closed || !desired.has(name)) {
      this.fence(entry); this.entries.delete(name);
      try { await this.removeOwned(name); } catch { this.observation = { status: 'needs_auth', message: needsAuth }; }
    }
    for (const file of (await readdir(this.root)).filter(file => file.endsWith('.json') && alias.test(file.slice(0, -5))).slice(0, 64)) {
      const name = file.slice(0, -5);
      if (!this.entries.has(name)) await this.removeOwned(name);
    }
    if (this.stopped || !this.report().enabled) return;
    await this.observe();
    if (this.observation.status !== 'ready') return;
    for (const [name, plan] of desired) {
      if (this.pending !== null || this.stopped) break;
      if (this.entries.has(name)) continue;
      try { validateCloudRexPlan(plan); await this.add(plan); }
      catch { this.observation = { version: this.observation.version, status: 'needs_auth', message: needsAuth }; }
    }
  }
  async add(plan) {
    const path = join(this.root, `${plan.name}.sock`), endpoint = `unix://${path}`;
    if (Buffer.byteLength(path) > 100) throw Error('Private Rex socket path exceeds portable limit');
    const registry = JSON.parse((await this.native(['hosts', '--json'])).stdout);
    if (contains(registry, plan.name)) throw Error('Refusing to replace a native Rex alias');
    if (this.stopped || this.pending !== null) throw Error('Rex connection snapshot was superseded');
    validateCloudRexPlan(plan);
    const entry = { plan, closed: false, sockets: new Set(), children: new Set(), abort: new AbortController() };
    entry.server = createServer(socket => { void this.relay(entry, socket); });
    this.entries.set(plan.name, entry);
    try {
      await new Promise((done, reject) => { entry.server.once('error', reject); entry.server.listen(path, done); });
      entry.server.on('error', () => this.fence(entry)); await chmod(path, 0o600);
      entry.timer = setInterval(() => { try { validateCloudRexPlan(entry.plan); } catch { this.fence(entry); } }, 250);
      entry.timer.unref();
      await atomicJson(join(this.root, `${plan.name}.json`), { originOwned: true, name: plan.name, endpoint });
      await this.native(['hosts', 'add', plan.name, endpoint], { signal: entry.abort.signal });
      await rexStatus({ ...this.config, rex: { ...this.config.rex, server: endpoint } }, (executable, args, options) => this.launch(executable, args, { ...options, signal: entry.abort.signal }));
      validateCloudRexPlan(entry.plan);
    } catch (error) { this.fence(entry); throw error; }
  }
  async relay(entry, socket) {
    socket.on('error', () => {});
    if (entry.closed || entry.sockets.size >= 8) { socket.destroy(); return; }
    entry.sockets.add(socket); let child;
    const stop = () => { entry.sockets.delete(socket); if (child) { entry.children.delete(child); try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    socket.once('close', stop);
    try {
      validateCloudRexPlan(entry.plan);
      const plan = entry.plan, env = { ...rexEnvironment(), BOAT_NO_UPDATE: '1', BOAT_API_URL: 'https://boat.dev/api/v1' };
      const query = plan.provider === 'boxd' ? ['machine', 'get', plan.machineId, '--json'] : ['info', plan.machineId, '--json'];
      const result = await this.launch(plan.provider, query, { env, timeoutMs: Math.min(10000, plan.expiresAt - Date.now()), maxOutput: 65536, signal: entry.abort.signal });
      requireRunningCloudMachine(plan.provider, plan.machineId, JSON.parse(result.stdout));
      validateCloudRexPlan(entry.plan);
      if (entry.closed || socket.destroyed) throw Error('Rex transport revoked');
      // Fixed byte relay, never a plan-supplied shell program or arbitrary target.
      const code = `const s=require('node:net').createConnection(${JSON.stringify(REX_SOCKET)});s.on('error',()=>process.exit(1));s.on('close',()=>process.exit());process.stdin.pipe(s);s.pipe(process.stdout);process.stdin.on('end',()=>s.end());`;
      const remote = `sudo -n -u origin-runner env -i HOME=/var/lib/origin-runner /opt/origin-node/bin/node -e ${quote(code)}`;
      const args = plan.provider === 'boxd' ? ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=10', `${plan.machineName}.boxd`, remote] : ['ssh', plan.machineId, remote];
      child = this.spawnRelay(plan.provider === 'boxd' ? 'ssh' : 'boat', args, { env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
      entry.children.add(child);
      child.on('error', () => socket.destroy()); child.on('close', () => { entry.children.delete(child); socket.destroy(); });
      child.stdin.on('error', () => socket.destroy()); child.stdout.on('error', () => socket.destroy());
      socket.pipe(child.stdin); child.stdout.pipe(socket);
    } catch { this.observation = { version: this.observation.version, status: 'needs_auth', message: needsAuth }; socket.destroy(); this.fence(entry); }
  }
  async stop() {
    this.stopped = true; for (const entry of this.entries.values()) this.fence(entry);
    this.pending = new Map(); if (!this.running) this.start();
    while (this.running) await this.running;
  }
}
