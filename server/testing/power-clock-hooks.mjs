// Loaded with --import in isolated fixtures when OMB_TEST_POWER_CLOCK=1: a Cloud home's idle windows (just woke, work
// ended, someone used it) last a quarter second instead of minutes, so a fixture can have the home agree to sleep
// without waiting. A pending sleep still lasts its two minutes. No authorization or dispatch decision changes.
import { registerHooks } from 'node:module';

const dataDir = process.env.OMB_DATA_DIR;
if (!dataDir || dataDir !== process.env.HOME || process.env.OMB_TEST_POWER_CLOCK !== '1') {
  throw new Error('The power clock requires an explicitly isolated fixture');
}
const power = new URL('../cloud-power.ts', import.meta.url).href;
const seams = [
  ['export const CLOUD_IDLE_ACTIVITY_MS = 10 * 60_000;', 'export const CLOUD_IDLE_ACTIVITY_MS = 250;'],
  ['export const CLOUD_IDLE_WORK_MS = 2 * 60_000;', 'export const CLOUD_IDLE_WORK_MS = 250;'],
  ['export const CLOUD_IDLE_AWAKE_MS = 2 * 60_000;', 'export const CLOUD_IDLE_AWAKE_MS = 250;'],
];
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== power) return result;
    let source = String(result.source);
    for (const [from, to] of seams) {
      if (source.split(from).length !== 2) throw new Error(`Power clock seam changed: ${from}`);
      source = source.replace(from, to);
    }
    return { ...result, source };
  },
});
