import { command } from './process.mjs';
import { baseEnvironment } from './security.mjs';

// Reviewed preview, never a moving snapshot channel.
export const REX_VERSION = '0.1.0-preview.13';
export const REX_SOCKET = '/var/lib/origin-runner/.local/state/origin-rex/server.sock';
export function rexCommand(config) {
  const executable = config.rex?.executable ?? 'rex';
  if (typeof executable !== 'string' || executable !== 'rex' && !executable.startsWith('/')) throw Error('Rex executable must be an absolute local path');
  const server = config.rex?.server;
  if (server !== undefined && (typeof server !== 'string' || !/^unix:\/\/\/[^\x00-\x20]+$/.test(server))) throw Error('Rex requires a private local Unix socket');
  return { executable, args: ['--autostart=false', ...(server ? ['--server', server] : [])] };
}
export function rexEnvironment() {
  const env = baseEnvironment();
  for (const key of ['XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
export async function rexStatus(config, launch = command) {
  const { executable, args } = rexCommand(config);
  const options = { env: rexEnvironment(), timeoutMs: 10000, maxOutput: 32768 };
  const version = (await launch(executable, ['version'], options)).stdout.trim();
  if (!version.startsWith(`rex ${REX_VERSION}\n`)) throw Error('Install the reviewed Rex preview');
  const status = JSON.parse((await launch(executable, [...args, 'server', 'status', '--json'], options)).stdout);
  if (status?.rex_version !== REX_VERSION || typeof status.instance_id !== 'string' || status.you?.transport !== 'unix') throw Error('Pinned private Rex server unavailable');
  return { version: REX_VERSION, status: 'ready' };
}
