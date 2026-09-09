// Loaded only by group-local-vm.e2e.test.ts via --import. Replace the container
// boundary, preserving the real server, lease code, MCP config and fake driver.
import { registerHooks } from 'node:module';
const state = process.env.OMB_TEST_VM_STATE;
if (!state) throw new Error('An explicit isolated VM state file is required');
const actual = new URL('../container-computer.ts?actual', import.meta.url).href;
const mock = new URL('./group-local-vm-mock.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/container-computer.ts')) return { url: mock, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === mock) return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(actual)};
      import { SHARED_LOCAL_VM_TARGET } from ${JSON.stringify(actual)};
      import { readFileSync, writeFileSync } from 'node:fs';
      const file = ${JSON.stringify(state)};
      const read = () => JSON.parse(readFileSync(file, 'utf8'));
      export async function containerRuntimeStatus() { return { runtime: 'podman', daemonUp: true }; }
      export async function containerComputerExists() { return !read().noContainers; }
      export async function containerComputerStatus(_run, _platform, target = SHARED_LOCAL_VM_TARGET) {
        writeFileSync(file + '.entered', target.key);
        while (read().blocked) await new Promise(r => setTimeout(r, 30));
        const ready = !read().failed;
        return { runtime: 'podman', daemonUp: true, imagePresent: true, managed: true,
          container: 'running', ready, problem: ready ? null : 'fixture desktop unavailable',
          container_name: target.containerName, target_key: target.key, workspace_path: target.workspaceDir };
      }
      export async function containerComputerAction() { throw new Error('Unexpected container mutation in VM routing test'); }
    ` };
    const result = nextLoad(url, context);
    if (url.endsWith('/local-vm-lease.ts')) {
      return { ...result, source: `import { readFileSync as readVmClock } from 'node:fs';\n` +
        String(result.source).replaceAll('Date.now()', `(Date.now() + (JSON.parse(readVmClock(${JSON.stringify(state)}, 'utf8')).clockOffset || 0))`) };
    }
    if (url.endsWith('/turn-watchdog.ts')) {
      return { ...result, source: `import { readFileSync as readVmWatch } from 'node:fs';\n` +
        String(result.source).replace('this.opts = opts;', 'this.opts = { ...opts, checkMs: 30 };')
          .replace('at - turn.lastEventAt < this.opts.stallMs', `at - turn.lastEventAt < (JSON.parse(readVmWatch(${JSON.stringify(state)}, 'utf8')).stall ? 0 : this.opts.stallMs)`) };
    }
    if (url.endsWith('/room-turn-timeout.ts')) {
      return { ...result, source: `import { readFileSync as readVmDeadline } from 'node:fs';\n` +
        String(result.source).replace('this.remainingMs = roomTurnTimeoutMs(minutes);',
          `this.remainingMs = JSON.parse(readVmDeadline(${JSON.stringify(state)}, 'utf8')).timeout ? 5000 : roomTurnTimeoutMs(minutes);`) };
    }
    return result;
  },
});
