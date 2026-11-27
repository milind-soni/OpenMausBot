// What rides beside a bot's browser session in the Cloud's browser sandbox, on one more connection through the same door:
// its sign-ins carried in from the home when they changed there, carried back to the home on a clean close, and its
// downloads brought to the bot's working folder as they finish. Uploads go the other way, one file at a time.
import { existsSync, statfsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Cdp, CdpEvent } from "../browser-sites.ts";
import { DOWNLOAD_LIMITS, safeFileName } from "../browser/cdp/downloads.ts";
import type { CloudBrowserRails } from "./rails.ts";
import type { ComputerOps } from "./remote.ts";
import { carryIn, carryOut, cookieId, type SavedCookie } from "./sign-ins.ts";
import { agreed, MAX_SIGN_IN_BYTES, openMerge, prints, sandboxHolds, writeBack, type SyncStore } from "./sync.ts";

/** Where a download lands in the bot's working folder. */
export const DOWNLOADS_SUBFOLDER = "downloads";
/** The largest file an upload copies into the sandbox; a larger one fails that one action with a line. */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** Downloads one session may bring into the Cloud in all. */
export const SESSION_DOWNLOAD_BYTES = 2 * 1024 ** 3;
/** A download is brought over only if the Cloud's disk keeps at least this much free afterwards, and 10% of it. */
const KEEP_FREE_BYTES = 1024 ** 3;
/** A long session's sign-ins are written home this often when they changed, so an unclean end loses minutes at most. */
export const SIGN_IN_SYNC_MS = 10 * 60_000;
const MAX_SIGN_IN_MIB = MAX_SIGN_IN_BYTES / 1024 / 1024;

export interface SignInStore {
  /** The home's saved sign-ins for a session, when they last changed; null when none; "unreadable" when not readable now. */
  load(session: string): { state: { cookies: unknown[]; origins: unknown[] }; modified: number } | null | "unreadable";
  /** The sandbox's cookies saved as the session's; returns when the file changed. */
  save(session: string, cookies: unknown[]): number;
  /** The home's copy kept as a backup as a session opens, before anything of the sandbox's is written to it. */
  backup?(session: string): void;
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
  /** Which side changed the sign-ins since the home and this sandbox last agreed (sync.ts). */
  sync: SyncStore;
  now?: () => number;
  /** Bytes free and in all on the disk of a folder; tests pass their own. */
  disk?(folder: string): { free: number; total: number };
}

/** The home's sign-ins could not be read now: the session opens in the home this time, and the carry is tried next time. */
export class SignInsUnreadable extends Error {}

/** Chrome would not take the home's copy at all (not one cookie's refusal: those are skipped): the session opens in the
 * home, and this copy is not tried again, nor the sandbox woken for it, until the home's copy changes. */
export class CarryFailed extends Error {
  readonly modified: number;
  constructor(modified: number) {
    super("carry failed");
    this.modified = modified;
  }
}

interface Pending { guid: string; name: string; bytes: number }

export class SandboxCompanion {
  readonly #deps: CompanionDeps;
  #cdp: Cdp | null = null;
  readonly #names = new Map<string, string>();
  /** Finished downloads not yet in the bot's folder: kept in the sandbox (a day at most) and tried again at the close. */
  readonly #pending = new Map<string, Pending>();
  readonly #notes: string[] = [];
  #started = 0;
  #delivered = 0;
  readonly #sizes = new Map<string, number>();
  #delivering: Promise<void> = Promise.resolve();
  /** What Chrome really held at the open, or at the last write-back: the session's own changes are measured against it. */
  #baseline: SavedCookie[] | null = null;
  #syncedAt = 0;
  #syncing = false;
  /** Cookies of this session were left out of the home's copy (sync.ts's bounds): said once in the log. */
  #droppedLogged = false;

