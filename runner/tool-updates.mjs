import { mkdir, mkdtemp, realpath, writeFile, rm, rename, symlink, lstat, copyFile, chmod } from 'node:fs/promises';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, baseEnvironment, Redactor, hash } from './security.mjs';
import { command } from './process.mjs';
import { executable, discoverAccounts } from './accounts.mjs';
import { compareVersions } from './maintenance.mjs';
import { assertIdleState, withMaintenanceLock, compatibleStable, quarantinedRelease, quarantineRelease, boundedUpdateReports, updateRequestSignal } from './service.mjs';

export const TOOL_PACKAGES = Object.freeze({
  'claude-code': { package: '@anthropic-ai/claude-code', bin: 'claude', flags: ['--input-format', '--permission-mode'] },
  codex: { package: '@openai/codex', bin: 'codex', flags: ['app-server'] },
  omp: { package: '@oh-my-pi/pi-coding-agent', bin: 'omp', flags: ['--mode', '--approval-mode'] },
  pi: { package: '@earendil-works/pi-coding-agent', bin: 'pi', flags: ['--mode', '--no-extensions'] },
});
const stable = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const inside = (root, path) => { const part = relative(root, path); return part !== '' && !part.startsWith(`..${sep}`) && part !== '..' && !part.startsWith(sep); };
const registryUrl = name => `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
export function validateToolMetadata(harness, metadata) {
  const spec = TOOL_PACKAGES[harness];
  if (!spec || metadata?.name !== spec.package || !stable(metadata.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist?.integrity ?? '')) throw new Error('Registry did not return an integrity-pinned stable package');
  const tarball = new URL(metadata.dist.tarball);
  if (tarball.origin !== 'https://registry.npmjs.org' || tarball.username || tarball.password || tarball.hash || tarball.search) throw new Error('Package tarball is not on the approved npm registry');
  return metadata;
}
export async function fetchToolMetadata(harness, fetcher = fetch, signal) {
  const response = await fetcher(registryUrl(TOOL_PACKAGES[harness].package), { redirect: 'error', signal: updateRequestSignal(signal, 15000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Stable npm metadata unavailable (${response.status})`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { signal?.throwIfAborted(); size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('Registry metadata exceeds 2 MiB'); chunks.push(chunk); }
  return validateToolMetadata(harness, JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
export function validateManagedManifest(harness, manifest) {
  const spec = TOOL_PACKAGES[harness];
  if (!spec || manifest?.schemaVersion !== 1 || manifest.managedBy !== 'origin-runner' || manifest.harness !== harness || manifest.package !== spec.package || !stable(manifest.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(manifest.integrity ?? '') || manifest.executable !== `node_modules/.bin/${spec.bin}`) throw new Error('Invalid runner-managed tool ownership manifest');
  return manifest;
}
async function managedRoot(config) {
  if (!config.managedTools) return null;
  const expected = resolve(config.dataDirectory, 'tools');
  if (config.managedTools.schemaVersion !== 1 || resolve(config.managedTools.root ?? '') !== expected) throw new Error('Managed tools must explicitly own dataDirectory/tools');
  const info = await lstat(expected);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Managed tool root must be a private owner-only directory');
  const data = await realpath(config.dataDirectory);
  const actual = await realpath(expected);
  if (actual !== join(data, 'tools')) throw new Error('Managed tool root cannot redirect outside the runner directory');
  return actual;
}
export async function managedInstallation(config, harness, selectedExecutable) {
  const root = await managedRoot(config); if (!root) return null;
  const spec = TOOL_PACKAGES[harness], home = join(root, harness), current = join(home, 'current');
  const expectedExecutable = join(current, 'node_modules/.bin', spec.bin);
  // An explicit old-release path is a pin, not consent to move the current alias.
  if (selectedExecutable && resolve(selectedExecutable) !== resolve(config.managedTools.root, harness, 'current', 'node_modules/.bin', spec.bin)) return null;
  let release;
  try { release = await realpath(current); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!inside(join(home, 'releases'), release) || dirname(release) !== join(home, 'releases')) throw new Error('Managed current release escapes its private release directory');
  const manifest = validateManagedManifest(harness, await readJson(join(release, 'release.json')));
  if (release !== join(home, 'releases', manifest.version)) throw new Error('Managed version and release directory disagree');
  if (!inside(release, await realpath(expectedExecutable))) throw new Error('Managed executable escapes its immutable release');
  return { root, home, current, release, executable: expectedExecutable, manifest };
}
async function privateEnvironment(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const env = baseEnvironment({ HOME: root, XDG_CONFIG_HOME: join(root, '.config'), XDG_CACHE_HOME: join(root, '.cache'), CODEX_HOME: join(root, '.codex'), CLAUDE_CONFIG_DIR: join(root, '.claude'), PI_CODING_AGENT_DIR: join(root, '.pi'), DISABLE_AUTOUPDATER: '1', CI: '1', npm_config_userconfig: join(root, '.npmrc'), npm_config_globalconfig: join(root, '.npm-globalrc'), npm_config_registry: 'https://registry.npmjs.org', npm_config_cache: join(root, '.npm') });
  delete env.SSH_AUTH_SOCK;
  return env;
}
async function packageLocation(path, name) {
  let current = dirname(path);
  for (let depth = 0; depth < 8; depth++) {
    const manifest = await readJson(join(current, 'package.json'), null);
    if (manifest?.name === name) return { directory: current, manifest };
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return null;
}
export async function ownershipAction(harness, path, version, packageInfo, runCommand = command) {
  const spec = TOOL_PACKAGES[harness];
  if (path.startsWith('/nix/store/')) {
    try {
      const nix = await executable('nix');
      if (nix) {
        const result = await runCommand(nix, ['profile', 'list', '--json'], { env: baseEnvironment(), timeoutMs: 10000, maxOutput: 1024 * 1024 });
        const entries = JSON.parse(result.stdout).elements ?? {};
        for (const [name, value] of Object.entries(entries)) if (value.storePaths?.some(store => path === store || path.startsWith(`${store}/`))) return { ownership: 'nix-profile', action: `nix profile upgrade ${quote(name)}`, explanation: 'Nix user-profile ownership; runner will not modify it.' };
      }
    } catch (error) { if (error.processStopUnproven) throw error; }
    return { ownership: 'nix', action: 'nix profile list --json', explanation: 'Nix store/system/flake ownership; no safe targeted upgrade was inferred. Inspect the profile with the command shown, then have its owner update the existing package pin; no OS rebuild is performed.' };
  }
  if (path.includes('/Caskroom/')) return { ownership: 'homebrew-cask', action: `brew upgrade --cask ${quote(harness === 'claude-code' ? 'claude-code' : spec.bin)}`, explanation: 'Homebrew cask ownership; manual package-manager update only.' };
  if (path.includes('/Cellar/')) return { ownership: 'homebrew', action: `brew upgrade ${quote(spec.bin)}`, explanation: 'Homebrew formula ownership; manual package-manager update only.' };
  if (packageInfo) {
    const marker = `${sep}node_modules${sep}`;
    const root = packageInfo.directory.slice(0, packageInfo.directory.lastIndexOf(marker));
    if (root.endsWith(`${sep}lib`)) return { ownership: 'npm-global', action: `npm install --global --prefix ${quote(dirname(root))} ${quote(`${spec.package}@${version}`)}`, explanation: 'User/global npm prefix, not runner-owned; exact pinned action is informational only.' };
    const manager = (await readJson(join(root, 'package.json'), {})).packageManager ?? '';
    if (manager.startsWith('bun@') || root.endsWith('/.bun/install/global')) return { ownership: 'bun', action: `bun add --cwd ${quote(root)} --exact ${quote(`${spec.package}@${version}`)}`, explanation: 'User Bun prefix, not runner-owned; manual exact-version action only.' };
    if (manager.startsWith('pnpm@')) return { ownership: 'pnpm', action: `pnpm --dir ${quote(root)} add --save-exact ${quote(`${spec.package}@${version}`)}`, explanation: 'User pnpm package, not runner-owned; manual action only.' };
    if (manager.startsWith('yarn@')) return { ownership: 'yarn', action: `yarn --cwd ${quote(root)} add --exact ${quote(`${spec.package}@${version}`)}`, explanation: 'User Yarn package, not runner-owned; manual action only.' };
    return { ownership: 'npm-local', action: `npm install --prefix ${quote(root)} --save-exact ${quote(`${spec.package}@${version}`)}`, explanation: 'User npm installation, not runner-owned; manual exact-version action only.' };
  }
  if (harness === 'claude-code' && path.includes('/claude/versions/')) return { ownership: 'claude-native', action: `${quote(path)} install ${quote(version)}`, explanation: 'Personal Claude native installation; only its owner may update it.' };
  return { ownership: 'unknown', action: `${quote(path)} --help`, explanation: 'Unmanaged executable with unknown installer; identify its owner/package manager using the command shown before changing it.' };
}
export async function checkToolUpdates(config, accounts = [], dependencies = {}) {
  const run = (file, args, options) => (dependencies.command ?? command)(file, args, { ...options, signal: dependencies.signal });
  const fetcher = dependencies.fetch ?? fetch, findExecutable = dependencies.executable ?? executable;
  const selectedHarness = harness => !dependencies.harnesses || dependencies.harnesses.includes(harness);
  const bindings = [...accounts.map(value => value.binding), ...(config.accounts ?? [])];
  for (const harness of config.managedTools?.tools ?? []) {
    const spec = TOOL_PACKAGES[harness];
    if (spec) bindings.push({ harness, executable: join(config.managedTools.root, harness, 'current/node_modules/.bin', spec.bin) });
  }
  for (const [harness, spec] of Object.entries(TOOL_PACKAGES)) if (selectedHarness(harness) && !bindings.some(binding => binding.harness === harness)) bindings.push({ harness, executable: await findExecutable(spec.bin) });
  const seen = new Set(), metadata = new Map(), plans = [];
  for (const binding of bindings) {
    dependencies.signal?.throwIfAborted();
    const spec = TOOL_PACKAGES[binding.harness]; if (!spec || !selectedHarness(binding.harness)) continue;
    const selected = await findExecutable(binding.executable ?? spec.bin); if (!selected) continue;
    const key = `${binding.harness}:${selected}`; if (seen.has(key)) continue; seen.add(key);
    const component = `${binding.harness}:${hash(selected).slice(0, 10)}`;
    const source = registryUrl(spec.package), checkedAt = Date.now();
    let scratch, currentVersion, ownership = 'unknown';
    try {
      const path = await realpath(selected), managed = await managedInstallation(config, binding.harness, selected);
      ownership = managed ? 'origin-runner' : path.startsWith('/nix/store/') ? 'nix' : 'unmanaged';
      const packageInfo = await packageLocation(path, spec.package);
      currentVersion = managed?.manifest.version ?? packageInfo?.manifest.version;
      if (typeof currentVersion !== 'string' || currentVersion.length > 64) currentVersion = undefined;
      if (managed && packageInfo?.manifest.version !== managed.manifest.version) throw new Error('Managed package contents and ownership manifest disagree');
      if (!currentVersion) {
        scratch = await mkdtemp(join(tmpdir(), 'origin-tool-version-'));
        const result = await run(selected, ['--version'], { cwd: scratch, env: await privateEnvironment(scratch), timeoutMs: 15000, maxOutput: 65536 });
        currentVersion = result.stdout.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
      }
      if (!metadata.has(binding.harness)) metadata.set(binding.harness, fetchToolMetadata(binding.harness, fetcher, dependencies.signal));
      const latest = await metadata.get(binding.harness);
      const owner = managed ? { ownership: 'origin-runner', explanation: 'Explicit private runner-managed immutable prefix; idle supervised apply and rollback supported.', action: `origin-runner update --tools --tool ${binding.harness} --approve` } : await ownershipAction(binding.harness, path, latest.version, packageInfo, run);
      dependencies.signal?.throwIfAborted();
      const newer = stable(currentVersion) && compareVersions(latest.version, currentVersion) > 0;
      const compatible = compatibleStable(currentVersion, latest.version);
      const quarantine = managed && await quarantinedRelease(config, binding.harness, latest.version);
      const report = { component, ...(currentVersion ? { currentVersion } : {}), availableVersion: latest.version, status: quarantine ? 'failed' : !stable(currentVersion) ? 'unknown' : newer ? 'available' : 'current', checkedAt, message: `Source: ${source} (latest stable). Ownership: ${owner.ownership}. ${owner.explanation} Action: ${owner.action}${quarantine ? ' Version quarantined after failed/interrupted apply or explicit rollback; no retry.' : newer && !compatible ? ' Compatibility boundary: explicit local owner approval required.' : ''}` };
      plans.push({ harness: binding.harness, selected, managed, latest, compatible, report });
    } catch (error) {
      if (error.processStopUnproven || dependencies.signal?.aborted) throw error;
      plans.push({ harness: binding.harness, selected, report: { component, ...(currentVersion ? { currentVersion } : {}), status: 'unknown', checkedAt, message: new Redactor([config.hostToken]).text(`Source: ${source}. Ownership: ${ownership}. Could not establish a safe stable update: ${error.message}`) } });
    } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }
  for (const plan of plans) plan.report = boundedUpdateReports([plan.report], [config.hostToken])[0];
  return plans;
}
async function fenceMaintenance(config, error) {
  if (error.processStopUnproven || error.maintenanceUncertain) await atomicJson(join(config.dataDirectory, 'tool-maintenance-fence.json'), { at: Date.now(), message: 'Tool maintenance cannot prove process stop or rollback. Operator recovery required before another job.' });
}
async function assertMaintenanceOwner(config) {
  await assertIdleState(config);
  const worker = await readJson(join(config.dataDirectory, 'worker.lock'), {});
  const tools = await readJson(join(config.dataDirectory, 'tool-update.lock'), {});
  if (worker.pid !== process.pid || tools.pid !== process.pid || (await readJson(join(config.dataDirectory, 'status.json'), {})).activeRunId) throw new Error('Managed tool mutation requires exclusive ownership of the idle worker and tool locks');
}
async function pointTool(home, release, signal) {
  const temporary = join(home, `current-${randomUUID()}`);
  await symlink(release, temporary);
  try { signal?.throwIfAborted(); await rename(temporary, join(home, 'current')); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}
async function preflight(harness, release, manifest, run, scratch, signal) {
  const binary = join(release, manifest.executable), env = await privateEnvironment(scratch);
  if (!inside(release, await realpath(binary))) throw new Error('Staged executable escapes its release');
  signal?.throwIfAborted();
  const version = await run(binary, ['--version'], { cwd: scratch, env, timeoutMs: 30000, maxOutput: 65536, signal });
  if (!new RegExp(`(?:^|\\s|v)${manifest.version.replaceAll('.', '\\.')}(?:\\s|$)`).test(version.stdout)) throw new Error('Staged native version does not match its pinned stable manifest');
  signal?.throwIfAborted();
  const help = await run(binary, ['--help'], { cwd: scratch, env, timeoutMs: 30000, maxOutput: 1024 * 1024, signal });
  signal?.throwIfAborted();
  for (const flag of TOOL_PACKAGES[harness].flags) if (!help.stdout.includes(flag)) throw new Error(`Staged native CLI lacks required interface ${flag}`);
}
async function materializeClaude(release, version) {
  const suffix = `${process.platform}-${process.arch}${process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? '-musl' : ''}`;
  const native = join(release, 'node_modules', `@anthropic-ai/claude-code-${suffix}`);
  const manifest = await readJson(join(native, 'package.json'));
  if (manifest.name !== `@anthropic-ai/claude-code-${suffix}` || manifest.version !== version) throw new Error('Claude native platform package does not match the pinned stable version');
  const target = join(release, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe');
  if ((await lstat(target)).isSymbolicLink()) throw new Error('Claude native target must not redirect out of its package');
  if (!inside(release, await realpath(target)) || !inside(release, await realpath(join(native, 'claude')))) throw new Error('Claude native materialization must stay within the staged release');
  await copyFile(join(native, 'claude'), target); await chmod(target, 0o700);
}
async function stageManagedTool(harness, latest, stage, run, scratch, dependencies) {
  dependencies.signal?.throwIfAborted();
  await mkdir(stage, { mode: 0o700 });
  const npm = dependencies.npm ?? await executable('npm'); if (!npm) throw new Error('npm is required for private runner-managed tool releases');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, dependencies: { [latest.name]: latest.version } }), { mode: 0o600 });
  await run(npm, ['install', '--prefix', stage, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry', 'https://registry.npmjs.org'], { cwd: stage, env: await privateEnvironment(scratch), timeoutMs: 600000, maxOutput: 1024 * 1024, signal: dependencies.signal });
  dependencies.signal?.throwIfAborted();
  const lock = await readJson(join(stage, 'package-lock.json')), pinned = lock.packages?.[`node_modules/${latest.name}`];
  if (pinned?.version !== latest.version || pinned.integrity !== latest.dist.integrity) throw new Error('Installed package lock does not match the checked stable integrity');
  for (const [path, dependency] of Object.entries(lock.packages ?? {})) {
    if (!path || dependency.inBundle) continue;
    const source = new URL(dependency.resolved ?? '');
    if (source.origin !== 'https://registry.npmjs.org' || source.username || source.password || source.hash || source.search || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dependency.integrity ?? '')) throw new Error('Native dependency is not integrity-pinned to the approved registry');
  }
  if (harness === 'claude-code') await materializeClaude(stage, latest.version);
  const manifest = { schemaVersion: 1, managedBy: 'origin-runner', harness, package: latest.name, version: latest.version, integrity: latest.dist.integrity, executable: `node_modules/.bin/${TOOL_PACKAGES[harness].bin}`, source: registryUrl(latest.name), installedAt: Date.now() };
  await atomicJson(join(stage, 'release.json'), manifest);
  await preflight(harness, stage, manifest, run, scratch, dependencies.signal);
  return manifest;
}
export async function initializeManagedTool(config, harness, approved, dependencies = {}) {
  if (!approved || !TOOL_PACKAGES[harness]) throw new Error('Initialization requires an explicit --tool and --approve');
  return withMaintenanceLock(config, () => initializeManagedToolLocked(config, harness, dependencies));
}
export async function initializeManagedAccount(config, configPath, harness, accountId, approved, dependencies = {}) {
  if (!approved || !TOOL_PACKAGES[harness] || !accountId) throw new Error('Initialization requires --tool HARNESS --account LOCAL_ID --approve');
  return withMaintenanceLock(config, async () => {
    const info = await lstat(configPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Runner configuration must be an owner-only local regular file');
    const current = await (dependencies.readConfig ?? readJson)(configPath);
    current.dataDirectory = resolve(current.dataDirectory ?? config.dataDirectory);
    if (current.dataDirectory !== resolve(config.dataDirectory)) throw new Error('Runner data directory changed; retry initialization using the current configuration');
    const bindings = current.accounts?.length ? current.accounts : (await (dependencies.discover ?? discoverAccounts)(current)).map(value => value.binding);
    const selected = bindings.filter(binding => binding.id === accountId && binding.harness === harness);
    if (selected.length !== 1) throw new Error('Choose exactly one existing local account binding for the selected tool');
    const initialized = await initializeManagedToolLocked(current, harness, dependencies);
    // Read, select and persist under the same lock. Never copy or alter auth profiles.
    current.accounts = bindings.map(binding => binding === selected[0] ? { ...binding, executable: initialized.executable } : binding);
    current.managedTools = initialized.managedTools;
    dependencies.signal?.throwIfAborted();
    await atomicJson(configPath, current);
    return initialized;
  });
}
async function initializeManagedToolLocked(config, harness, dependencies) {
    await assertMaintenanceOwner(config);
    dependencies.signal?.throwIfAborted();
    const root = resolve(config.dataDirectory, 'tools');
    const managedTools = { schemaVersion: 1, root, tools: [...new Set([...(config.managedTools?.tools ?? []), harness])] };
    if (config.managedTools && (config.managedTools.schemaVersion !== 1 || resolve(config.managedTools.root ?? '') !== root)) throw new Error('Refusing to adopt a nonprivate managed prefix');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const proposed = { ...config, managedTools };
    await managedRoot(proposed);
    const home = join(root, harness);
    const existing = await managedInstallation(proposed, harness);
    if (existing) {
      if (await quarantinedRelease(config, harness, existing.manifest.version)) throw new Error('Existing native release is quarantined; refusing to select an unconfirmed initializer');
      return { managedTools, executable: existing.executable, version: existing.manifest.version };
    }
    // A pre-existing unmarked home is not ownership consent; never adopt its executables.
    try {
      await mkdir(home, { mode: 0o700 });
      await atomicJson(join(home, 'owner.json'), { schemaVersion: 1, managedBy: 'origin-runner', harness });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(home);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Refusing to adopt a redirected or nonprivate native tool home');
      const owner = await readJson(join(home, 'owner.json'), null);
      if (owner?.schemaVersion !== 1 || owner.managedBy !== 'origin-runner' || owner.harness !== harness) throw new Error('Refusing to adopt an existing unmarked native tool home');
    }
    await mkdir(join(home, 'releases'), { recursive: true, mode: 0o700 });
    for (const path of [home, join(home, 'releases')]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()) || await realpath(path) !== path) throw new Error('Managed tool directories must be private, local and nonredirecting');
    }
    const latest = await fetchToolMetadata(harness, dependencies.fetch ?? fetch, dependencies.signal);
    if (await quarantinedRelease(config, harness, latest.version)) throw new Error('This native version is quarantined; initialization will not retry it');
    const stage = join(home, 'releases', `.stage-${randomUUID()}`), release = join(home, 'releases', latest.version);
    const scratch = await mkdtemp(join(tmpdir(), 'origin-tool-initialize-')), run = dependencies.command ?? command;
    let switched = false;
    await quarantineRelease(config, harness, latest.version, 'Initialization started; success not yet proven');
    try {
      const manifest = await stageManagedTool(harness, latest, stage, run, scratch, dependencies);
      await mkdir(release, { mode: 0o700 }); await rename(stage, release);
      await assertMaintenanceOwner(config);
      await atomicJson(join(home, 'pending-update.json'), { previous: null, next: release, version: latest.version });
      await pointTool(home, release, dependencies.signal); switched = true;
      await preflight(harness, release, manifest, run, scratch, dependencies.signal);
      await quarantineRelease(config, harness, latest.version, null);
      await rm(join(home, 'pending-update.json'), { force: true });
      return { managedTools, executable: join(home, 'current', manifest.executable), version: latest.version };
    } catch (error) {
      await quarantineRelease(config, harness, latest.version, 'Initialization failed; personal executable untouched');
      if (switched) await rm(join(home, 'current'), { force: true });
      await rm(join(home, 'pending-update.json'), { force: true });
      await rm(stage, { recursive: true, force: true });
      throw error;
    } finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function applyManagedTool(config, plan, dependencies = {}) {
  if (!plan.managed || !plan.latest || plan.report.status !== 'available') throw new Error('Only an available, explicitly runner-managed stable tool may be applied');
  dependencies.signal?.throwIfAborted();
  await assertMaintenanceOwner(config);
  const run = dependencies.command ?? command;
  const current = await managedInstallation(config, plan.harness, plan.selected);
  if (!current || current.release !== plan.managed.release) throw new Error('Managed tool changed after update discovery');
  const latest = validateToolMetadata(plan.harness, plan.latest);
  if (compareVersions(latest.version, current.manifest.version) <= 0) throw new Error('Managed updates must be newer; explicit rollback is required for downgrades');
  if (await quarantinedRelease(config, plan.harness, latest.version)) throw new Error('Native release is quarantined; rejected versions are not retried');
  const release = join(current.home, 'releases', latest.version), stage = join(current.home, 'releases', `.stage-${randomUUID()}`);
  const previousBackup = await readJson(join(current.home, 'rollback.json'), null);
  let promoted = false, switched = false, backupWritten = false;
  const scratch = await mkdtemp(join(tmpdir(), 'origin-tool-preflight-'));
  await quarantineRelease(config, plan.harness, latest.version, 'Apply started; success not yet proven');
  try {
    const manifest = await stageManagedTool(plan.harness, latest, stage, run, scratch, dependencies);
    // Reserve the immutable destination; never overwrite an older failed/retained release.
    await mkdir(release, { mode: 0o700 });
    await rename(stage, release); promoted = true;
    await atomicJson(join(current.home, 'rollback.json'), { schemaVersion: 1, harness: plan.harness, previous: current.release, next: release, appliedAt: Date.now() });
    backupWritten = true;
    await atomicJson(join(current.home, 'pending-update.json'), { previous: current.release, next: release, version: latest.version, previousBackup });
    await assertMaintenanceOwner(config);
    await pointTool(current.home, release, dependencies.signal); switched = true;
    await preflight(plan.harness, release, manifest, run, scratch, dependencies.signal);
    await quarantineRelease(config, plan.harness, latest.version, null);
    await rm(join(current.home, 'pending-update.json'), { force: true });
    return boundedUpdateReports([{ ...plan.report, currentVersion: latest.version, status: 'current', checkedAt: Date.now(), message: `Source: ${registryUrl(latest.name)}. Ownership: origin-runner. Applied exact stable ${latest.version} idle; integrity and native version/help preflight passed. Prior release preserved. Rollback: origin-runner update --tools --tool ${plan.harness} --rollback --approve` }], [config.hostToken])[0];
  } catch (error) {
    await quarantineRelease(config, plan.harness, latest.version, 'Apply failed; previous release retained/restored');
    if (switched) {
      try { await pointTool(current.home, current.release); if (!error.processStopUnproven && !dependencies.signal?.aborted) await preflight(plan.harness, current.release, current.manifest, run, scratch); }
      catch (cause) { throw Object.assign(new Error('Managed tool rollback could not be proven; host must remain fenced'), { maintenanceUncertain: true, cause }); }
    }
    if (backupWritten) {
      if (previousBackup) await atomicJson(join(current.home, 'rollback.json'), previousBackup);
      else await rm(join(current.home, 'rollback.json'), { force: true });
    }
    await rm(join(current.home, 'pending-update.json'), { force: true });
    if (promoted) await rename(release, join(current.home, 'releases', `.failed-${latest.version}-${randomUUID()}`));
    if (!promoted) await rm(stage, { recursive: true, force: true });
    throw error;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function recoverManagedToolUpdates(config, dependencies = {}) {
  if (!config.managedTools) return;
  await withMaintenanceLock(config, async () => {
    const root = await managedRoot(config);
    for (const harness of Object.keys(TOOL_PACKAGES)) {
      const home = join(root, harness), path = join(home, 'pending-update.json'), pending = await readJson(path, null);
      if (!pending) continue;
      const current = await managedInstallation(config, harness);
      if (pending.previous === null) {
        if (current && current.release !== pending.next) throw Object.assign(new Error('Interrupted initializer no longer owns the selected release'), { maintenanceUncertain: true });
        await quarantineRelease(config, harness, pending.version, 'Interrupted initializer; unconfirmed executable deselected');
        await rm(join(home, 'current'), { force: true });
        await rm(path, { force: true });
        continue;
      }
      const previous = await realpath(pending.previous);
      if (!current || dirname(previous) !== join(home, 'releases') || ![previous, pending.next].includes(current.release)) throw Object.assign(new Error('Interrupted native update has an invalid rollback record'), { maintenanceUncertain: true });
      const manifest = validateManagedManifest(harness, await readJson(join(previous, 'release.json')));
      if (previous !== join(home, 'releases', manifest.version)) throw Object.assign(new Error('Interrupted native rollback version mismatch'), { maintenanceUncertain: true });
      const scratch = await mkdtemp(join(tmpdir(), 'origin-tool-recovery-'));
      try {
        await quarantineRelease(config, harness, pending.version, 'Interrupted cutover; previous release restored');
        await preflight(harness, previous, manifest, dependencies.command ?? command, scratch, dependencies.signal);
        await pointTool(home, previous);
        if (pending.previousBackup) await atomicJson(join(home, 'rollback.json'), pending.previousBackup);
        else await rm(join(home, 'rollback.json'), { force: true });
        await rm(path, { force: true });
      } catch (cause) {
        if (dependencies.signal?.aborted && !cause.processStopUnproven) throw cause;
        throw Object.assign(new Error('Interrupted native rollback could not be proven'), { maintenanceUncertain: true, cause });
      }
      finally { await rm(scratch, { recursive: true, force: true }); }
    }
  });
}
export async function maintainTools(config, accounts, { apply = false, harness, harnesses, automatic = false, approveBoundary = !automatic } = {}, dependencies = {}) {
  if (harness && !TOOL_PACKAGES[harness]) throw new Error('Unknown native tool');
  if (harnesses?.length === 0) return [];
  let plans;
  try { plans = await checkToolUpdates(config, accounts, { ...dependencies, harnesses: harnesses ?? (harness ? [harness] : undefined) }); }
  catch (error) { await fenceMaintenance(config, error); throw error; }
  if (!apply) return boundedUpdateReports(plans.map(plan => plan.report), [config.hostToken]);
  return withMaintenanceLock(config, async () => {
    const reports = [];
    for (const plan of plans) {
      dependencies.signal?.throwIfAborted();
      if (!plan.managed || plan.report.status !== 'available' || (!approveBoundary && !plan.compatible)) { reports.push(plan.report); continue; }
      try { reports.push(await applyManagedTool(config, plan, dependencies)); }
      catch (error) {
        if (error.processStopUnproven || error.maintenanceUncertain || dependencies.signal?.aborted) throw error;
        reports.push({ ...plan.report, status: 'failed', message: new Redactor([config.hostToken]).text(`${plan.report.message} Apply failed; prior release retained/restored: ${error.message}`) });
      }
    }
    return boundedUpdateReports(reports, [config.hostToken]);
  });
}
export async function rollbackManagedTool(config, harness, approved, dependencies = {}) {
  if (!approved || !TOOL_PACKAGES[harness]) throw new Error('Tool rollback requires --tool <harness> --approve');
  return withMaintenanceLock(config, async () => {
    const current = await managedInstallation(config, harness); if (!current) throw new Error('No explicitly runner-managed installation');
    const backup = await readJson(join(current.home, 'rollback.json'));
    const previous = await realpath(backup.previous);
    if (backup.schemaVersion !== 1 || backup.harness !== harness || backup.next !== current.release || dirname(previous) !== join(current.home, 'releases')) throw new Error('Rollback record does not bind the current and prior immutable releases');
    const manifest = validateManagedManifest(harness, await readJson(join(previous, 'release.json')));
    if (previous !== join(current.home, 'releases', manifest.version)) throw new Error('Rollback version mismatch');
    const scratch = await mkdtemp(join(tmpdir(), 'origin-tool-rollback-'));
    try {
      await preflight(harness, previous, manifest, dependencies.command ?? command, scratch);
      await assertMaintenanceOwner(config);
      await quarantineRelease(config, harness, current.manifest.version, 'Explicit owner rollback; no automatic reapply');
      await atomicJson(join(current.home, 'rollback.json'), { schemaVersion: 1, harness, previous: current.release, next: previous, appliedAt: Date.now() });
      try {
        await pointTool(current.home, previous);
        await preflight(harness, previous, manifest, dependencies.command ?? command, scratch);
      } catch (error) {
        try {
          await pointTool(current.home, current.release);
          await atomicJson(join(current.home, 'rollback.json'), backup);
          if (!error.processStopUnproven) await preflight(harness, current.release, current.manifest, dependencies.command ?? command, scratch);
        } catch (cause) { throw Object.assign(new Error('Explicit tool rollback recovery could not be proven; host must remain fenced'), { maintenanceUncertain: true, cause }); }
        throw error;
      }
      return { component: harness, currentVersion: manifest.version, status: 'current', checkedAt: Date.now(), message: 'Explicit idle rollback to a preserved runner-managed release; native preflight passed.' };
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
}
