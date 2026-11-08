#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { baseEnvironment, scopedEnvironment } from './security.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== '--file' || !args[1] || args[2] !== '--' || !args[3]) throw new Error('Use --file <protected environment.json> -- <command> [arguments]');
  const info = await lstat(args[1]);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()) || info.size > 1024 * 1024) throw new Error('Application environment must be an owner-only regular file');
  const variables = scopedEnvironment(JSON.parse(await readFile(args[1], 'utf8')));
  // No native CLI profile/config variables or controller tokens are inherited.
  // The application receives only its explicitly scoped project environment.
  const child = spawn(args[3], args.slice(4), { stdio: 'inherit', env: baseEnvironment(variables), detached: false });
  const terminate = signal => { if (!child.killed) child.kill(signal); };
  const onTerm = () => terminate('SIGTERM'), onInt = () => terminate('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { process.exitCode = code ?? 128 + (constants.signals[signal] ?? 1); resolve(); });
    });
  } finally { process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); }
}
await main().catch(() => { console.error('Origin application command failed: check its protected environment file and executable. No environment values were printed.'); process.exitCode = 1; });
