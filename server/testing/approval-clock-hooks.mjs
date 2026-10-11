// Explicit --import in isolated fixtures only: the verification launcher adds
// it when OMB_TEST_APPROVAL_CLOCK=1 reaches it. The Claude permission
// broker's fifteen-minute "nobody answered" deadline fires when the fixture
// writes <data dir>/expire-approvals instead, so a test can follow an
// unanswered approval through its real course. Every pending ask expires
// while the file exists. It changes no authorization or dispatch decision.
import { registerHooks } from 'node:module';
import { join } from 'node:path';
const dataDir = process.env.OMB_DATA_DIR;
if (!dataDir || dataDir !== process.env.HOME || process.env.OMB_TEST_APPROVAL_CLOCK !== '1') {
  throw new Error('The approval clock requires an explicitly isolated fixture');
}
const marker = join(dataDir, 'expire-approvals');
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/server/drivers/claude.ts')) return result;
    const source = String(result.source);
    // The broker's one timer is the only setTimeout in its scope.
    const anchor = 'const timeoutMs = opts.timeoutMs ?? 15 * 60_000;';
    if (source.split(anchor).length !== 2) throw new Error('Claude permission broker timer seam changed');
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
    ` + source.replace(anchor, `${anchor} const setTimeout = approvalFixtureTimeout;`) };
  },
});
