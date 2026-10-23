// Loaded only by group-local-vm.e2e.test.ts via --import. Replace the container
// boundary, preserving the real server, lease code, MCP config and fake driver.
import { registerHooks } from 'node:module';
const state = process.env.OMB_TEST_VM_STATE;
if (!state) throw new Error('An explicit isolated VM state file is required');
const actual = new URL('../container-computer.ts?actual', import.meta.url).href;
const atomic = new URL('../atomic.ts', import.meta.url).href;
const mock = new URL('./group-local-vm-mock.mjs', import.meta.url).href;
const profilesMock = new URL('./group-local-vm-profiles-mock.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/container-computer.ts')) return { url: mock, shortCircuit: true };
    if (specifier.endsWith('/local-vm-profiles.ts')) return { url: profilesMock, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    // Sign-in rescue: recorded in the state file, in order with the container actions, instead of running docker cp.
    if (url === profilesMock) return { format: 'module', shortCircuit: true, source: `
      import { readFileSync } from 'node:fs';
      import { writeFileAtomic } from ${JSON.stringify(atomic)};
      const file = ${JSON.stringify(state)};
      export async function rescueFirefoxProfile(_runtime, target) {
        const state = JSON.parse(readFileSync(file, 'utf8'));
        if (state.failRescue) throw new Error("could not copy the desktop's Firefox profile: fixture refused");
        state.actions = [...(state.actions ?? []), { action: 'rescue', target: target.key }];
        writeFileAtomic(file, JSON.stringify(state), { durable: false });
        return 'rescued';
      }
      export async function keepFirefoxProfileBeforeRemove(target, status, stop) {
        if (!status.runtime || status.container === 'missing' || !status.managed || status.imageMatches) return 'none';
        if (status.container === 'running') await stop();
        return rescueFirefoxProfile(status.runtime, target);
      }
    ` };
    if (url === mock) return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(actual)};
      import { SHARED_LOCAL_VM_TARGET } from ${JSON.stringify(actual)};
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { writeFileAtomic } from ${JSON.stringify(atomic)};
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
        // An old desktop: made by OpenMausBot, on an image this release no longer runs (and maybe not yet rebuilt).
        const image = !read().imageMissing;
        const outdated = !missing && Boolean(read().outdated?.includes(target.key));
        const ready = !missing && !stopped && !outdated && image && !read().failed;
        return { runtime: 'podman', daemonUp: true, image, create_supported: true, managed: !missing,
          container: missing ? 'missing' : stopped ? 'stopped' : 'running', ready,
          imageMatches: !outdated && image, network: 'loopback', security: 'hardened', persistence: 'durable', resumable: Boolean(stopped) && !outdated && image,
          stopped_at: stopped ? read().stoppedAt : null,
          problem: ready ? null : outdated ? 'The existing Local VM uses an older desktop or Cua Driver; recreate it' : 'fixture desktop unavailable',
          container_name: target.containerName, target_key: target.key, workspace_path: target.workspaceDir };
      }
      export async function containerComputerAction(action, _run, _platform, target = SHARED_LOCAL_VM_TARGET) {
        if (action === 'pull' && read().containers) {
          while (read().holdPull) await new Promise(r => setTimeout(r, 30));
          const state = read();
          state.imageMissing = false;
          state.actions = [...(state.actions ?? []), { action, target: target.key }];
          writeFileAtomic(file, JSON.stringify(state), { durable: false });
          return containerComputerStatus(_run, _platform, target);
        }
        const state = read();
        if (!state.containers || !['run', 'start', 'stop', 'remove'].includes(action)) throw new Error('Unexpected container mutation in VM routing test');
        if (action === 'run') {
          mkdirSync(target.workspaceDir, { recursive: true });
          state.containers.push(target.key);
          state.stopped = (state.stopped ?? []).filter(key => key !== target.key);
        } else if (action === 'stop') {
          state.stopped = [...(state.stopped ?? []), target.key];
          state.stoppedAt = new Date().toISOString();
        } else if (action === 'start') {
          state.stopped = (state.stopped ?? []).filter(key => key !== target.key);
        } else {
          state.containers = state.containers.filter(key => key !== target.key);
          state.outdated = (state.outdated ?? []).filter(key => key !== target.key);
        }
        state.actions = [...(state.actions ?? []), { action, target: target.key }];
        writeFileAtomic(file, JSON.stringify(state), { durable: false });
        return containerComputerStatus(_run, _platform, target);
      }
    ` };
    const result = nextLoad(url, context);
    if (url.endsWith('/computer-idle.ts')) {
      return { ...result, source: `import { readFileSync as readVmIdle } from 'node:fs';\n` +
        String(result.source).replaceAll('checkedIdleMs(idleMs)', `(JSON.parse(readVmIdle(${JSON.stringify(state)}, 'utf8')).idleMs ?? checkedIdleMs(idleMs))`) };
    }
    if (url.endsWith('/local-vm-lease.ts')) {
      return { ...result, source: `import { readFileSync as readVmClock } from 'node:fs';\n` +
        String(result.source).replaceAll('Date.now()', `(Date.now() + (JSON.parse(readVmClock(${JSON.stringify(state)}, 'utf8')).clockOffset || 0))`) };
    }
    if (url.endsWith('/drivers/claude.ts')) {
      return { ...result, source: `import { existsSync as existsVmRelease, readFileSync as readVmEvents, writeFileSync as writeVmEvent } from 'node:fs';\n` +
        String(result.source).replace('for (const l of Array.from(listeners)) l(event);',
          `if (event.type === 'turn.completed') {\n        const fixture = JSON.parse(readVmEvents(${JSON.stringify(state)}, 'utf8'));\n        if (fixture.dropCompletion) return;\n        if (fixture.holdCompletion) { writeVmEvent(${JSON.stringify(state)} + '.completionheld', event.turnId ?? ''); const timer = setInterval(() => { if (!existsVmRelease(${JSON.stringify(state)} + '.releasecompletion')) return; clearInterval(timer); writeVmEvent(${JSON.stringify(state)} + '.latecompleted', event.turnId ?? ''); for (const l of Array.from(listeners)) l(event); }, 10); return; }\n      }\n      for (const l of Array.from(listeners)) l(event);`) };
    }
    if (url.endsWith('/turn-watchdog.ts')) {
      return { ...result, source: `import { readFileSync as readVmWatch } from 'node:fs';\n` +
        String(result.source).replace('this.opts = opts;', 'this.opts = { ...opts, checkMs: 30 };')
          .replace('at - turn.lastEventAt < this.opts.stallMs', `at - turn.lastEventAt < (JSON.parse(readVmWatch(${JSON.stringify(state)}, 'utf8')).stall ? 0 : JSON.parse(readVmWatch(${JSON.stringify(state)}, 'utf8')).stallThread === turn.threadId ? 100 : this.opts.stallMs)`) };
    }
    if (url.endsWith('/turn-dispatch-guard.ts')) {
      // wedgeClear parks a room turn inside waitForClear; the clearwait marker proves it got there.
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
