import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { hash, baseEnvironment, RunError, readJson } from './security.mjs';
import { ManagedProcess, JsonRpc, command, jsonLines, ompJsonLines } from './process.mjs';

export async function executable(name) {
  const paths = isAbsolute(name) ? [name] : (process.env.PATH ?? '').split(':').map(directory => join(directory, name));
  for (const path of paths) { try { await access(path, constants.X_OK); return path; } catch {} }
  return null;
}
export function accountEnvironment(binding) {
  const env = baseEnvironment();
  if (binding.harness === 'codex') env.CODEX_HOME = binding.directory ?? join(homedir(), '.codex');
  if (binding.harness === 'claude-code') { if (binding.directory) env.CLAUDE_CONFIG_DIR = binding.directory; env.DISABLE_AUTOUPDATER = '1'; }
  if (binding.harness === 'pi') env.PI_CODING_AGENT_DIR = binding.directory ?? join(homedir(), '.pi/agent');
  if (binding.harness === 'omp' && binding.profile) env.OMP_PROFILE = binding.profile;
  if (binding.harness === 'omp' && binding.directory) env.PI_CODING_AGENT_DIR = binding.directory;
  return env;
}
export const providerName = value => ['openai-codex', 'codex', 'openai'].includes(value) ? 'openai' : value;
export function identityHash(provider, identity) {
  // Same provider/email/org tuple across CLI implementations and machines. No credential digest.
  const email = identity.email?.trim().toLowerCase();
  const id = identity.accountId ?? identity.id;
  if (!email && !id) return null;
  return hash(JSON.stringify([providerName(provider), email ?? id, identity.orgId ?? identity.organizationId ?? '', identity.projectId ?? '']));
}
export function codexIdentity(response, binding) {
  const account = response.account;
  if (account?.type === 'apiKey') return binding.identity;
  const workspace = response.workspaceRouting?.chatgptAccountId;
  if (account?.type !== 'chatgpt' || typeof workspace !== 'string' || !workspace || !account.email?.trim()) return undefined;
  return { email: account.email, orgId: workspace };
}
export function codexQuota(payload, observedAt = Date.now()) {
  const buckets = payload.rateLimitsByLimitId ?? (payload.rateLimits ? { [payload.rateLimits.limitId ?? 'codex']: payload.rateLimits } : {});
  const windows = [];
  for (const [id, bucket] of Object.entries(buckets)) {
    for (const key of ['primary', 'secondary']) {
      const window = bucket?.[key];
      if (!window || !Number.isFinite(window.usedPercent)) continue;
      windows.push({ id: `${id}:${key}`, label: `${bucket.limitName ?? id} ${key}`, scope: id === 'codex' ? 'account' : 'unknown', usedPercent: window.usedPercent, resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt * 1000 : null, ...(Number.isFinite(window.windowDurationMins) ? { durationMinutes: window.windowDurationMins } : {}) });
    }
  }
  return { status: windows.length ? 'available' : 'unknown', observedAt, windows };
}
export function confirmedExhausted(quota, now = Date.now(), model) {
  return quota?.status === 'available' && quota.observedAt <= now + 5000 && now - quota.observedAt < 120000 && quota.windows.some(window => (window.scope === 'account' || (window.scope === 'model' && window.modelIds?.includes(model))) && window.usedPercent >= 100 && (window.resetsAt === null || window.resetsAt > now));
}
export function unknownQuota(error) { return { status: error ? 'error' : 'unknown', observedAt: Date.now(), windows: [], ...(error ? { error: 'Native usage telemetry unavailable' } : {}) }; }
export function freshReport(report, now = Date.now()) {
  return report.quota.status === 'available' && now - report.quota.observedAt > 120000 ? { ...report, quota: { ...report.quota, status: 'stale' } } : report;
}
function report(binding, provider, identity, authenticated, quota, models = [], plan) {
  const fingerprint = binding.identityHash ?? identityHash(provider, identity);
  return { id: binding.id, identityHash: fingerprint ?? hash(`unresolved:${binding.id}:${binding.directory ?? homedir()}`), provider: providerName(provider), label: binding.label ?? `${binding.harness} (${binding.profile ?? 'default'})`, authKind: binding.authKind ?? 'unknown', authenticated: Boolean(authenticated && fingerprint), harnesses: [binding.harness], models, quota, ...(plan ? { plan } : {}) };
}
export async function inspectCodex(binding) {
  const process = new ManagedProcess(binding.executable, ['app-server', '--listen', 'stdio://'], { env: accountEnvironment(binding) });
  process.child.stderr.resume();
  const rpc = new JsonRpc(process);
  try {
    await rpc.initialize();
    const response = await rpc.call('account/read', { refreshToken: false });
    const account = response.account, identity = codexIdentity(response, binding);
    let quota = unknownQuota();
    try { quota = codexQuota(await rpc.call('account/rateLimits/read')); } catch { quota = unknownQuota(true); }
    const models = []; let cursor;
    do {
      const page = await rpc.call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const model of page.data ?? []) models.push({ id: model.model ?? model.id, efforts: (model.supportedReasoningEfforts ?? []).map(value => value.reasoningEffort) });
      cursor = page.nextCursor;
    } while (cursor);
    binding.authKind = account?.type === 'apiKey' ? 'api' : account?.type === 'chatgpt' ? 'subscription' : 'unknown';
    return report(binding, 'openai', identity ?? {}, Boolean(account && identity), quota, models, account?.planType);
  } finally { await process.stop(); }
}
async function inspectClaude(binding) {
  const status = JSON.parse((await command(binding.executable, ['auth', 'status', '--json'], { env: accountEnvironment(binding), timeoutMs: 15000, allowFailure: true })).stdout || '{}');
  binding.authKind = status.authMethod === 'api_key' ? 'api' : status.authMethod === 'claude.ai' && status.apiProvider === 'firstParty' ? 'subscription' : binding.authKind ?? 'unknown';
  const identity = { ...binding.identity, email: status.email ?? binding.identity?.email, accountId: status.accountId, orgId: status.orgId ?? binding.identity?.orgId };
  const child = new ManagedProcess(binding.executable, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { env: accountEnvironment(binding), cwd: homedir() });
  child.child.stderr.resume();
  let models = binding.models ?? [];
  try {
    const init = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Claude catalog timeout')), 20000);
      jsonLines(child.child.stdout, frame => {
        if (frame.type !== 'control_response' || frame.response?.request_id !== 'origin-catalog') return;
        clearTimeout(timer);
        if (frame.response.subtype === 'error') reject(new Error('Claude catalog unavailable')); else resolve(frame.response.response);
      }, reject);
      child.exit.then(() => { clearTimeout(timer); reject(new Error('Claude catalog exited')); });
      child.send({ type: 'control_request', request_id: 'origin-catalog', request: { subtype: 'initialize' } }).catch(reject);
    });
    models = mergeModels((init.models ?? []).map(model => ({ id: model.value, ...(model.supportedEffortLevels ? { efforts: model.supportedEffortLevels } : {}) })), models);
  } catch { /* Supported telemetry absent: exact owner-configured catalog only. */ }
  finally { await child.stop(); }
  return report(binding, 'anthropic', identity, status.loggedIn, unknownQuota(), models, status.subscriptionType);
}
export function ompQuota(value) {
  const windows = [];
  for (const limit of value.limits ?? []) {
    const amount = limit.amount ?? {};
    const fraction = amount.usedFraction ?? (Number.isFinite(amount.used) && amount.limit > 0 ? amount.used / amount.limit : amount.unit === 'percent' && Number.isFinite(amount.used) ? amount.used / 100 : Number.isFinite(amount.remainingFraction) ? 1 - amount.remainingFraction : undefined);
    if (!Number.isFinite(fraction)) continue;
    windows.push({ id: limit.id, label: limit.label ?? limit.id, scope: limit.scope?.modelId ? 'model' : limit.scope?.shared === true ? 'account' : 'unknown', ...(limit.scope?.modelId ? { modelIds: [limit.scope.modelId, `${value.provider}/${limit.scope.modelId}`] } : {}), usedPercent: fraction * 100, resetsAt: limit.window?.resetsAt ?? null, ...(limit.window?.durationMs ? { durationMinutes: limit.window.durationMs / 60000 } : {}) });
  }
  return { status: windows.length ? 'available' : 'unknown', observedAt: value.fetchedAt ?? Date.now(), windows };
}
function mergeModels(native, configured) {
  const models = new Map(native.filter(value => typeof value.id === 'string').map(value => [value.id, value]));
  for (const model of configured) models.set(model.id, { ...models.get(model.id), ...model });
  return [...models.values()];
}
async function piCatalog(binding) {
  const omp = binding.harness === 'omp';
  const child = new ManagedProcess(binding.executable, ['--mode', 'rpc', '--no-session', '--no-extensions', ...(omp ? ['--no-ui'] : ['--no-mcp'])], { env: accountEnvironment(binding), cwd: homedir() });
  child.child.stderr.resume();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native catalog timed out')), 20000);
      const fail = error => { clearTimeout(timer); reject(error); };
      const receive = frame => {
        if (frame.id !== 'models') return;
        clearTimeout(timer);
        if (!frame.success) reject(new Error('Native catalog unavailable')); else resolve(frame.data?.models ?? []);
      };
      const request = () => child.send({ type: 'get_available_models', id: 'models' }).catch(fail);
      if (omp) ompJsonLines(child, receive, fail).then(request, fail);
      else { jsonLines(child.child.stdout, receive, fail); void request(); }
      child.exit.then(() => fail(new Error('Catalog exited')));
    });
  } finally { await child.stop(); }
}
function catalogModels(catalog, provider, configured = []) {
  return mergeModels(catalog.filter(model => model.provider === provider).map(model => ({ id: `${model.provider}/${model.id}`, ...(model.supportedThinkingLevels ? { efforts: model.supportedThinkingLevels } : {}) })), configured);
}
export function ompBillingKind(value) {
  if (value.type === 'api_key') return 'api';
  const includedWindows = value.provider === 'openai-codex' ? ['openai-codex:primary', 'openai-codex:secondary'] : value.provider === 'anthropic' ? ['anthropic:5h', 'anthropic:7d'] : [];
  return value.limits?.some(limit => includedWindows.includes(limit.id) && limit.amount?.unit === 'percent') ? 'subscription' : 'unknown';
}
async function inspectOmp(binding) {
  const payload = JSON.parse((await command(binding.executable, ['usage', '--json', '--no-extensions'], { env: accountEnvironment(binding), timeoutMs: 45000 })).stdout);
  const all = [...(payload.reports ?? []).map(value => ({ provider: value.provider, identity: { ...binding.identity, ...value.metadata }, authKind: ompBillingKind(value), quota: ompQuota(value) })), ...(payload.accountsWithoutUsage ?? []).map(value => ({ provider: value.provider, identity: { ...binding.identity, ...value }, authKind: ompBillingKind(value), quota: unknownQuota() }))];
  const selected = all.filter(value => !binding.provider || value.provider === binding.provider);
  let catalog = [];
  try { catalog = await piCatalog(binding); }
  catch (error) { if (error.processStopUnproven) throw error; }
  const results = [];
  for (const provider of new Set(selected.map(value => value.provider))) {
    const identities = new Map(selected.filter(value => value.provider === provider).map(value => [identityHash(provider, value.identity), value]));
    for (const [fingerprint, value] of identities) {
      const local = { ...binding, provider, authKind: value.authKind === 'unknown' ? binding.authKind ?? 'unknown' : value.authKind, ambiguous: identities.size !== 1, id: binding.provider ? binding.id : `${binding.id}:${provider}:${fingerprint?.slice(0, 12) ?? 'unknown'}` };
      if (local.ambiguous) local.label = `${binding.label ?? 'OMP'}: dedicated single-account profile required`;
      results.push({ binding: local, report: report(local, provider, value.identity, Boolean(fingerprint), value.quota, catalogModels(catalog, provider, binding.models)) });
    }
  }
  return results;
}
function credentialIdentity(credential) {
  let claims = {};
  // Local metadata decoding only, never log or serialize the underlying token.
  try { claims = JSON.parse(Buffer.from(credential.access.split('.')[1], 'base64url').toString('utf8')); } catch {}
  const profile = claims['https://api.openai.com/profile'] ?? {};
  const auth = claims['https://api.openai.com/auth'] ?? {};
  return { email: credential.email ?? profile.email ?? claims.email, accountId: credential.accountId ?? auth.chatgpt_account_id, orgId: credential.orgId };
}
async function inspectPi(binding) {
  const catalog = await piCatalog(binding);
  const auth = await readJson(join(accountEnvironment(binding).PI_CODING_AGENT_DIR, 'auth.json'), {});
  const providers = binding.provider ? [binding.provider] : Object.keys(auth);
  return providers.map(provider => {
    const credential = auth[provider];
    const identity = binding.identity ?? (credential ? credentialIdentity(credential) : {});
    const local = { ...binding, provider, id: binding.provider ? binding.id : `${binding.id}:${provider}`, authKind: credential?.type === 'api_key' ? 'api' : credential?.type === 'oauth' && ['openai', 'anthropic'].includes(provider) ? 'subscription' : binding.authKind ?? 'unknown' };
    return { binding: local, report: report(local, provider, identity, Boolean(credential), unknownQuota(), catalogModels(catalog, provider, binding.models)) };
  });
}
export async function discoverAccounts(config) {
  const defaults = ['codex', 'claude-code', 'omp', 'pi'].map(harness => ({ id: `${harness}:default`, harness }));
  const bindings = config.accounts?.length ? config.accounts.map(value => ({ ...value })) : defaults;
  const result = [];
  for (const binding of bindings) {
    binding.executable = await executable(binding.executable ?? (binding.harness === 'claude-code' ? 'claude' : binding.harness));
    if (!binding.executable || binding.harness === 't3') continue;
    try {
      const account = await ({ codex: inspectCodex, 'claude-code': inspectClaude, omp: inspectOmp, pi: inspectPi }[binding.harness])(binding);
      if (Array.isArray(account)) result.push(...account); else result.push({ binding, report: account });
    } catch (error) {
      if (error.processStopUnproven) throw error;
      result.push({ binding, report: report(binding, binding.provider ?? (binding.harness === 'claude-code' ? 'anthropic' : 'unknown'), binding.identity ?? {}, false, unknownQuota(true), binding.models ?? []) });
    }
  }
  return result;
}
export function selectAccount(accounts, selection, billingKind) {
  const account = accounts.find(value => value.report.id === selection.accountId && value.binding.harness === selection.harness);
  if (!account?.report.authenticated) throw new RunError('needs_auth', 'Selected account is not authenticated on this host');
  if (!['subscription', 'api'].includes(billingKind) || account.report.authKind !== billingKind) throw new RunError('needs_auth', 'Native billing type changed or is unknown; refresh account metadata before authorizing another run');
  if (account.binding.ambiguous) throw new RunError('needs_auth', 'Selected OMP account requires a dedicated single-account profile; native balancing is not an explicit account binding');
  if (confirmedExhausted(account.report.quota, Date.now(), selection.model)) throw new RunError('quota', 'Native telemetry confirms account quota exhaustion');
  const model = account.report.models?.find(value => value.id === selection.model);
  if (!model) throw new RunError('failed', 'Selected exact model is not in the native or explicitly configured model catalog');
  if (selection.effort && (!model.efforts || !model.efforts.includes(selection.effort))) throw new RunError('failed', 'Selected effort is not supported by this account/model');
  return account;
}
