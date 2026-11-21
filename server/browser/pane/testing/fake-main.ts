// The desktop main process's side of the pane messages, for unit tests: each pane is one FakeChrome page reached only
// through a page-level session, as an Electron webContents debugger is, and every command a pane got is recorded.
import { PANE_MESSAGE, paneMessageToMain, paneMessageToServer, type PaneToMain } from "../../../../electron/browser-pane-wire.mjs";
import { FakeChrome, type FakeDocument, type FakePage } from "../../testing/fake-chrome.ts";
import type { PanePort } from "../link.ts";

interface FakePane {
  tab: string;
  targetId: string;
  session: string;
  browser: string;
}

export interface PaneCommand {
  tab: string;
  method: string;
  params: Record<string, unknown>;
  session?: string;
}

export class FakeMain implements PanePort {
  readonly chrome: FakeChrome;
  readonly commands: PaneCommand[] = [];
  readonly toMain: PaneToMain[] = [];
  readonly partitions: string[] = [];
  readonly egress: number[] = [];
  readonly downloadDirs: string[] = [];
  /** No app window: opening answers that none can host a pane. */
  noWindow = false;
  /** Milliseconds before an open is answered. */
  openDelayMs = 0;
  /** Commands main never answers. */
  hang: (command: PaneCommand) => boolean = () => false;
  readonly panes = new Map<string, FakePane>();
  /** Answers a pane's command before FakeChrome does; undefined lets it through. */
  answer: (command: PaneCommand) => Record<string, unknown> | undefined = () => undefined;
  readonly #listeners = new Set<(event: { data?: unknown }) => void>();
  readonly #replies = new Map<number, (message: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  #id = 1_000;
  #tab = 0;

  constructor(documents?: (url: string) => FakeDocument) {
    this.chrome = new FakeChrome({ startUrls: [], ...(documents ? { documents } : {}) });
    this.chrome.onMessage((text) => this.#fromChrome(JSON.parse(text) as Record<string, unknown>));
  }

  // PanePort, as the server sees it.
  on(_event: "message", listener: (event: { data?: unknown }) => void): void {
    this.#listeners.add(listener);
  }

  postMessage(message: object): void {
    const parsed = paneMessageToMain(message);
    if (!parsed) throw new Error(`the server sent a malformed pane message: ${JSON.stringify(message)}`);
    this.toMain.push(parsed);
    void this.#handle(parsed);
  }

  hello(): void {
    this.post({ op: "hello" });
  }

  post(message: Record<string, unknown>): void {
    const data = { type: PANE_MESSAGE, ...message };
    if (!paneMessageToServer(data)) throw new Error(`the fake main sent a malformed pane message: ${JSON.stringify(data)}`);
    queueMicrotask(() => { for (const listener of this.#listeners) listener({ data }); });
  }

  page(tab: string): FakePage {
    const pane = this.panes.get(tab);
    const page = pane && this.chrome.pages.get(pane.targetId);
    if (!page) throw new Error(`no pane ${tab}`);
    return page;
  }

  /** A page opens a popup, as window.open does: main makes it a pane of the same profile. */
  async popup(opener: string, url: string): Promise<string> {
    const pane = this.panes.get(opener)!;
    const created = await this.#open(pane.browser, url);
    this.post({ op: "tab", browser: pane.browser, tab: created.tab, target: created.targetId, url, title: "", opener });
    return created.tab;
  }

  personInput(browser: string, tab?: string): void {
    this.post({ op: "input", browser, ...(tab ? { tab } : {}) });
  }

  async #handle(message: PaneToMain): Promise<void> {
    switch (message.op) {
      case "hello":
        this.hello();
        return;
      case "open":
        this.partitions.push(message.partition);
        this.egress.push(message.egress);
        this.downloadDirs.push(message.downloads);
        if (this.openDelayMs) await new Promise((resolve) => setTimeout(resolve, this.openDelayMs));
        if (this.noWindow) this.post({ op: "failed", browser: message.browser, error: "The app window is closed.", reason: "no-window" });
        else this.post({ op: "opened", browser: message.browser, version: "146.0.7680.0", userAgent: "Mozilla/5.0 Chrome/146.0.0.0 Safari/537.36" });
        return;
      case "create": {
        const pane = await this.#open(message.browser, message.url);
        const page = this.chrome.pages.get(pane.targetId)!;
        this.post({ op: "created", browser: message.browser, req: message.req, tab: pane.tab, target: pane.targetId, url: page.url, title: page.title });
        return;
      }
      case "cdp": {
        const command = { tab: message.tab, method: message.method, params: message.params, ...(message.session ? { session: message.session } : {}) };
        this.commands.push(command);
        if (this.hang(command)) return;
        const pane = this.panes.get(message.tab);
        const answered = this.answer(command);
        if (answered !== undefined) {
          this.post({ op: "answer", browser: message.browser, req: message.req, result: answered });
          return;
        }
        if (!pane) {
          this.post({ op: "answer", browser: message.browser, req: message.req, error: { message: "Target closed" } });
          return;
        }
        const reply = await this.#send(message.method, message.params, message.session ?? pane.session);
        this.post({ op: "answer", browser: message.browser, req: message.req, ...(reply.error ? { error: reply.error } : { result: reply.result ?? {} }) });
        return;
      }
      case "close-tab":
        await this.#closeTab(message.tab);
        return;
      case "close":
        for (const pane of this.panes.values()) if (pane.browser === message.browser) await this.#closeTab(pane.tab, false);
        this.post({ op: "closed", browser: message.browser, reason: "closed by the app" });
        return;
      default:
        return;
    }
  }

  async #open(browser: string, url: string): Promise<FakePane> {
    const { result } = await this.#send("Target.createTarget", { url: "about:blank" }, null);
    const targetId = String(result?.targetId);
    const attached = await this.#send("Target.attachToTarget", { targetId, flatten: true }, null);
    const pane = { tab: `p${++this.#tab}`, targetId, session: String(attached.result?.sessionId), browser };
    this.panes.set(pane.tab, pane);
    if (url !== "about:blank") await this.#send("Page.navigate", { url }, pane.session);
    return pane;
  }

  async #closeTab(tab: string, announce = true): Promise<void> {
    const pane = this.panes.get(tab);
    if (!pane) return;
    this.panes.delete(tab);
    await this.#send("Target.closeTarget", { targetId: pane.targetId }, null);
    if (announce) this.post({ op: "tab-gone", browser: pane.browser, tab });
  }

  #send(method: string, params: Record<string, unknown>, sessionId: string | null): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
    const id = ++this.#id;
    return new Promise((resolve) => {
      this.#replies.set(id, resolve);
      this.chrome.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  #fromChrome(message: Record<string, unknown>): void {
    if (typeof message.id === "number") {
      const reply = this.#replies.get(message.id);
      this.#replies.delete(message.id);
      reply?.(message as { result?: Record<string, unknown>; error?: { message: string } });
      return;
    }
    if (message.method === "Target.targetInfoChanged") {
      const info = (message.params as { targetInfo: { targetId: string; url: string; title: string } }).targetInfo;
      const pane = [...this.panes.values()].find((candidate) => candidate.targetId === info.targetId);
      if (pane) this.post({ op: "tab", browser: pane.browser, tab: pane.tab, target: pane.targetId, url: info.url, title: info.title });
      return;
    }
    const pane = [...this.panes.values()].find((candidate) => candidate.session === message.sessionId);
    if (!pane || typeof message.method !== "string") return;
    this.post({ op: "event", browser: pane.browser, tab: pane.tab, method: message.method, params: message.params ?? {} });
  }
}
