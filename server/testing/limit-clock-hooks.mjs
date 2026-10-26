// Loaded with --import in isolated fixtures when OMB_TEST_LIMIT_CLOCK=1: a limit-reset automation starts a second
// after the reset instead of a minute, and routines are checked every 250 ms instead of every 10 s, so a fixture can
// watch one run without waiting. No authorization or dispatch decision changes.
import { registerHooks } from 'node:module';

const dataDir = process.env.OMB_DATA_DIR;
if (!dataDir || dataDir !== process.env.HOME || process.env.OMB_TEST_LIMIT_CLOCK !== '1') {
  throw new Error('The limit clock requires an explicitly isolated fixture');
}
const seams = new Map([
  [new URL('../../shared/limit-reset.ts', import.meta.url).href, ['export const AFTER_RESET_MS = 60_000;', 'export const AFTER_RESET_MS = 1_000;']],
  [new URL('../routines.ts', import.meta.url).href, ['setInterval(() => this.tickInBackground(), 10_000)', 'setInterval(() => this.tickInBackground(), 250)']],
]);
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    const seam = seams.get(url);
    if (!seam) return result;
    const source = String(result.source);
    if (source.split(seam[0]).length !== 2) throw new Error(`Limit clock seam changed in ${url}`);
    return { ...result, source: source.replace(seam[0], seam[1]) };
  },
});