  constructor(deps: CompanionDeps) { this.#deps = deps; }

  get downloadDir(): string { return `${this.#deps.home}/.omb-browser/.downloads/${this.#deps.key}`; }

  /** Opens its connection, carries the home's sign-ins in when they changed since the last carry, and takes the session's
   * downloads. Throws SignInsUnreadable, or any failure, before the session is used: it then opens in the home. */
  /** The sync stamp is this sandbox's: a replaced sandbox (a fresh, empty profile) gets the home's copy carried in again. */
  get #stamp(): string { return `${this.#deps.boxId}:${this.#deps.key}`; }
  #now(): number { return this.#deps.now?.() ?? Date.now(); }

  async start(cdpUrl: string): Promise<void> {
    const { session, signIns } = this.#deps;
    const loaded = signIns ? signIns.load(session) : null;
    if (loaded === "unreadable") throw new SignInsUnreadable();
    if (signIns && loaded) {
      try { signIns.backup?.(session); }
      catch (error) { this.#deps.log(`browser ${session}: could not keep a backup of the home's sign-ins (${error instanceof Error ? error.name : "error"})`); }
    }
    this.#cdp = await this.#deps.connect(cdpUrl, { event: (message) => this.#event(message) });
    if (signIns) await this.#syncAtOpen(this.#cdp, signIns, loaded);
    this.#syncedAt = this.#now();
    await this.#cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.downloadDir, eventsEnabled: true });
  }

  /** The home and the sandbox profile made to agree at an open (sync.ts has the rules): what the sandbox kept that the home
   * never saw goes home, and the home's copy is set in the sandbox when it differs from what the sandbox holds. */
  async #syncAtOpen(cdp: Cdp, signIns: SignInStore, loaded: Exclude<ReturnType<SignInStore["load"]>, "unreadable">): Promise<void> {
    const { session, rails, sync } = this.#deps;
    const last = sync.load(this.#stamp);
    const sandbox = await carryOut(cdp);
    const home = loaded?.state.cookies ?? [];
    const { merged, fromSandbox, dropped } = openMerge(home, sandbox, last);
    this.#leftOut(dropped);
    let homeAt = loaded?.modified ?? 0;
    if (fromSandbox > 0) {
      homeAt = signIns.save(session, merged);
      this.#deps.log(`browser ${session}: saved ${fromSandbox} sign-in cookies the browser sandbox kept but the home did not have`);
    }
    // The home's storage goes in only when its copy changed since this sandbox last had it.
    const storage = loaded && loaded.modified > rails.carried(this.#stamp) ? loaded.state.origins : [];
    let held = sandbox;
    if (!sandboxHolds(merged, sandbox, last) || storage.length > 0) {
      const carried = await carryIn(cdp, { cookies: merged, origins: storage }).catch(() => { throw new CarryFailed(loaded?.modified ?? 0); });
      held = await carryOut(cdp);
      const kept = new Set(Object.keys(prints(held)));
      const took = merged.filter((cookie) => kept.has(JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey ?? null]))).length;
      this.#deps.log(`browser ${session}: carried ${took} of ${merged.length} saved cookies${carried.refused ? ` (${carried.refused} refused by Chrome)` : ""} and ${carried.origins} sites' storage into the browser sandbox`);
    }
    rails.setCarried(this.#stamp, homeAt);
    sync.save(this.#stamp, { home: prints(merged), sandbox: agreed(held, dropped) });
    this.#baseline = held;
  }

  /** One log line a session, with the count, for cookies of the sandbox's left out of the home's copy. */
  #leftOut(dropped: readonly string[]): void {
    if (dropped.length === 0 || this.#droppedLogged) return;
    this.#droppedLogged = true;
    this.#deps.log(`browser ${this.#deps.session}: left ${dropped.length} of the browser sandbox's cookies out of the home's sign-ins: larger than a browser keeps, or past the ${MAX_SIGN_IN_MIB} MiB the home keeps`);
  }

  /** Writes the session's own cookie changes into the home's copy: set, changed and removed since what Chrome really held
   * at the open (a cookie Chrome dropped by itself is no removal), except a cookie the home changed meanwhile. */
  async syncSignIns(): Promise<void> {
    const { session, rails, signIns, sync } = this.#deps;
    if (!this.#cdp || !signIns || this.#baseline === null || this.#syncing) return;
    this.#syncing = true;
    try {
      const current = await carryOut(this.#cdp);
      this.#syncedAt = this.#now();
      const home = signIns.load(session);
      if (home === "unreadable") return;
      const last = sync.load(this.#stamp);
      const { merged, changed, dropped } = writeBack(home?.state.cookies ?? [], this.#baseline, current, last);
      this.#leftOut(dropped);
      // A cookie left out stays as it was in the baseline, so the next write-back weighs it again.
      const out = new Set(dropped);
      const before = new Map(this.#baseline.map((cookie) => [cookieId(cookie), cookie]));
      this.#baseline = current.flatMap((cookie) => {
        const id = cookieId(cookie);
        if (!out.has(id)) return [cookie];
        const was = before.get(id);
        return was ? [was] : [];
      });
      if (changed > 0) rails.setCarried(this.#stamp, signIns.save(session, merged));
      sync.save(this.#stamp, { home: prints(merged), sandbox: agreed(current, dropped) });
    } finally {
      this.#syncing = false;
    }
  }

  /** From the controller's sweep: a long session's changed sign-ins go home every SIGN_IN_SYNC_MS. */
  async periodic(): Promise<void> {
    if (this.#now() - this.#syncedAt >= SIGN_IN_SYNC_MS) await this.syncSignIns().catch(() => undefined);
  }

  /** Lines for the bot's next browser call: downloads that arrived, or could not. */
  takeNotes(): string[] { return this.#notes.splice(0); }

  /** A file of the Cloud copied into the sandbox for a page's file input; returns its path there, or the line to say. */
  async upload(file: string, name: string | null, size: number): Promise<{ path: string } | { error: string }> {
    const shown = basename(file);
    if (size > UPLOAD_MAX_BYTES) return { error: `${shown} is over ${UPLOAD_MAX_BYTES / 1024 / 1024} MiB, which this browser can't take from the Cloud yet. Tell the person in one sentence and ask them to upload it themselves.` };
    const target = `${this.#deps.home}/.omb-browser/.uploads/${this.#deps.key}/${safeFileName(name ?? shown) || "upload"}`;
    const sent = await this.#deps.ops.sendFile(this.#deps.boxId, dirname(file), shown, target);
    if (!("error" in sent)) return { path: target };
    return { error: `${shown} could not be given to the browser: ${sent.error}${sent.final ? " Tell the person in one sentence and ask them to upload it themselves." : ""}` };
  }

  /** A clean close: downloads still waiting are tried once more, and the sandbox's cookies are saved as the home's. */
  async stop(): Promise<void> {
    await this.#delivering;
    for (const pending of this.#pending.values()) await this.#deliver(pending);
    if (this.#cdp && this.#deps.signIns) {
      try {
        await this.syncSignIns();
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
    const seen = Math.max(Number(params.totalBytes) || 0, Number(params.receivedBytes) || 0);
    if (seen) this.#sizes.set(guid, seen);
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
    const pending = { guid, name, bytes: this.#sizes.get(guid) ?? 0 };
    this.#sizes.delete(guid);
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
    if (this.#delivered + pending.bytes > SESSION_DOWNLOAD_BYTES) return failed(`this browser session already brought ${SESSION_DOWNLOAD_BYTES / 1024 ** 3} GiB of downloads into the Cloud`);
    const disk = (this.#deps.disk ?? diskOf)(folder);
    if (disk.free - pending.bytes < Math.max(KEEP_FREE_BYTES, disk.total / 10)) return failed("the Cloud's disk is too full for it");
    const to = unusedName(folder, pending.name);
    const fetched = await ops.fetchFile(boxId, `${this.downloadDir}/${pending.guid}`, folder, to).catch((error: unknown) => ({ error: error instanceof Error ? error.message : "it failed" }));
    if ("error" in fetched && "final" in fetched && fetched.final) {
      // Never copyable this way (too large while the sandbox takes no direct connections): not kept, nor tried again.
      this.#pending.delete(pending.guid);
      await ops.removeDownload(boxId, key, pending.guid).catch(() => undefined);
      this.#notes.push(`"${pending.name}" was downloaded in the browser but could not be brought to your working folder: ${fetched.error}`);
      return;
    }
    if ("error" in fetched) return failed(fetched.error);
    this.#pending.delete(pending.guid);
    this.#delivered += fetched.bytes;
    await ops.removeDownload(boxId, key, pending.guid).catch(() => undefined);
    this.#notes.push(`Downloaded "${pending.name}" into your working folder as ${fetched.path} (${fetched.bytes} bytes).`);
  }
}

function diskOf(folder: string): { free: number; total: number } {
  const disk = statfsSync(folder);
  return { free: Number(disk.bavail) * Number(disk.bsize), total: Number(disk.blocks) * Number(disk.bsize) };
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
