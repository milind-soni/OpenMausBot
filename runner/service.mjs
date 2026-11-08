import { mkdir, cp, readFile, writeFile, symlink, rename, rm, access, realpath, lstat, open } from 'node:fs/promises';
import { join, resolve, dirname, delimiter, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verify, randomUUID, createPublicKey } from 'node:crypto';
import { VERSION, hash, atomicJson, readJson, baseEnvironment, controllerEndpoint, Redactor } from './security.mjs';
import { command } from './process.mjs';
import { RunLedger } from './protocol.mjs';

const updateStatuses = new Set(['unknown', 'current', 'available', 'pending', 'updating', 'failed']);
export function boundedUpdateReports(reports, secrets = []) {
  if (!Array.isArray(reports)) return [];
  const redactor = new Redactor(secrets), result = [];
  for (const report of reports) {
    if (!report || typeof report.component !== 'string' || !report.component.length) continue;
    result.push({
      component: report.component.slice(0, 100),
      ...(typeof report.currentVersion === 'string' ? { currentVersion: report.currentVersion.slice(0, 120) } : {}),
      ...(typeof report.availableVersion === 'string' ? { availableVersion: report.availableVersion.slice(0, 120) } : {}),
      status: updateStatuses.has(report.status) ? report.status : 'unknown',
      ...(Number.isFinite(report.checkedAt) && report.checkedAt >= 0 ? { checkedAt: report.checkedAt } : {}),
      ...(typeof report.message === 'string' ? { message: redactor.text(report.message).slice(0, 1000) } : {}),
    });
    if (result.length === 20) break;
  }
  return result;
}
export function updateRequestSignal(signal, timeoutMs) {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function pinRunnerUpdates(config, metadata) {
  if (!metadata) return config.updates;
  const base = new URL(metadata.baseUrl), controller = new URL(controllerEndpoint(config.controller));
  if (base.protocol !== 'https:' || base.origin !== controller.origin || base.username || base.password || base.search || base.hash) throw new Error('Enrollment release source must be credential-free HTTPS on the enrolled Origin');
  const key = createPublicKey(metadata.publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Enrollment runner release key must be Ed25519');
  const pem = key.export({ type: 'spki', format: 'pem' });
  const publicKeyFile = config.updates?.publicKeyFile ?? join(config.dataDirectory, 'runner-release-key.pem');
  if (config.updates?.baseUrl && new URL(config.updates.baseUrl).href.replace(/\/$/, '') !== base.href.replace(/\/$/, '')) throw new Error('Existing runner release source differs; explicit owner trust migration required');
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(publicKeyFile);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Pinned release key must be an owner-only local regular file');
    const existing = createPublicKey(await readFile(publicKeyFile, 'utf8')).export({ type: 'spki', format: 'pem' });
    if (existing !== pem) throw new Error('Existing runner trust anchor differs; refusing silent key replacement');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(publicKeyFile, pem, { mode: 0o600, flag: 'wx' });
  }
  return { ...config.updates, baseUrl: base.href, publicKeyFile };
}

const sourceDirectory = fileURLToPath(new URL('.', import.meta.url));
const xml = value => String(value).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[value]));
const systemd = value => `"${String(value).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
export function serviceDefinition({ platform, node, launcher, config, dataDirectory, path }) {
  if ([node, launcher, config, dataDirectory, path].some(value => /[\r\n\0]/.test(value))) throw new Error('Invalid service path');
  if (platform === 'linux') return { filename: join(homedir(), '.config/systemd/user/origin-runner.service'), content: `[Unit]\nDescription=Origin scoped coding runner\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${systemd(node)} ${systemd(launcher)} run --config ${systemd(config)}\nEnvironment=${systemd(`PATH=${path}`)}\nWorkingDirectory=${dataDirectory.replace(/%/g, '%%')}\nRestart=on-failure\nRestartSec=15\nKillMode=control-group\nTimeoutStopSec=45\nNice=10\nCPUQuota=200%\nMemoryHigh=4G\nMemoryMax=6G\nTasksMax=256\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`, activate: 'systemctl --user daemon-reload && systemctl --user enable --now origin-runner.service' };
  // macOS RLIMIT_NPROC counts the whole user's processes, not this runner's tree.
  // Inherit its system limit; a low per-user cap prevents native CLI children from starting.
  if (platform === 'darwin') return { filename: join(homedir(), 'Library/LaunchAgents/com.origin.runner.plist'), content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.origin.runner</string>\n<key>ProgramArguments</key><array>${[node, launcher, 'run', '--config', config].map(value => `<string>${xml(value)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(dataDirectory)}</string>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ProcessType</key><string>Background</string>\n<key>Nice</key><integer>10</integer>\n<key>ThrottleInterval</key><integer>15</integer>\n<key>ExitTimeOut</key><integer>45</integer>\n<key>Umask</key><integer>63</integer>\n<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>1024</integer></dict>\n<key>StandardOutPath</key><string>${xml(join(dataDirectory, 'service.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(join(dataDirectory, 'service-error.log'))}</string>\n</dict></plist>\n`, activate: 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.origin.runner.plist' };
  throw new Error('Only native Linux user systemd and macOS launchd are supported');
}
async function pointCurrent(root, release, signal) {
  const temporary = join(root, `current-${randomUUID()}`);
  await symlink(release, temporary);
  try { signal?.throwIfAborted(); await rename(temporary, join(root, 'current')); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}
export async function install(config, configPath, { filesOnly = false } = {}) {
  await requireIdle(config);
  const root = join(config.dataDirectory, 'installation');
  const release = join(root, 'releases', VERSION);
  const launcher = join(root, 'launcher.mjs');
  const alias = join(homedir(), '.local/bin/origin-runner');
  // Prefer the package manager's stable alias, not a versioned store/Cellar path.
  let node = process.execPath;
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, 'node');
    if (candidate === process.execPath) continue;
    try { if (await realpath(candidate) === process.execPath) { node = candidate; break; } } catch {}
  }
  const service = filesOnly ? null : serviceDefinition({ platform: process.platform, node, launcher, config: resolve(configPath), dataDirectory: config.dataDirectory, path: process.env.PATH ?? '/usr/bin:/bin' });
  for (const path of [alias, ...(service ? [service.filename] : [])]) {
    try { await access(path); throw new Error(`Refusing to replace an existing personal command/service: ${path}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(join(root, 'releases'), { recursive: true, mode: 0o700 });
  try { await access(release); throw new Error('This version is already installed; existing immutable release was not overwritten'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await cp(sourceDirectory, join(release, 'runner'), { recursive: true, filter: path => !path.includes(`${join('runner', 'test')}`) });
  await validateInstalledRunner(release, VERSION);
  await writeFile(launcher, `import { realpath } from 'node:fs/promises';\nimport { pathToFileURL } from 'node:url';\nimport { dirname, join } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst root = dirname(fileURLToPath(import.meta.url));\nawait import(pathToFileURL(await realpath(join(root, 'current', 'runner', 'cli.mjs'))).href);\n`, { mode: 0o600 });
  await pointCurrent(root, release);
  if (service) {
    await mkdir(dirname(service.filename), { recursive: true, mode: 0o700 });
    // Do not silently replace a user-edited service definition.
    await writeFile(service.filename, service.content, { mode: 0o600, flag: 'wx' });
  }
  await mkdir(dirname(alias), { recursive: true, mode: 0o700 });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(alias, `#!/bin/sh\nexec ${quote(node)} ${quote(launcher)} --config ${quote(resolve(configPath))} "$@"\n`, { mode: 0o700, flag: 'wx' });
  return { command: alias, launcher, ...(service ? { serviceFile: service.filename, activationCommand: service.activate } : {}), note: filesOnly ? 'Versioned runner and alias installed for an external supervisor. No user service written or started.' : 'Runner alias and user service definition written only. Enroll before explicit activation; no service started.' };
}
export async function validateInstalledRunner(release, version, { signal } = {}) {
  const entrypoint = join(release, 'runner', 'cli.mjs');
  const preflight = `import { VERSION } from ${JSON.stringify(pathToFileURL(join(release, 'runner', 'security.mjs')).href)};
    if (VERSION !== ${JSON.stringify(version)}) throw new Error('Runner release version mismatch');
    process.argv = ['node', ${JSON.stringify(entrypoint)}, '--help'];
    await import(${JSON.stringify(pathToFileURL(entrypoint).href)});`;
  await command(process.execPath, ['--input-type=module', '-e', preflight], { env: baseEnvironment(), timeoutMs: 15000, signal });
}
export async function assertIdleState(config) {
  if (await readJson(join(config.dataDirectory, 'tool-maintenance-fence.json'), null)) throw new Error('Host fenced after uncertain maintenance; operator recovery required');
  if ((await readJson(join(config.dataDirectory, 'status.json'), {})).activeRunId) throw new Error('Runner is not idle');
  if ((await new RunLedger(config.dataDirectory).records()).some(record => !['stopped', 'acknowledged'].includes(record.state))) throw new Error('Uncertain prior execution blocks maintenance until process stop is proven');
}
export async function requireIdle(config) {
  try { await access(join(config.dataDirectory, 'worker.lock')); throw new Error('Stop the runner cleanly before installation/update; active or uncertain worker lock exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await access(join(config.dataDirectory, 'tool-update.lock')); throw new Error('Active or uncertain maintenance lock exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await assertIdleState(config);
}
export async function withMaintenanceLock(config, work) {
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  await assertIdleState(config);
  const workerPath = join(config.dataDirectory, 'worker.lock'), toolsPath = join(config.dataDirectory, 'tool-update.lock');
  let worker, tools;
  try {
    try { worker = await open(workerPath, 'wx', 0o600); await worker.writeFile(JSON.stringify({ pid: process.pid, maintenance: true })); await worker.sync(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; if ((await readJson(workerPath)).pid !== process.pid) throw new Error('Stop the worker before local maintenance; another process owns its lock'); }
    await assertIdleState(config);
    tools = await open(toolsPath, 'wx', 0o600); await tools.writeFile(JSON.stringify({ pid: process.pid })); await tools.sync();
    return await work();
  } catch (error) {
    if (error.processStopUnproven || error.maintenanceUncertain) await atomicJson(join(config.dataDirectory, 'tool-maintenance-fence.json'), { at: Date.now(), message: 'Maintenance cannot prove process stop or rollback; operator recovery required' });
    throw error;
  } finally {
    if (tools) { await tools.close(); await rm(toolsPath, { force: true }); }
    if (worker) { await worker.close(); await rm(workerPath, { force: true }); }
  }
}
export function compatibleStable(current, next) {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!stable.test(current ?? '') || !stable.test(next ?? '')) return false;
  const a = current.split('.').map(Number), b = next.split('.').map(Number);
  // Before 1.0, a minor increment is a compatibility boundary.
  return a[0] === b[0] && (a[0] !== 0 || a[1] === b[1]);
}
export async function quarantinedRelease(config, component, version) {
  return (await readJson(join(config.dataDirectory, 'update-quarantine.json'), {}))[component]?.[version];
}
export async function quarantineRelease(config, component, version, reason) {
  const path = join(config.dataDirectory, 'update-quarantine.json'), entries = await readJson(path, {});
  entries[component] ??= {};
  if (reason) entries[component][version] = { at: Date.now(), reason };
  else delete entries[component][version];
  await atomicJson(path, entries);
}
export function validateRelease(manifest, signature, publicKey, requestedVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.version !== requestedVersion || manifest.channel !== 'stable' || manifest.protocolVersion !== 1 || manifest.nodeMajor !== 24) throw new Error('Release must be an explicitly pinned compatible stable Node24 release');
  if (!verify(null, Buffer.from(JSON.stringify(manifest)), publicKey, Buffer.from(signature, 'base64'))) throw new Error('Release signature invalid');
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100) throw new Error('Invalid release file manifest');
  const paths = new Set();
  for (const file of manifest.files) {
    if (!/^runner\/[A-Za-z0-9_./-]+\.(?:mjs|json)$/.test(file.path) || file.path.split('/').some(value => value === '.' || value === '..' || value === '') || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 10 * 1024 * 1024 || paths.has(file.path)) throw new Error('Unsafe release manifest entry');
    paths.add(file.path);
  }
  if (!paths.has('runner/cli.mjs')) throw new Error('Release lacks the runner entrypoint');
}
function releaseBase(config) {
  if (!config.updates?.baseUrl || !config.updates?.publicKeyFile) throw new Error('Owner must configure updates.baseUrl and a local trusted publicKeyFile; unsigned controller bundles are check-only');
  const base = new URL(config.updates.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Pinned release source must use credential-free HTTPS');
  return base.href.endsWith('/') ? base : new URL(`${base.href}/`);
}
async function releaseEnvelope(config, path, fetcher, signal) {
  const response = await fetcher(new URL(path, releaseBase(config)), { redirect: 'error', signal: updateRequestSignal(signal, 30000) });
  if (!response.ok) throw new Error(`Release manifest fetch failed (${response.status})`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { signal?.throwIfAborted(); size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('Release manifest exceeds 2 MiB'); chunks.push(chunk); }
  const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return { ...envelope, publicKey: await readFile(config.updates.publicKeyFile, 'utf8') };
}
export async function checkRunnerUpdate(config, dependencies = {}) {
  const { manifest, signature, publicKey } = await releaseEnvelope(config, 'latest.json', dependencies.fetch ?? fetch, dependencies.signal);
  // Authenticate metadata before reporting it, even when its runtime is incompatible.
  if (!manifest || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version) || manifest.channel !== 'stable' || !verify(null, Buffer.from(JSON.stringify(manifest)), publicKey, Buffer.from(signature, 'base64'))) throw new Error('Latest stable metadata is not signed by the configured release key');
  const newer = versionNewer(manifest.version, VERSION);
  const compatible = manifest.protocolVersion === 1 && manifest.nodeMajor === 24 && compatibleStable(VERSION, manifest.version);
  const quarantine = await quarantinedRelease(config, 'origin-runner', manifest.version);
  const report = { component: 'origin-runner', currentVersion: VERSION, availableVersion: manifest.version, status: quarantine ? 'failed' : newer ? 'available' : 'current', checkedAt: Date.now(), message: `Source: ${new URL('latest.json', releaseBase(config))}. Trusted signed stable metadata. ${quarantine ? 'Version quarantined after failed/interrupted apply or explicit rollback; no automatic retry.' : compatible ? 'Compatible release; idle owner-enabled updates supported.' : 'Compatibility boundary requires explicit owner approval; protocol/Node changes additionally require a compatible runner/runtime.'}` };
  return { manifest, signature, publicKey, compatible, report: boundedUpdateReports([report], [config.hostToken])[0] };
}
function versionNewer(next, current) {
  const a = next.split('.').map(Number), b = current.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
async function runnerInstallation(config) {
  const root = join(config.dataDirectory, 'installation'), canonical = await realpath(root);
  if (canonical !== join(await realpath(config.dataDirectory), 'installation') || (await lstat(root)).isSymbolicLink()) throw new Error('Runner installation must be the private local installation');
  const previous = await realpath(join(root, 'current')), releases = await realpath(join(root, 'releases'));
  if (releases !== join(canonical, 'releases') || dirname(previous) !== releases) throw new Error('Runner current release escapes the private installation');
  return { root, previous, releases };
}
export async function applyRunnerRelease(config, plan, { supervised = false, approveBoundary = false } = {}, dependencies = {}) {
  const { manifest, signature, publicKey } = plan;
  validateRelease(manifest, signature, publicKey, manifest.version);
  if (!versionNewer(manifest.version, VERSION)) throw new Error('Update must be newer; use explicit rollback for downgrades');
  if (!approveBoundary && !compatibleStable(VERSION, manifest.version)) throw new Error('Compatibility boundary requires explicit local owner approval');
  const assertOwner = async () => {
    dependencies.signal?.throwIfAborted();
    if (!supervised) return requireIdle(config);
    const worker = await readJson(join(config.dataDirectory, 'worker.lock'), {});
    const tools = await readJson(join(config.dataDirectory, 'tool-update.lock'), {});
    if (worker.pid !== process.pid || tools.pid !== process.pid) throw new Error('Runner update requires exclusive idle maintenance ownership');
    await assertIdleState(config);
    if ((await new RunLedger(config.dataDirectory).records()).some(record => record.state !== 'acknowledged')) throw new Error('Runner restart waits for durable stop receipt acknowledgement');
  };
  await assertOwner();
  if (await quarantinedRelease(config, 'origin-runner', manifest.version)) throw new Error('Release is quarantined; rejected versions are not retried');
  const { root, previous, releases } = await runnerInstallation(config);
  if (!versionNewer(manifest.version, previous.split('/').at(-1))) throw new Error('Update must be newer than the installed release; refusing a downgrade');
  const release = join(releases, manifest.version), stage = join(releases, `.stage-${randomUUID()}`);
  const previousBackup = await readJson(join(root, 'rollback.json'), null);
  let promoted = false, switched = false, backupWritten = false;
  await quarantineRelease(config, 'origin-runner', manifest.version, 'Apply started; success not yet proven');
  const runPreflight = dependencies.preflight ?? validateInstalledRunner;
  try {
    await mkdir(stage, { mode: 0o700 });
    for (const file of manifest.files) {
      const result = await (dependencies.fetch ?? fetch)(new URL(`${manifest.version}/${file.path}`, releaseBase(config)), { redirect: 'error', signal: updateRequestSignal(dependencies.signal, 30000) });
      if (!result.ok) throw new Error(`Release file fetch failed (${result.status})`);
      const chunks = []; let size = 0;
      for await (const chunk of result.body) { dependencies.signal?.throwIfAborted(); size += chunk.length; if (size > file.bytes) throw new Error('Release file exceeds declared size'); chunks.push(chunk); }
      const content = Buffer.concat(chunks);
      if (content.length !== file.bytes || hash(content) !== file.sha256) throw new Error('Release integrity mismatch');
      dependencies.signal?.throwIfAborted();
      const target = join(stage, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, content, { mode: 0o600, flag: 'wx' });
    }
    dependencies.signal?.throwIfAborted();
    await runPreflight(stage, manifest.version, { signal: dependencies.signal });
    dependencies.signal?.throwIfAborted();
    await mkdir(release, { mode: 0o700 });
    await rename(stage, release); promoted = true;
    await atomicJson(join(root, 'rollback.json'), { previous, next: release, version: manifest.version, appliedAt: Date.now() }); backupWritten = true;
    await atomicJson(join(root, 'pending-update.json'), { previous, next: release, version: manifest.version, launches: 0, previousBackup });
    await assertOwner();
    await pointCurrent(root, release, dependencies.signal); switched = true;
    await runPreflight(release, manifest.version, { signal: dependencies.signal });
    dependencies.signal?.throwIfAborted();
    return { version: manifest.version, previous, note: 'Signed stable release selected; prior release preserved. Supervised restart confirms the new heartbeat before clearing quarantine.' };
  } catch (error) {
    try {
      if (switched) await pointCurrent(root, previous);
      if (backupWritten) {
        if (previousBackup) await atomicJson(join(root, 'rollback.json'), previousBackup);
        else await rm(join(root, 'rollback.json'), { force: true });
      }
      await rm(join(root, 'pending-update.json'), { force: true });
    } catch (cause) {
      await atomicJson(join(config.dataDirectory, 'tool-maintenance-fence.json'), { at: Date.now(), message: 'Runner rollback uncertain; operator recovery required' });
      throw Object.assign(new Error('Runner rollback could not be proven'), { maintenanceUncertain: true, cause });
    }
    if (error.processStopUnproven) await atomicJson(join(config.dataDirectory, 'tool-maintenance-fence.json'), { at: Date.now(), message: 'Runner preflight stop unproven; operator recovery required' });
    if (!promoted) await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
export async function beginRunnerUpdate(config) {
  const path = join(config.dataDirectory, 'installation/pending-update.json'), pending = await readJson(path, null);
  if (!pending) return false;
  if (pending.version !== VERSION || pending.launches > 0 || (await runnerInstallation(config)).previous !== pending.next) {
    await recoverRunnerUpdate(config);
    return true;
  }
  await atomicJson(path, { ...pending, launches: 1 });
  return false;
}
export async function confirmRunnerUpdate(config) {
  const path = join(config.dataDirectory, 'installation/pending-update.json'), pending = await readJson(path, null);
  if (pending?.version !== VERSION) return;
  if ((await runnerInstallation(config)).previous !== pending.next) throw new Error('Running release does not match the pending runner cutover');
  await quarantineRelease(config, 'origin-runner', VERSION, null);
  await rm(path, { force: true });
}
export async function recoverRunnerUpdate(config) {
  const path = join(config.dataDirectory, 'installation/pending-update.json'), pending = await readJson(path, null);
  if (!pending) return;
  try {
    const { root, releases } = await runnerInstallation(config), previous = await realpath(pending.previous);
    if (dirname(previous) !== releases || previous === pending.next) throw new Error('Invalid pending runner rollback record');
    await quarantineRelease(config, 'origin-runner', pending.version, 'Startup failed/interrupted; prior release restored');
    await pointCurrent(root, previous);
    if (pending.previousBackup) await atomicJson(join(root, 'rollback.json'), pending.previousBackup);
    else await rm(join(root, 'rollback.json'), { force: true });
    await rm(path, { force: true });
  } catch (cause) {
    await atomicJson(join(config.dataDirectory, 'tool-maintenance-fence.json'), { at: Date.now(), message: 'Runner startup rollback uncertain; operator recovery required' });
    throw Object.assign(new Error('Runner startup rollback could not be proven'), { maintenanceUncertain: true, cause });
  }
}
export async function update(config, requestedVersion, approved, dependencies = {}) {
  if (!approved) throw new Error('Update requires --approve and an explicit --version');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(requestedVersion ?? '')) throw new Error('Explicit stable --version required');
  await requireIdle(config);
  const plan = await releaseEnvelope(config, `${requestedVersion}/manifest.json`, dependencies.fetch ?? fetch, dependencies.signal);
  validateRelease(plan.manifest, plan.signature, plan.publicKey, requestedVersion);
  return withMaintenanceLock(config, () => applyRunnerRelease(config, plan, { approveBoundary: true, supervised: true }, dependencies));
}
export async function rollback(config, approved) {
  if (!approved) throw new Error('Rollback requires --approve');
  await requireIdle(config);
  return withMaintenanceLock(config, async () => {
  const { root, previous: current, releases } = await runnerInstallation(config);
  const receipt = await readJson(join(root, 'rollback.json')), previous = await realpath(receipt.previous);
  if (receipt.next !== current || dirname(previous) !== releases) throw new Error('Rollback record does not bind current and previous releases');
  await validateInstalledRunner(previous, previous.split('/').at(-1));
  await quarantineRelease(config, 'origin-runner', receipt.version, 'Explicit owner rollback; no automatic reapply');
  await pointCurrent(root, previous);
  await rm(join(root, 'pending-update.json'), { force: true });
  return { restored: previous, note: 'Previous version selected; start service explicitly.' };
  });
}
