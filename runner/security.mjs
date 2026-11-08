import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, readFile, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export const VERSION = '1.2.1';
export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener('abort', abort, { once: true });
});
export const hash = value => createHash('sha256').update(value).digest('hex');
export const defaultConfig = () => resolve(homedir(), '.config/origin-runner/config.json');
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, path);
  await chmod(path, 0o600);
}
export function controllerEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('Controller URL must not contain credentials, query, or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Controller requires HTTPS (HTTP allowed only on loopback)');
  return new URL('/api/execution/worker', url).href;
}
export function baseEnvironment(extra = {}) {
  const result = {};
  for (const key of ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SHELL', 'TMPDIR', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NIX_SSL_CERT_FILE']) {
    if (process.env[key]) result[key] = process.env[key];
  }
  return { ...result, ...extra };
}
const forbiddenEnvironment = /^(?:ORIGIN_|NODE_OPTIONS$|NODE_PATH$|LD_|DYLD_|BASH_ENV$|ENV$|SHELLOPTS$|PATH$|HOME$|GIT_)/;
export function scopedEnvironment(values = {}) {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || forbiddenEnvironment.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error(`Disallowed environment variable: ${key}`);
  }
  return { ...values };
}
export class Redactor {
  constructor(secrets = []) {
    this.secrets = [];
    this.add(...secrets);
  }
  add(...secrets) {
    this.secrets = [...new Set([...this.secrets, ...secrets.filter(value => typeof value === 'string' && value.length).flatMap(value => [value, ...value.split(/\r?\n/).filter(Boolean), encodeURIComponent(value), Buffer.from(value).toString('base64'), JSON.stringify(value).slice(1, -1)])])].sort((a, b) => b.length - a.length);
  }
  text(value) {
    let text = String(value);
    for (const secret of this.secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/\bBearer\s+[^\s"'\\]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]{15,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
      .replace(/((?:access_token|refresh_token|api_key|password|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
  }
  containsSecret(value) {
    const text = String(value);
    // Source code may legitimately mention header/key names and variable references.
    // Unlike log redaction, a push gate must match actual values, not those names.
    return this.secrets.some(secret => text.includes(secret))
      || /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]{15,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/.test(text)
      || /https?:\/\/[A-Za-z0-9%._~-]+:[A-Za-z0-9%._~!$&()*+,;=:-]+@/.test(text);
  }
  value(value) {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map(item => this.value(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:access_token|refresh_token|api_key|password|authorization)$/i.test(key) ? '[REDACTED]' : this.value(item)]));
    return value;
  }
  // Never emit an incomplete line: a secret can span arbitrary pipe chunks.
  stream(emit, maxLine = 65536) {
    let pending = '', dropping = false;
    return { push: chunk => {
      const pieces = String(chunk).split('\n');
      for (let i = 0; i < pieces.length; i++) {
        if (!dropping) pending += pieces[i];
        if (pending.length > maxLine) { pending = ''; dropping = true; }
        if (i < pieces.length - 1) { emit(dropping ? '[oversized log line omitted]\n' : `${this.text(pending)}\n`); pending = ''; dropping = false; }
      }
    }, end: () => { if (pending || dropping) emit(dropping ? '[oversized log line omitted]' : this.text(pending)); pending = ''; dropping = false; } };
  }
}
export class RunError extends Error {
  constructor(result, message) { super(message); this.result = result; }
}
export function classifyFailure(error) {
  if (error instanceof RunError) return error.result;
  const code = error?.codexErrorInfo ?? error?.code;
  const status = error?.httpStatus ?? error?.api_error_status ?? code?.httpConnectionFailed?.httpStatusCode ?? code?.responseStreamConnectionFailed?.httpStatusCode;
  if (code === 'usageLimitExceeded' || code === 'insufficient_quota') return 'quota';
  switch (code) {
    case 'unauthorized':
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'account_on_hold':
    case 'billing_error': return 'needs_auth';
    case 'overloaded':
    case 'server_error': return 'provider_unavailable';
  }
  if (status === 401 || status === 402 || status === 403) return 'needs_auth';
  if (status === 502 || status === 503 || status === 504 || status === 529) return 'provider_unavailable';
  // Generic 429, unknown/stale quota, and free-text messages are NOT proof of exhaustion.
  return 'failed';
}
