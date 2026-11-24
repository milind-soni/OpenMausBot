// Loaded with --import in isolated fixtures when OMB_TEST_STARTUP_REFUSAL=1: a one-shot engine refusal before dispatch.
// While <data dir>/startup-refusals.json maps a key to a diagnostic, the next turn on any engine whose thread id is that key,
// or whose prompt contains it, is refused with TurnNotStartedError(diagnostic) before the engine is called: no CLI starts
// and no prompt is written. The entry is then removed. Every turn the engine is given is logged to <data dir>/startup-refusals.log as "sent <thread>", every
// refusal as "refused <thread>". Nothing else about the server changes.
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
const dataDir = process.env.OMB_DATA_DIR, home = process.env.HOME;
// An isolated fixture: its data folder is its HOME (verification servers), or HOME/.openmausbot under a temporary HOME
// (the Cloud fixtures). A real installation never matches either.
// The fixture's child gets no TMPDIR, so its tmpdir() can differ from the one its parent made HOME under: check the usual roots.
const inTemp = (dir) => { try { const real = realpathSync(dir); return [tmpdir(), '/tmp', '/var/tmp', '/var/folders'].some((root) => {
  try { return real.startsWith(realpathSync(root) + sep); } catch { return false; } }); } catch { return false; } };
const isolated = !!dataDir && !!home && (dataDir === home || (dataDir === join(home, '.openmausbot') && inTemp(home)));
if (!isolated || process.env.OMB_TEST_STARTUP_REFUSAL !== '1') {
  throw new Error('The startup refusal seam requires an explicitly isolated fixture');
}
const refusals = join(dataDir, 'startup-refusals.json'), log = join(dataDir, 'startup-refusals.log');
globalThis.__ombTestStartupRefusal = (instance, TurnNotStartedError, newId) => {
  const adapter = instance.adapter;
  instance.adapter = {
    ...adapter,
    sendTurn: async (input) => {
      const pending = existsSync(refusals) ? JSON.parse(readFileSync(refusals, 'utf8')) : {};
      const key = Object.keys(pending).find((one) => one === input.threadId || String(input.text ?? '').includes(one));
      const diagnostic = key === undefined ? undefined : pending[key];
      if (typeof diagnostic === 'string') {
        delete pending[key];
        writeFileSync(refusals, JSON.stringify(pending));
        appendFileSync(log, `refused ${input.threadId}\n`);
        throw new TurnNotStartedError(newId(), diagnostic);
      }
      appendFileSync(log, `sent ${input.threadId}\n`);
      return adapter.sendTurn(input);
    },
  };
};
const registry = new URL('../harness/registry.ts', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== registry) return result;
    const source = String(result.source), anchor = 'this.shareSnapshot(live);';
    if (source.split(anchor).length !== 2) throw new Error('Startup refusal seam changed');
    return {
      ...result,
      source: 'import { TurnNotStartedError as __OmbTurnNotStarted, newId as __ombNewId } from "../contracts.ts";\n'
        + source.replace(anchor, `globalThis.__ombTestStartupRefusal(live, __OmbTurnNotStarted, __ombNewId); ${anchor}`),
    };
  },
});
