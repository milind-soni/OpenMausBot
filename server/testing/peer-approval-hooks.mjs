// Explicit --import in the isolated peer-approval fixture only. The production
// fifteen-minute deadline is tested with fake timers in peer-approval.test.ts.
// Here the test releases that same callback after observing the real HTTP card.
import { registerHooks } from 'node:module';
import { join } from 'node:path';
const dataDir = process.env.OMB_DATA_DIR;
if (!dataDir || dataDir !== process.env.HOME || !process.env.OMB_TEST_PEER_APPROVAL) {
  throw new Error('Peer approval clock requires an explicitly isolated fixture');
}
const marker = join(dataDir, 'expire-peer-approval');
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/peer-approval.ts')) return result;
    const source = String(result.source);
    const anchor = 'const timer = setTimeout(() => {';
    if (source.split(anchor).length !== 2) throw new Error('Peer approval timer seam changed');
    return { ...result, source: `
      import { existsSync as approvalMarkerExists } from 'node:fs';
      function approvalFixtureTimeout(callback, _delay) {
        const timer = setInterval(() => {
          if (!approvalMarkerExists(${JSON.stringify(marker)})) return;
          clearInterval(timer);
          callback();
        }, 25);
        return timer;
      }
    ` + source.replace(anchor, 'const timer = approvalFixtureTimeout(() => {') };
  },
});
