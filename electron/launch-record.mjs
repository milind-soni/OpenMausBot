// The main process's part of the launch record: when each step of this start was reached, counted from the process's
// own start, and what the start paid for outside our code (launch-probes.mjs). Clock reads only; the part is handed to
// the local server once the window is up, and a launch whose hand-over fails loses its record and nothing else.
import { watchLaunchWork } from "./launch-probes.mjs";

/** After the main window shows, the page still draws the chat: the part is sent once that has had time to happen. */
export const SEND_AFTER_SHOWN_MS = 2_000;
/** Later tries, when the server was not there or had not written the record yet. */
export const RETRY_AFTER_MS = [10_000, 30_000, 90_000];

/**
 * @param {{
 *   processStart: number, launchId?: string | null, appVersion: string, platform: string, arch: string,
 *   now?: () => number, watch?: ReturnType<typeof watchLaunchWork>,
 *   setTimer?: (run: () => void, ms: number) => unknown,
 * }} options `processStart` and `now` are epoch ms on one clock.
 */
export function createLaunchRecord({ processStart, launchId = null, appVersion, platform, arch, now = () => performance.timeOrigin + performance.now(), watch = watchLaunchWork(), setTimer = (run, ms) => setTimeout(run, ms).unref?.() }) {
  const marks = {};
  const spans = {};
  const begun = {};
  let hidden = false;
  let post = null;
  let tries = 0, sending = false, done = false, waiting = false;

  const mark = (name) => { marks[name] ??= Math.max(0, Math.round(now() - processStart)); };
  const part = () => ({ from: "main", launchId, processStart: Math.round(processStart), appVersion, platform, arch, hidden, marks: { ...marks }, spans: { ...spans }, ...watch.counts() });
  const stop = () => { done = true; watch.finish(); };

  async function send() {
    if (done || sending || !post) return;
    sending = true;
    tries += 1;
    let complete = false;
    try { complete = (await post(part()))?.complete === true; } catch {}
    sending = false;
    if (complete || tries > RETRY_AFTER_MS.length) { stop(); return; }
    waiting = true;
    setTimer(() => { waiting = false; void send(); }, RETRY_AFTER_MS[tries - 1]);
  }
  const sendSoon = () => {
    if (done || waiting || sending) return;
    waiting = true;
    setTimer(() => { waiting = false; void send(); }, SEND_AFTER_SHOWN_MS);
  };

  return {
    mark,
    begin(name) { begun[name] = now(); },
    end(name) { if (begun[name] !== undefined) spans[name] ??= Math.max(0, Math.round(now() - begun[name])); },
    /** Times one awaited step and hands back its result untouched. */
    span(name, work) {
      const at = now();
      const finish = () => { spans[name] ??= Math.max(0, Math.round(now() - at)); };
      const pending = Promise.resolve().then(work);
      pending.then(finish, finish);
      return pending;
    },
    /** The id the server child of this launch is given; the server takes a part under no other. */
    setLaunchId(id) { launchId = id; },
    /** Started out of sight: no window will show, so the part goes once the server is ready. */
    setHidden(value) { hidden = Boolean(value); },
    /** `send(body)` posts the part to the local server and resolves to its JSON answer. */
    deliverWith(send) { post = send; },
    /** The server is ready (again): a part not yet recorded is sent, a hidden start's for the first time. */
    serverReady() { mark("serverReady"); if (hidden || marks.windowShown !== undefined) sendSoon(); },
    /**
     * The splash is the window that loads a data: page, the main window the first that loads a web page. A window's
     * "shown" mark is the first call that shows it.
     * @param {{ on(event: string, listener: (...args: any[]) => void): unknown }} app
     */
    watchWindows(app) {
      const made = new Map();
      const role = new Map();
      const shown = (contents, name) => {
        if (!name || role.get(contents) !== name) return;
        mark(`${name}Shown`);
        if (name === "window") sendSoon();
      };
      app.on("browser-window-created", (_event, win) => {
        if (done) return;
        const contents = win.webContents;
        made.set(contents, Math.max(0, Math.round(now() - processStart)));
        let visible = false;
        const showing = () => { visible = true; shown(contents, role.get(contents)); };
        // Electron emits "show" only when the main thread is next free, which a busy launch delays: the call is the mark.
        for (const method of ["show", "showInactive"]) {
          const original = win[method];
          if (typeof original === "function") win[method] = function (...args) { try { showing(); } catch {} return original.apply(this, args); };
        }
        win.once("show", showing);
        contents.on("did-start-navigation", (details) => {
          if (done || role.has(contents) || !details?.isMainFrame || details.isSameDocument) return;
          const url = String(details.url ?? "");
          const name = url.startsWith("data:") ? "splash" : /^https?:/.test(url) ? "window" : null;
          if (!name || [...role.values()].includes(name)) return;
          role.set(contents, name);
          marks[`${name}Made`] ??= made.get(contents);
          if (name === "window") mark("windowNavigated");
          if (visible) shown(contents, name);
        });
      });
    },
    part,
    /** No record will be written for this launch: the probes are put back. */
    giveUp() { if (!done) stop(); },
    get done() { return done; },
  };
}
