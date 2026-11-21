// The server's end of the desktop app's pane messages: one PaneEndpoint per profile the main process shows natively.
import { PANE_MESSAGE, paneMessageToServer, type PaneToMain, type PaneToServer } from "../../../electron/browser-pane-wire.mjs";
import type { Params } from "../cdp/connection.ts";
import { PaneEndpoint, type PaneChannel, type PaneEndpointOptions, type PaneTab } from "./endpoint.ts";

/** Electron's utility-process parent port: only the desktop main process can post on it. */
export interface PanePort {
  on(event: "message", listener: (event: { data?: unknown }) => void): void;
  postMessage(message: object): void;
}

export interface OpenedPanes {
  readonly endpoint: PaneEndpoint;
  readonly version: string;
  onPersonInput(listener: () => void): () => void;
}

type Outgoing = PaneToMain extends infer M ? M extends unknown ? Omit<M, "type"> : never : never;

interface Pending {
  browser: string | null;
  resolve(value: Params | PaneTab): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PaneLinkOptions extends PaneEndpointOptions {
  openTimeoutMs?: number;
  /** A command main never answers fails after this; the driver's own timeouts are usually shorter. */
  requestTimeoutMs?: number;
}

interface Open {
  endpoint: PaneEndpoint;
  inputs: Set<() => void>;
}

const OPEN_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;

/** No app window can host a pane now (the window is closed); a launched Chrome can run the browser instead. */
export class PaneUnavailable extends Error {}

export class PaneProtocolError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

export class PaneLink {
  readonly #port: PanePort | null;
  readonly #options: PaneLinkOptions;
  readonly #browsers = new Map<string, Open>();
  readonly #opening = new Map<string, { resolve(answer: { version: string; userAgent: string }): void; reject(error: Error): void }>();
  readonly #pending = new Map<number, Pending>();
  #resolver: ((botId: string, threadId: string | null) => string | null) | null = null;
  #ready = false;
  #next = 0;

