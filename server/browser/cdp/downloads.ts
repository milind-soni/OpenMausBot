import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import type { CdpSession, Params } from "./connection.ts";
import { DriverError } from "./errors.ts";

export type DownloadState = "inProgress" | "completed" | "canceled";

export interface Download {
  id: string;
  guid: string;
  url: string;
  fileName: string;
  /** The tab whose frame started it, when known. */
  owner: string | null;
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number;
  path: string | null;
  startedAt: number;
  finishedAt: number | null;
  canceledBecause?: string;
}

export interface DownloadLimits {
  maxBytes: number;
  perOwner: number;
}

export const DOWNLOAD_LIMITS: DownloadLimits = { maxBytes: 1024 ** 3, perOwner: 20 };

const UNSAFE_NAME = /[\p{Cc}<>:"/\\|?*]/gu;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]) *(?:\..*)?$/iu;

/** Return a basename within the 255-byte UTF-8 limit, with Windows device names escaped and whole code points retained. */
export function safeFileName(suggested: string): string {
  const base = suggested.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(UNSAFE_NAME, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  const maxBytes = WINDOWS_DEVICE.test(cleaned) ? 254 : 255;
  let name = "";
  let bytes = 0;
  for (const character of cleaned || "download") {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    name += character;
    bytes += size;
  }
  name = name.replace(/[.\s]+$/g, "") || "download";
  return WINDOWS_DEVICE.test(name) ? `_${name}` : name;
}

/** Downloads land as `<dir>/<id>/<name>`: Chrome writes `<dir>/<guid>` (allowAndName) and the finished file moves. */
export class Downloads {
  readonly dir: string;
  readonly #session: CdpSession;
  readonly #ownerOf: (frameId: string) => string | null;
  readonly #limits: DownloadLimits;
  readonly #byGuid = new Map<string, Download>();
  readonly #listeners = new Set<(download: Download) => void>();

  constructor(session: CdpSession, dir: string, { ownerOf, limits = DOWNLOAD_LIMITS }: { ownerOf: (frameId: string) => string | null; limits?: DownloadLimits }) {
    this.#session = session;
    this.dir = dir;
    this.#ownerOf = ownerOf;
    this.#limits = limits;
    session.on("Browser.downloadWillBegin", (params) => this.#begin(params));
    session.on("Browser.downloadProgress", (params) => this.#progress(params));
  }

  async enable(): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    await this.#session.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.dir, eventsEnabled: true });
  }

  list(owner?: string): Download[] {
    return [...this.#byGuid.values()].filter((download) => owner === undefined || download.owner === owner);
  }

  onChange(listener: (download: Download) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The next download `match` accepts to finish, completed or canceled. */
  finished(match: (download: Download) => boolean, timeoutMs = 30_000): Promise<Download> {
    const done = [...this.#byGuid.values()].find((download) => download.state !== "inProgress" && match(download));
    if (done) return Promise.resolve(done);
    return new Promise((resolve, reject) => {
      const off = this.onChange((download) => {
        if (download.state === "inProgress" || !match(download)) return;
        off();
        clearTimeout(timer);
        resolve(download);
      });
      const timer = setTimeout(() => {
        off();
        reject(new DriverError("timeout", `No download finished within ${timeoutMs} ms.`));
      }, timeoutMs);
    });
  }

  #emit(download: Download): void {
    for (const listener of this.#listeners) {
      try { listener(download); } catch {}
    }
  }

  #begin(params: Params): void {
    const guid = String(params.guid);
    const download: Download = {
      id: randomUUID(),
      guid,
      url: String(params.url ?? "").slice(0, 2_048),
      fileName: safeFileName(String(params.suggestedFilename ?? "")),
      owner: this.#ownerOf(String(params.frameId ?? "")),
      state: "inProgress",
      receivedBytes: 0,
      totalBytes: 0,
      path: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    this.#byGuid.set(guid, download);
    this.#emit(download);
  }

  #progress(params: Params): void {
    const download = this.#byGuid.get(String(params.guid));
    if (!download || download.state !== "inProgress") return;
    download.receivedBytes = Number(params.receivedBytes) || 0;
    download.totalBytes = Number(params.totalBytes) || 0;
    if (params.state === "inProgress") {
      if (Math.max(download.receivedBytes, download.totalBytes) > this.#limits.maxBytes) {
        download.canceledBecause = `larger than ${this.#limits.maxBytes} bytes`;
        void this.#session.send("Browser.cancelDownload", { guid: download.guid }).catch(() => {});
      }
      return;
    }
    download.finishedAt = Date.now();
    const written = typeof params.filePath === "string" ? params.filePath : join(this.dir, download.guid);
    try {
      if (params.state === "completed" && !download.canceledBecause) this.#keep(download, written);
      else {
        download.state = "canceled";
        rmSync(written, { force: true });
      }
    } finally {
      this.#emit(download);
    }
  }

  #keep(download: Download, written: string): void {
    try {
      const size = statSync(written).size;
      if (size > this.#limits.maxBytes) throw new Error(`larger than ${this.#limits.maxBytes} bytes`);
      const folder = join(this.dir, download.id);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, download.fileName);
      renameSync(written, path);
      download.path = path;
      download.receivedBytes = size;
      download.state = "completed";
    } catch (error) {
      download.state = "canceled";
      download.canceledBecause = error instanceof Error ? error.message : String(error);
      rmSync(written, { force: true });
      return;
    }
    const kept = this.list().filter((entry) => entry.owner === download.owner && entry.state === "completed" && entry.path);
    for (const evicted of kept.slice(0, Math.max(0, kept.length - this.#limits.perOwner))) {
      rmSync(join(this.dir, evicted.id), { recursive: true, force: true });
      this.#byGuid.delete(evicted.guid);
    }
  }
}
