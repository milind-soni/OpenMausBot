// Loaded with --import in isolated fixtures when OMB_TEST_MEMORY_GATE=1: the memory gate runs on any OS, and this machine's
// memory is what <data dir>/host-memory.json says. Nothing else about the gate changes. While <data dir>/test-starter exists
// this server is on the Starter plan.
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
const dataDir = process.env.OMB_DATA_DIR;
if (!dataDir || dataDir !== process.env.HOME || process.env.OMB_TEST_MEMORY_GATE !== '1') {
  throw new Error('The memory gate seam requires an explicitly isolated fixture');
}
const file = join(dataDir, 'host-memory.json');
globalThis.__ombTestHostMemory = () => JSON.parse(readFileSync(file, 'utf8'));
globalThis.__ombTestStarter = () => existsSync(join(dataDir, 'test-starter'));
const gate = new URL('../engine-memory.ts', import.meta.url).href;
const plan = new URL('../host/cloud-plan-tier.ts', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url === plan) {
      const anchor = 'starter: () => tier === "starter",';
      if (!String(result.source).includes(anchor)) throw new Error('Plan seam changed');
      return { ...result, source: String(result.source).replace(anchor, 'starter: () => globalThis.__ombTestStarter(),') };
    }
    if (url !== gate) return result;
    const source = String(result.source);
    const anchor = /export const engineMemory = new EngineMemory\(\{ enabled: [^\n]*\}\);/;
    if (!anchor.test(source)) throw new Error('Memory gate seam changed');
    return { ...result, source: source.replace(anchor, 'export const engineMemory = new EngineMemory({ enabled: true, read: () => globalThis.__ombTestHostMemory(), groups: () => new Map(), tickMs: 100 });') };
  },
});
