// What rides beside a bot's browser session in the Cloud's browser sandbox, on one more connection through the same door:
// its sign-ins carried in from the home when they changed there, carried back to the home on a clean close, and its
// downloads brought to the bot's working folder as they finish. Uploads go the other way, one file at a time.
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Cdp, CdpEvent } from "../browser-sites.ts";
import { DOWNLOAD_LIMITS, safeFileName } from "../browser/cdp/downloads.ts";
import type { CloudBrowserRails } from "./rails.ts";
import type { ComputerOps } from "./remote.ts";
import { carryIn, carryOut } from "./sign-ins.ts";

/** Where a download lands in the bot's working folder. */
export const DOWNLOADS_SUBFOLDER = "downloads";
/** The largest file an upload copies into the sandbox; a larger one fails that one action with a line. */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export interface SignInStore {
  /** The home's saved sign-ins for a session, when they last changed; null when none; "unreadable" when not readable now. */
  load(session: string): { state: { cookies: unknown[]; origins: unknown[] }; modified: number } | null | "unreadable";
  /** The sandbox's cookies saved as the session's; returns when the file changed. */
  save(session: string, cookies: unknown[]): number;
}

export interface CompanionDeps {
  session: string;
  botId: string;
  key: string;
  boxId: string;
  /** The sandbox's home folder, from its launch. */
  home: string;
  ops: ComputerOps;
  rails: CloudBrowserRails;
  signIns: SignInStore | null;
  /** The bot's working folder in the Cloud, or null when it has none now. */
  folder(botId: string): string | null;
  connect(url: string, listeners: { event(message: CdpEvent): void }): Promise<Cdp>;
  log(line: string): void;
}

/** The home's sign-ins could not be read now: the session opens in the home this time, and the carry is tried next time. */
export class SignInsUnreadable extends Error {}

interface Pending { guid: string; name: string }

export class SandboxCompanion {
  readonly #deps: CompanionDeps;
  #cdp: Cdp | null = null;
  readonly #names = new Map<string, string>();
  /** Finished downloads not yet in the bot's folder: kept in the sandbox (a day at most) and tried again at the close. */
  readonly #pending = new Map<string, Pending>();
  readonly #notes: string[] = [];
  #started = 0;
  #delivering: Promise<void> = Promise.resolve();

