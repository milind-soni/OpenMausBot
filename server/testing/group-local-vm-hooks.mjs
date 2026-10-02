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
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      const file = ${JSON.stringify(state)};
      const read = () => JSON.parse(readFileSync(file, 'utf8'));
      export async function containerRuntimeStatus() { return { runtime: 'podman', daemonUp: true }; }
      export async function containerExec(target, command) {
        writeFileSync(file + '.exec', JSON.stringify({ target, command }));
        return { exitCode: 0, stdout: 'fixture command completed', stderr: '', timedOut: false };
      }
      export async function containerComputerExists(_runtime, target) {
        const state = read();
        return state.containers ? state.containers.includes(target.key) : !state.noContainers;
      }
      export async function containerComputerStatus(_run, _platform, target = SHARED_LOCAL_VM_TARGET) {
        writeFileSync(file + '.entered', target.key);
        while (read().blocked || read().blockedTarget === target.key) await new Promise(r => setTimeout(r, 30));
        const missing = !(await containerComputerExists('podman', target));
        const stopped = read().stopped?.includes(target.key);
        const ready = !missing && !stopped && !read().failed;
        return { runtime: 'podman', daemonUp: true, image: true, create_supported: true, managed: !missing,
          container: missing ? 'missing' : stopped ? 'stopped' : 'running', ready,
          imageMatches: true, network: 'loopback', security: 'hardened', persistence: 'durable', resumable: Boolean(stopped),
          stopped_at: stopped ? read().stoppedAt : null, problem: ready ? null : 'fixture desktop unavailable',
          container_name: target.containerName, target_key: target.key, workspace_path: target.workspaceDir };
      }
      export async function containerComputerAction(action, _run, _platform, target = SHARED_LOCAL_VM_TARGET) {
        const state = read();
        if (!state.containers || !['run', 'start', 'stop', 'remove'].includes(action)) throw new Error('Unexpected container mutation in VM routing test');
        if (action === 'run') {
          mkdirSync(target.workspaceDir, { recursive: true });
          state.containers.push(target.key);
        } else if (action === 'stop') {
          state.stopped = [...(state.stopped ?? []), target.key];
          state.stoppedAt = new Date().toISOString();
        } else if (action === 'start') {
          state.stopped = (state.stopped ?? []).filter(key => key !== target.key);
        } else state.containers = state.containers.filter(key => key !== target.key);
        state.actions = [...(state.actions ?? []), { action, target: target.key }];
        writeFileSync(file, JSON.stringify(state));
        return containerComputerStatus(_run, _platform, target);
      }
    ` };
    const result = nextLoad(url, context);
    if (url.endsWith('/local-vm-idle.ts')) {
      return { ...result, source: `import { readFileSync as readVmIdle } from 'node:fs';\n` +
        String(result.source).replaceAll('checkedIdleMs(idleMs)', `(JSON.parse(readVmIdle(${JSON.stringify(state)}, 'utf8')).idleMs ?? checkedIdleMs(idleMs))`) };
    }
    if (url.endsWith('/local-vm-lease.ts')) {
      return { ...result, source: `import { readFileSync as readVmClock } from 'node:fs';\n` +
        String(result.source).replaceAll('Date.now()', `(Date.now() + (JSON.parse(readVmClock(${JSON.stringify(state)}, 'utf8')).clockOffset || 0))`) };
    }
    if (url.endsWith('/drivers/claude.ts')) {
      return { ...result, source: `import { readFileSync as readVmEvents, writeFileSync as writeVmEvent } from 'node:fs';\n` +
        String(result.source).replace('for (const l of Array.from(listeners)) l(event);',
          `if (event.type === 'turn.completed') {\n        const fixture = JSON.parse(readVmEvents(${JSON.stringify(state)}, 'utf8'));\n        if (fixture.dropCompletion) return;\n        if (fixture.delayCompletion) { setTimeout(() => { writeVmEvent(${JSON.stringify(state)} + '.latecompleted', event.turnId ?? ''); for (const l of Array.from(listeners)) l(event); }, fixture.delayCompletion); return; }\n      }\n      for (const l of Array.from(listeners)) l(event);`) };
    }
    if (url.endsWith('/turn-watchdog.ts')) {
      return { ...result, source: `import { readFileSync as readVmWatch } from 'node:fs';\n` +
        String(result.source).replace('this.opts = opts;', 'this.opts = { ...opts, checkMs: 30 };')
          .replace('at - turn.lastEventAt < this.opts.stallMs', `at - turn.lastEventAt < (JSON.parse(readVmWatch(${JSON.stringify(state)}, 'utf8')).stall ? 0 : JSON.parse(readVmWatch(${JSON.stringify(state)}, 'utf8')).stallThread === turn.threadId ? 100 : this.opts.stallMs)`) };
    }
    if (url.endsWith('/turn-dispatch-guard.ts')) {
      // wedgeClear parks a room turn inside waitForClear, the pre-id
      // quarantine a prior turn's cancelled handshake can hold open while
      // its TTL runs — the real delayed-setup window where a stall used to
      // find no completion handler. The clearwait marker lets a test prove
      // the turn reached that park before it flips the stall on; entry into
      // containerComputerStatus alone only proves readiness started.
      return { ...result, source: `import { readFileSync as readVmClear, writeFileSync as writeVmClear } from 'node:fs';\n` +
        String(result.source).replace('async waitForClear(threadId: string): Promise<void> {',
          `async waitForClear(threadId: string): Promise<void> {\n      writeVmClear(${JSON.stringify(state)} + '.clearwait', '1');\n      while (JSON.parse(readVmClear(${JSON.stringify(state)}, 'utf8')).wedgeClear) await new Promise((resolve) => setTimeout(resolve, 20));`) };
    }
    if (url.endsWith('/room-turn-timeout.ts')) {
      return { ...result, source: `import { readFileSync as readVmDeadline } from 'node:fs';\n` +
        String(result.source).replace('this.remainingMs = roomTurnTimeoutMs(minutes);',
          `this.remainingMs = JSON.parse(readVmDeadline(${JSON.stringify(state)}, 'utf8')).timeout ? 5000 : roomTurnTimeoutMs(minutes);`) };
    }
    return result;
  },
});
