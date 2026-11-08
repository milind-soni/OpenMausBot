import { VERSION, hash, controllerEndpoint } from './security.mjs';
import { checkRunnerUpdate, boundedUpdateReports, updateRequestSignal } from './service.mjs';

export function validateControllerBundle(bundle) {
  if (!/^\d+\.\d+\.\d+$/.test(bundle.version) || !Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 100) throw new Error('Controller did not provide a stable versioned runner bundle');
  const seen = new Set(); let bytes = 0;
  for (const file of bundle.files) {
    if (!/^[A-Za-z0-9_-]+\.mjs$/.test(file.path) || seen.has(file.path) || typeof file.content !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || hash(file.content) !== file.sha256) throw new Error('Controller bundle file integrity or path validation failed');
    seen.add(file.path); bytes += Buffer.byteLength(file.content);
    if (bytes > 32 * 1024 * 1024) throw new Error('Runner bundle exceeds 32 MiB');
  }
  if (!seen.has('cli.mjs')) throw new Error('Controller bundle lacks runner entrypoint');
  const digest = hash(JSON.stringify(bundle.files.map(({ path, sha256 }) => ({ path, sha256 })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)));
  if (digest !== bundle.sha256) throw new Error('Controller bundle aggregate checksum mismatch');
  return bundle;
}
export async function fetchControllerBundle(config, fetcher = fetch, signal) {
  const url = new URL('/api/execution/runner', controllerEndpoint(config.controller));
  const response = await fetcher(url, { redirect: 'error', headers: { authorization: `Bearer ${config.hostToken}` }, signal: updateRequestSignal(signal, 30000) });
  if (!response.ok) throw new Error(`Controller runner bundle unavailable (${response.status})`);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { signal?.throwIfAborted(); bytes += chunk.length; if (bytes > 64 * 1024 * 1024) throw new Error('Controller bundle response too large'); chunks.push(chunk); }
  return validateControllerBundle(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
export function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}
export async function runnerUpdatePlan(config, dependencies = {}) {
  if (config.updates?.baseUrl && config.updates?.publicKeyFile) return checkRunnerUpdate(config, dependencies);
  const bundle = await fetchControllerBundle(config, dependencies.fetch ?? fetch, dependencies.signal);
  return { compatible: false, report: boundedUpdateReports([{ component: 'origin-runner', currentVersion: VERSION, availableVersion: bundle.version, status: compareVersions(bundle.version, VERSION) > 0 ? 'available' : 'current', checkedAt: Date.now(), message: 'Source: authenticated controller bundle (not release-signed). Check only: owner must configure updates.baseUrl and a trusted local publicKeyFile before application.' }], [config.hostToken])[0] };
}
export function automaticUpdatePolicy(config) {
  const policy = config.automaticUpdates;
  if (policy?.enabled !== true) return null;
  const intervalHours = policy.intervalHours ?? 24;
  if (policy.schemaVersion !== 1 || !Number.isFinite(intervalHours) || intervalHours < 1 || intervalHours > 168 || !Array.isArray(policy.tools) || policy.tools.some(tool => !['codex', 'claude-code', 'omp', 'pi'].includes(tool)) || typeof policy.runner !== 'boolean' || (!policy.runner && !policy.tools.length)) throw new Error('Invalid owner-local automatic update policy');
  return { ...policy, intervalHours };
}
export function automaticUpdateDue(config, state, now = Date.now()) {
  return Boolean(automaticUpdatePolicy(config) && (!state.nextCheckAt || now >= state.nextCheckAt));
}