  constructor(deps: CompanionDeps) { this.#deps = deps; }

  get downloadDir(): string { return `${this.#deps.home}/.omb-browser/.downloads/${this.#deps.key}`; }

  /** Opens its connection, carries the home's sign-ins in when they changed since the last carry, and takes the session's
   * downloads. Throws SignInsUnreadable, or any failure, before the session is used: it then opens in the home. */
  async start(cdpUrl: string): Promise<void> {
    const { session, key, rails, signIns } = this.#deps;
    const loaded = signIns ? signIns.load(session) : null;
    if (loaded === "unreadable") throw new SignInsUnreadable();
    this.#cdp = await this.#deps.connect(cdpUrl, { event: (message) => this.#event(message) });
    if (loaded && loaded.modified > rails.carried(key)) {
      const carried = await carryIn(this.#cdp, loaded.state);
      rails.setCarried(key, loaded.modified);
      this.#deps.log(`browser ${session}: carried ${carried.cookies} saved cookies and ${carried.origins} sites' storage into the browser sandbox`);
    }
    await this.#cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.downloadDir, eventsEnabled: true });
  }

  /** Lines for the bot's next browser call: downloads that arrived, or could not. */
  takeNotes(): string[] { return this.#notes.splice(0); }

  /** A file of the Cloud copied into the sandbox for a page's file input; returns its path there, or the line to say. */
  async upload(file: string, name: string | null, size: number): Promise<{ path: string } | { error: string }> {
    const shown = basename(file);
    if (size > UPLOAD_MAX_BYTES) return { error: `${shown} is over ${UPLOAD_MAX_BYTES / 1024 / 1024} MiB, which this browser can't take from the Cloud yet. Tell the person in one sentence and ask them to upload it themselves.` };
    const target = `${this.#deps.home}/.omb-browser/.uploads/${this.#deps.key}/${safeFileName(name ?? shown) || "upload"}`;
    const sent = await this.#deps.ops.sendFile(this.#deps.boxId, dirname(file), shown, target);
    return "error" in sent ? { error: `${shown} could not be given to the browser: ${sent.error}` } : { path: target };
  }

  /** A clean close: downloads still waiting are tried once more, and the sandbox's cookies are saved as the home's. */
  async stop(): Promise<void> {
    await this.#delivering;
    for (const pending of this.#pending.values()) await this.#deliver(pending);
    if (this.#cdp && this.#deps.signIns) {
      try {
        const cookies = await carryOut(this.#cdp);
        this.#deps.rails.setCarried(this.#deps.key, this.#deps.signIns.save(this.#deps.session, cookies));
      } catch (error) {
        this.#deps.log(`browser ${this.#deps.session}: could not save the browser sandbox's sign-ins in the home (${error instanceof Error ? error.name : "error"}); they stay in the sandbox`);
      }
    }
    this.close();
  }

  close(): void {
    this.#cdp?.close();
    this.#cdp = null;
  }

  #event(message: CdpEvent): void {
    const params = message.params ?? {};
    const guid = typeof params.guid === "string" && /^[A-Za-z0-9-]{1,64}$/.test(params.guid) ? params.guid : null;
    if (!guid) return;
    if (message.method === "Browser.downloadWillBegin") {
      if (this.#started >= DOWNLOAD_LIMITS.perOwner) {
        void this.#cdp?.send("Browser.cancelDownload", { guid }).catch(() => undefined);
        this.#notes.push(`A download was stopped: this browser keeps at most ${DOWNLOAD_LIMITS.perOwner} downloads per session.`);
        return;
      }
      this.#started += 1;
      this.#names.set(guid, safeFileName(String(params.suggestedFilename ?? "")) || "download");
      return;
    }
    if (message.method !== "Browser.downloadProgress") return;
    const name = this.#names.get(guid) ?? "download";
    const bytes = Math.max(Number(params.totalBytes) || 0, Number(params.receivedBytes) || 0);
    if (params.state === "inProgress" && bytes > DOWNLOAD_LIMITS.maxBytes) {
      void this.#cdp?.send("Browser.cancelDownload", { guid }).catch(() => undefined);
      this.#names.delete(guid);
      this.#notes.push(`"${name}" was not downloaded: it is over ${DOWNLOAD_LIMITS.maxBytes / 1024 ** 3} GiB, the most a browser download keeps.`);
      return;
    }
    if (params.state === "canceled") { this.#names.delete(guid); return; }
    if (params.state !== "completed") return;
    this.#names.delete(guid);
    const pending = { guid, name };
    this.#delivering = this.#delivering.then(() => this.#deliver(pending));
  }

  async #deliver(pending: Pending): Promise<void> {
    const { botId, boxId, key, ops } = this.#deps;
    const folder = this.#deps.folder(botId);
    const failed = (why: string) => {
      this.#pending.set(pending.guid, pending);
      this.#notes.push(`"${pending.name}" was downloaded in the browser but could not be brought to your working folder (${why}). It is kept in the browser sandbox for a day and is tried again when this browser closes.`);
    };
    if (!folder) return failed("your working folder is not available right now");
    const to = unusedName(folder, pending.name);
    const fetched = await ops.fetchFile(boxId, `${this.downloadDir}/${pending.guid}`, folder, to).catch((error: unknown) => ({ error: error instanceof Error ? error.message : "it failed" }));
    if ("error" in fetched) return failed(fetched.error);
    this.#pending.delete(pending.guid);
    await ops.removeDownload(boxId, key, pending.guid).catch(() => undefined);
    this.#notes.push(`Downloaded "${pending.name}" into your working folder as ${fetched.path} (${fetched.bytes} bytes).`);
  }
}

/** `downloads/<name>`, or `downloads/<name> (2)` and so on when that is taken, as a browser names a second copy. */
function unusedName(folder: string, name: string): string {
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; n < 1_000; n++) {
    const candidate = join(DOWNLOADS_SUBFOLDER, n === 1 ? name : `${stem} (${n})${extension}`);
    if (!existsSync(join(folder, candidate))) return candidate;
  }
  return join(DOWNLOADS_SUBFOLDER, `${stem} (${Date.now()})${extension}`);
}
