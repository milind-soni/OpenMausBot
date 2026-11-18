import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const ownerSource = `
  import { registerHooks } from 'node:module';
  const moduleURL = source => 'data:text/javascript,' + encodeURIComponent(source);
  registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/speech.mjs')) {
      if (specifier === 'electron') return { shortCircuit: true, url: moduleURL(
        'export const app = { isPackaged: true, getPath: () => process.argv[1] };') };
      if (specifier === 'node:child_process') return { shortCircuit: true, url: moduleURL(\`
        import { execFile as run } from 'node:child_process';
        export function execFile(file, args, options, callback) {
          if (process.argv[2] === 'create-throw') throw new Error('mkfifo failed');
          if (!process.argv[2].startsWith('pending')) return run(file, args, options, callback);
          globalThis.pendingCreates ??= [];
          if (process.argv[2].includes('created')) {
            return run(file, args, options, (...result) => {
              globalThis.pendingCreates.push(done => { callback(...result); done(); });
              process.send({ type: 'pending', file: args.at(-1) });
            });
          }
          globalThis.pendingCreates.push(done => {
            if (process.argv[2].startsWith('pending-error')) {
              callback(new Error('mkfifo failed'));
              done();
            } else {
              run(file, args, options, (...result) => { callback(...result); done(); });
            }
          });
          process.send({ type: 'pending', file: args.at(-1) });
        }
        import { EventEmitter } from 'node:events';
        export function spawn(file, args, options) {
          if (process.argv[2] === 'throw') throw new Error('launch failed');
          globalThis.launches += 1;
          globalThis.speechProc = new EventEmitter();
          process.send({ type: 'launch', file, args, options });
          return globalThis.speechProc;
        }
      \`) };
    }
    return next(specifier, context);
  } });
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  process.resourcesPath = '/synthetic-speech-resources';
  const speech = await import(${JSON.stringify(new URL('./speech.mjs', import.meta.url).href)});
  const { EventEmitter } = await import('node:events');
  const ends = [];
  let replaced = 0;
  let destroyed = false;
  globalThis.launches = 0;
  const sink = { transcript() {}, end(info) { ends.push(info); process.send({ type: 'end', info }); }, replaced() { replaced += 1; } };
  const contents = Object.assign(new EventEmitter(), { send(channel, info) { if (channel === 'speech:end') sink.end(info); } });
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed });
  Object.defineProperty(win, 'webContents', { get() { if (destroyed) throw new Error('Object has been destroyed'); return contents; } });
  const target = process.argv[2].includes('window') ? win : sink;
  const status = command => process.send({ type: 'done', command, busy: speech.speechBusy(), launches: globalThis.launches, ends, replaced,
    listeners: [win.listenerCount('closed'), contents.listenerCount('did-navigate'), contents.listenerCount('render-process-gone')] });
  process.on('message', command => {
    if (command === 'resume') {
      globalThis.pendingCreates.shift()(() => status(command));
      return;
    }
    if (command === 'close') globalThis.speechProc.emit('close', 0);
    if (command === 'error') globalThis.speechProc.emit('error', new Error('launch failed'));
    if (command === 'stop') speech.stopSpeech();
    if (command === 'finish') speech.finishSpeech();
    if (command === 'owner-stop') speech.stopSpeech(target);
    if (command === 'owner-finish') speech.finishSpeech(target);
    if (command === 'other-stop') speech.stopSpeech({});
    if (command === 'other-finish') speech.finishSpeech({});
    if (command === 'replace') speech.startSpeech(sink);
    if (command === 'window-close') { destroyed = true; win.emit('closed'); }
    if (command === 'navigate') contents.emit('did-navigate');
    if (command === 'renderer-gone') contents.emit('render-process-gone');
    status(command);
  });
  speech.startSpeech(target);
`;

async function owner(t, mode = "ok") {
  const dir = mkdtempSync(path.join(tmpdir(), "speech-owner-"));
  const proc = fork("--eval", [ownerSource, dir, mode], {
    execArgv: ["--input-type=module"], silent: true,
  });
  const exit = once(proc, "exit");
  const messages = [];
  let waiting;
  proc.on("message", message => {
    if (waiting) { const resolve = waiting; waiting = null; resolve(message); }
    else messages.push(message);
  });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => { waiting = resolve; });
  const command = async name => {
    proc.send(name);
    let response;
    do { response = await next(); } while (response.type !== "done");
    assert.equal(response.command, name);
    return response;
  };
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await exit;
    rmSync(dir, { recursive: true, force: true });
  });
  const message = await next();
  return { proc, dir, message, exit, next, command };
}