  constructor(port: PanePort | null | undefined, options: PaneLinkOptions = {}) {
    this.#port = port ?? null;
    this.#options = options;
    this.#port?.on("message", (event) => {
      try {
        const message = paneMessageToServer(event?.data);
        if (message) this.#receive(message);
      } catch (error) {
        console.warn(`browser pane: rejected a message from the app: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    // The app's own greeting may arrive before this listener exists; asking makes it greet again.
    this.#post({ op: "hello" });
  }

  /** True once the desktop app said it shows panes. */
  get available(): boolean {
    return this.#ready && this.#port !== null;
  }

  /** Which profile the panel of a bot (in a conversation) shows; null when it is not a pane. */
  resolveWith(resolver: (botId: string, threadId: string | null) => string | null): void {
    this.#resolver = resolver;
  }

  async open(browser: string, partition: string, egress: number, downloads: string): Promise<OpenedPanes> {
    if (!this.available) throw new PaneUnavailable("The desktop app does not show browser panes here.");
    this.close(browser);
    const answer = await new Promise<{ version: string; userAgent: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#opening.delete(browser);
        // A late answer must not leave panes nobody drives.
        this.#post({ op: "close", browser });
        reject(new Error("The desktop app did not open the browser pane in time."));
      }, this.#options.openTimeoutMs ?? OPEN_TIMEOUT_MS);
      this.#opening.set(browser, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.#post({ op: "open", browser, partition, egress, downloads });
    });
    const inputs = new Set<() => void>();
    const channel: PaneChannel = {
      version: answer.version,
      userAgent: answer.userAgent,
      create: (url, background) => this.#request(browser, (req) => ({ op: "create", browser, req, url, ...(background ? { background: true } : {}) })) as Promise<PaneTab>,
      command: (tab, method, params, session) => this.#request(browser, (req) => ({ op: "cdp", browser, req, tab, method, params, ...(session ? { session } : {}) })) as Promise<Params>,
      front: (tab) => this.#post({ op: "front", browser, tab }),
      closeTab: (tab) => this.#post({ op: "close-tab", browser, tab }),
      cancelDownload: (guid) => this.#post({ op: "cancel-download", browser, guid }),
      close: () => this.#post({ op: "close", browser }),
    };
    const endpoint = new PaneEndpoint(channel, [], this.#options);
    this.#browsers.set(browser, { endpoint, inputs });
    endpoint.onClose(() => {
      if (this.#browsers.get(browser)?.endpoint === endpoint) this.close(browser);
    });
    return {
      endpoint,
      version: answer.version,
      onPersonInput: (listener) => {
        inputs.add(listener);
        return () => inputs.delete(listener);
      },
    };
  }

  /** Closes every pane of one profile. */
  close(browser: string): void {
    const open = this.#browsers.get(browser);
    if (!open) return;
    this.#browsers.delete(browser);
    this.#post({ op: "close", browser });
    this.#fail(browser, "The browser pane closed.");
    open.endpoint.closed("the browser pane closed");
  }

  /** Clears what a profile's partition stored: sign-ins, history, caches. */
  erase(partition: string): void {
    if (this.#port) this.#post({ op: "erase", partition });
  }

  #request(browser: string, message: (req: number) => Outgoing): Promise<Params | PaneTab> {
    if (!this.#browsers.has(browser)) return Promise.reject(new PaneProtocolError("Target closed"));
    const req = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(req);
        reject(new PaneProtocolError("The app did not answer the browser pane in time."));
      }, this.#options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      this.#pending.set(req, { browser, resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); }, timer });
      this.#post(message(req));
    });
  }

  #fail(browser: string, reason: string): void {
    for (const [req, pending] of this.#pending) {
      if (pending.browser !== browser) continue;
      this.#pending.delete(req);
      pending.reject(new PaneProtocolError(`Target closed: ${reason}`));
    }
  }

  #post(message: Outgoing): void {
    try {
      this.#port?.postMessage({ type: PANE_MESSAGE, ...message });
    } catch (error) {
      console.warn(`browser pane: could not reach the app: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #receive(message: PaneToServer): void {
    switch (message.op) {
      case "hello":
        this.#ready = true;
        for (const browser of this.#browsers.keys()) this.close(browser);
        return;
      case "opened":
      case "failed": {
        const opening = this.#opening.get(message.browser);
        this.#opening.delete(message.browser);
        if (!opening) {
          if (message.op === "opened" && !this.#browsers.has(message.browser)) this.#post({ op: "close", browser: message.browser });
          return;
        }
        if (message.op === "opened") opening.resolve({ version: message.version, userAgent: message.userAgent });
        else opening.reject(message.reason === "no-window" ? new PaneUnavailable(message.error) : new Error(message.error));
        return;
      }
      case "created":
      case "answer": {
        const pending = this.#pending.get(message.req);
        if (!pending || pending.browser !== message.browser) return;
        this.#pending.delete(message.req);
        if (message.op === "created") pending.resolve({ tab: message.tab, target: message.target, url: message.url, title: message.title });
        else if (message.error) pending.reject(new PaneProtocolError(String(message.error.message), message.error.code));
        else pending.resolve(message.result ?? {});
        return;
      }
      case "which": {
        const browser = this.#resolver?.(message.botId, message.threadId) ?? null;
        this.#post({ op: "resolved", req: message.req, browser });
        return;
      }
    }
    const open = this.#browsers.get(message.browser);
    if (!open) return;
    switch (message.op) {
      case "event":
        open.endpoint.pageEvent(message.tab, message.method, message.params, message.session);
        return;
      case "tab":
        open.endpoint.tabOpened({ tab: message.tab, target: message.target, url: message.url, title: message.title, ...(message.opener ? { opener: message.opener } : {}) });
        return;
      case "tab-gone":
        open.endpoint.tabGone(message.tab, message.crashed === true);
        return;
      case "download":
        open.endpoint.download(message);
        return;
      case "input":
        open.endpoint.personInput(message.tab);
        for (const listener of open.inputs) {
          try { listener(); } catch {}
        }
        return;
      case "closed":
        this.#browsers.delete(message.browser);
        this.#fail(message.browser, message.reason);
        open.endpoint.closed(message.reason);
        return;
    }
  }
}

/** The desktop app's link, on the server it starts as a utility process; null anywhere else. */
export function desktopPaneLink(managed: boolean): PaneLink | null {
  const port = (process as NodeJS.Process & { parentPort?: PanePort }).parentPort;
  return managed && port ? new PaneLink(port) : null;
}
