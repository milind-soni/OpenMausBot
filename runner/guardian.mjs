// Independent process-tree guardian. No controller/job/model credentials are inherited.
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const root = Number(process.argv[2]);
if (!Number.isInteger(root) || root < 2) process.exit(2);
const tracked = new Map();
let ending = false;
function snapshot() {
  const entries = [];
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        entries.push({ pid: Number(name), ppid: Number(fields[1]), group: Number(fields[2]), birth: fields[19], zombie: fields[0] === 'Z' });
      } catch {}
    }
  } else {
    const text = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat='], { encoding: 'utf8', timeout: 2000 });
    for (const line of text.trim().split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 9) continue;
      entries.push({ pid: Number(fields[0]), ppid: Number(fields[1]), group: Number(fields[2]), birth: fields.slice(3, 8).join(' '), zombie: fields[8].includes('Z') });
    }
  }
  return entries;
}
function collect() {
  const entries = snapshot();
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (entry.pid === process.pid || entry.pid < 2) continue;
      if ((entry.pid === root || entry.group === root || tracked.has(entry.ppid)) && !tracked.has(entry.pid)) { tracked.set(entry.pid, entry.birth); changed = true; }
    }
  }
  return entries.filter(entry => !entry.zombie && tracked.get(entry.pid) === entry.birth);
}
function send(pid, signal, group = false) { try { process.kill(group ? -pid : pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
function terminate(signal) {
  const current = collect();
  for (const entry of current.reverse()) send(entry.pid, signal);
  // Covers children which retained the group but outlived/reparented away from their leader.
  send(root, signal, true);
}
const tracker = setInterval(() => { try { collect(); } catch {} }, 500);
try { collect(); } catch {}
function finish(stopped) {
  if (process.connected) process.send({ stopped }, () => process.exit(stopped ? 0 : 1));
  else process.exit(stopped ? 0 : 1);
}
async function shutdown() {
  if (ending) return;
  ending = true; clearInterval(tracker);
  try {
    if (!collect().length) { finish(true); return; }
    terminate('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 1000));
    terminate('SIGKILL');
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!collect().length) { finish(true); return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    finish(false);
  } catch { finish(false); }
}
process.on('message', message => { if (message?.stop === true) void shutdown(); });
process.on('disconnect', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