function readLifeline(t, message) {
  assert.equal(message.type, "launch");
  const index = message.args.indexOf("--lifeline-file");
  assert.ok(index >= 0, "the helper must receive an owner lifeline");
  const file = message.args[index + 1];
  assert.equal(statSync(file).isFIFO(), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  t.after(() => closeSync(fd));
  return () => readSync(fd, Buffer.alloc(1), 0, 1, null);
}

const options = { skip: process.platform === "win32" && "needs POSIX FIFO", timeout: 10_000 };

test("a speech helper's lifeline reaches EOF when its Electron owner is SIGKILLed", options, async t => {
  const { proc, message, exit } = await owner(t);
  const read = readLifeline(t, message);
  assert.throws(read, { code: "EAGAIN" }, "an active owner keeps the pipe open without sending data");
  proc.kill("SIGKILL");
  await exit;
  assert.equal(read(), 0, "owner death must close the only writer");
});

for (const command of ["close", "error"]) {
  test(`speech ${command} closes the lifeline and removes the session`, options, async t => {
    const { dir, message, command: send } = await owner(t);
    const read = readLifeline(t, message);
    const ended = await send(command);
    assert.deepEqual(ended.ends, [{ code: 1, reason: command === "error" ? "helper-start-failed" : "helper-exited" }]);
    assert.deepEqual((await send("close")).ends, ended.ends);
    assert.equal(read(), 0);
    assert.deepEqual(readdirSync(dir), []);
  });
}

test("stop and finish retain their markers while the owner lifeline stays open", options, async t => {
  const { message, command } = await owner(t);
  const read = readLifeline(t, message);
  const flag = name => message.args[message.args.indexOf(name) + 1];
  await command("finish");
  assert.equal(readFileSync(flag("--finish-file"), "utf8"), "finish");
  assert.equal(existsSync(flag("--stop-file")), false);
  assert.throws(read, { code: "EAGAIN" });
  await command("stop");
  assert.equal(readFileSync(flag("--stop-file"), "utf8"), "stop");
  assert.throws(read, { code: "EAGAIN" });
});

for (const failure of ["throw", "create-throw"]) {
  test(`a synchronous ${failure} failure removes the session and its lifeline`, options, async t => {
    const { dir, message, command } = await owner(t, failure);
    assert.deepEqual(message, { type: "end", info: { code: 1, reason: "helper-start-failed" } });
    assert.deepEqual(readdirSync(dir), []);
    assert.equal((await command("status")).busy, false);
  });
}

for (const stop of ["stop", "owner-stop", "window-close", "navigate", "renderer-gone"]) {
  test(`${stop} cancels a pending FIFO without launching a helper or ending the sink`, options, async t => {
    const session = await owner(t, "pending-window");
    assert.equal(session.message.type, "pending");
    const pending = await session.command("status");
    assert.equal(pending.busy, true);
    assert.deepEqual(pending.listeners, [1, 1, 1]);
    const stopped = await session.command(stop);
    assert.equal(stopped.busy, false);
    assert.deepEqual(stopped.listeners, [0, 0, 0]);
    assert.deepEqual(readdirSync(session.dir), []);
    const resumed = await session.command("resume");
    assert.equal(resumed.launches, 0);
    assert.deepEqual(resumed.ends, []);
    assert.deepEqual(readdirSync(session.dir), []);
  });
}

test("a pending session ignores other owners and retains its owner's finish marker for launch", options, async t => {
  const session = await owner(t, "pending");
  assert.equal(session.message.type, "pending");
  const dir = path.dirname(session.message.file);
  for (const command of ["other-stop", "other-finish"]) {
    assert.equal((await session.command(command)).busy, true);
  }
  assert.equal(existsSync(path.join(dir, "stop")), false);
  assert.equal(existsSync(path.join(dir, "finish")), false);
  assert.equal((await session.command("owner-finish")).busy, true);
  assert.equal(readFileSync(path.join(dir, "finish"), "utf8"), "finish");
  session.proc.send("resume");
  const launched = await session.next();
  const read = readLifeline(t, launched);
  assert.throws(read, { code: "EAGAIN" });
  const ready = await session.next();
  assert.equal(ready.type, "done");
  assert.equal(ready.busy, true);
  assert.equal(readFileSync(path.join(dir, "finish"), "utf8"), "finish");
  const ended = await session.command("close");
  assert.deepEqual(ended.ends, [{ code: 1, reason: "helper-exited" }]);
  assert.equal(read(), 0);
  assert.deepEqual(readdirSync(session.dir), []);
});

test("replacing a pending session never launches or ends it when its FIFO completes late", options, async t => {
  const session = await owner(t, "pending-created");
  assert.equal(session.message.type, "pending");
  assert.equal(statSync(session.message.file).isFIFO(), true);
  const previous = path.dirname(session.message.file);
  const replaced = await session.command("replace");
  assert.equal(replaced.replaced, 1);
  assert.equal(replaced.busy, true);
  assert.equal(existsSync(previous), false);
  const replacement = await session.next();
  assert.equal(replacement.type, "pending");
  assert.notEqual(replacement.file, session.message.file);
  const stale = await session.command("resume");
  assert.equal(stale.launches, 0);
  assert.equal(stale.busy, true);
  assert.deepEqual(stale.ends, []);
  session.proc.send("resume");
  const launched = await session.next();
  const read = readLifeline(t, launched);
  const ready = await session.next();
  assert.equal(ready.launches, 1);
  assert.equal(ready.busy, true);
  await session.command("close");
  assert.equal(read(), 0);
  assert.deepEqual(readdirSync(session.dir), []);
});

test("stopping after FIFO creation ignores its late success callback", options, async t => {
  const session = await owner(t, "pending-created-window");
  assert.equal(session.message.type, "pending");
  assert.equal(statSync(session.message.file).isFIFO(), true);
  await session.command("owner-stop");
  assert.deepEqual(readdirSync(session.dir), []);
  const resumed = await session.command("resume");
  assert.equal(resumed.busy, false);
  assert.equal(resumed.launches, 0);
  assert.deepEqual(resumed.ends, []);
  assert.deepEqual(resumed.listeners, [0, 0, 0]);
  assert.deepEqual(readdirSync(session.dir), []);
});

test("an asynchronous FIFO failure ends the sink once and removes its pending session", options, async t => {
  const session = await owner(t, "pending-error-window");
  assert.equal(session.message.type, "pending");
  const failed = await session.command("resume");
  assert.equal(failed.busy, false);
  assert.equal(failed.launches, 0);
  assert.deepEqual(failed.listeners, [0, 0, 0]);
  assert.deepEqual(failed.ends, [{ code: 1, reason: "helper-start-failed" }]);
  assert.deepEqual(readdirSync(session.dir), []);
  assert.deepEqual((await session.command("stop")).ends, failed.ends);
});
