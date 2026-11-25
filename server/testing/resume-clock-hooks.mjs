// Loaded with --import in isolated fixtures when OMB_TEST_RESUME_CLOCK=1: writing a number of milliseconds to
// <data dir>/resume-clock-ms moves Date.now() on by that much, as waking a suspended machine does. Timers carry on from
// where they were, as they do across a suspend (server/due-timer.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const dataDir = process.env.OMB_DATA_DIR;
if (!dataDir || dataDir !== process.env.HOME || process.env.OMB_TEST_RESUME_CLOCK !== '1') {
  throw new Error('The resume clock requires an explicitly isolated fixture');
}
const marker = join(dataDir, 'resume-clock-ms');
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
setInterval(() => {
  try { skew = Number(readFileSync(marker, 'utf8')) || 0; } catch { /* not resumed yet */ }
}, 20).unref();
