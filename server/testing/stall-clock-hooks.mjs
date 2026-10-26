// Loaded with --import in isolated fixtures when OMB_TEST_STALL_CLOCK=1: once the fixture writes
// <data dir>/stall-turns, every then-silent turn with no tool running has spent the stall window, and the
// watchdog sweeps every 50 ms. No authorization or dispatch decision changes.
import { registerHooks } from 'node:module';
import { join } from 'node:path';
const dataDir = process.env.OMB_DATA_DIR;
if (!dataDir || dataDir !== process.env.HOME || process.env.OMB_TEST_STALL_CLOCK !== '1') {
  throw new Error('The stall clock requires an explicitly isolated fixture');
}
const marker = join(dataDir, 'stall-turns');
const server = new URL('../index.ts', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== server) return result;
    const source = String(result.source);
    // The watchdog is the server's only interval with this period.
    const anchor = 'checkMs: 60_000,';
    if (source.split(anchor).length !== 2) throw new Error('Stall watchdog clock seam changed');
    return { ...result, source: `import { existsSync as stallMarkerExists } from 'node:fs';\n` + source.replace(anchor,
      `checkMs: 50, now: () => Date.now() + (stallMarkerExists(${JSON.stringify(marker)}) ? TURN_STALL_MS : 0),`) };
  },
});
