// A profile's browser as panes in the desktop app: real pages the person uses directly, driven by the same CDP driver.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PANE_TABS_PER_BROWSER } from "../../../electron/browser-pane-wire.mjs";
import type { Backend, BackendCaps, OpenedBrowser, OpenRequest } from "../backends.ts";
import { CdpBrowser } from "../cdp/browser.ts";
import { browserRoot, profileHash, profileKind, workspaceId } from "../chrome/profile.ts";
import type { CookieSink } from "../cookies/importer.ts";
import { paneSink } from "../cookies/sinks.ts";
import { PaneUnavailable, type OpenedPanes, type PaneLink } from "./link.ts";

const PANE_CAPS: BackendCaps = { persistentProfile: true, window: true, egressGate: true, identityOverride: false, ownsAllTabs: true, downloads: "local", uploads: "path", botPasskeys: false };

/** One empty file per profile whose panes ever opened in this data folder, so deleting a bot touches no partition it never had. */
function marksDir(dataDir: string): string {
  return join(browserRoot(dataDir), "panes");
}

/** Sign-ins are the profile's own and never shared between data folders; a temporary profile's die with the app. */
export function panePartition(dataDir: string, key: string, nonce = () => randomBytes(4).toString("hex")): string {
  const hash = profileHash(workspaceId(dataDir), key);
  return profileKind(key) === "temp" ? `omb-pane-${hash}-${nonce()}` : `persist:omb-pane-${hash}`;
}

export class PaneBackend implements Backend {
  readonly kind = "pane" as const;
  readonly caps = PANE_CAPS;
  readonly #link: PaneLink;
  readonly #dataDir: string;
  readonly #egressPort: (key: string) => Promise<number>;
  readonly #platform: NodeJS.Platform;
  readonly #identity: () => "native" | "cleaned";
  #fallback: Backend | null = null;

  /**
   * `egressPort`: the profile's egress gate, which the panes' partition is proxied through as a launched Chrome is.
   * `identity`: browserEngine.paneIdentity. The driver applies no identity of its own to a pane: no user agent or client
   * hint override, no automation flags; the pane is Electron's Chromium as it is.
   */
  constructor(link: PaneLink, dataDir: string, egressPort: (key: string) => Promise<number>, { platform = process.platform, identity = () => "native" }: { platform?: NodeJS.Platform; identity?: () => "native" | "cleaned" } = {}) {
    this.#link = link;
    this.#dataDir = dataDir;
    this.#egressPort = egressPort;
    this.#platform = platform;
    this.#identity = identity;
  }

  get available(): boolean {
    return this.#link.available;
  }

  /** Where a browser starts while no app window can host a pane (the window is closed to the tray). */
  fallBackTo(backend: Backend): void {
    this.#fallback = backend;
  }

  /** Whether this profile's panes ever opened in this data folder; reads only, so a never-used one writes nothing. */
  used(key: string): boolean {
    if (profileKind(key) === "temp" || !existsSync(marksDir(this.#dataDir))) return false;
    return existsSync(join(marksDir(this.#dataDir), profileHash(workspaceId(this.#dataDir), key)));
  }

  async open(request: OpenRequest): Promise<OpenedBrowser> {
    const partition = panePartition(this.#dataDir, request.key);
    let opened: OpenedPanes;
    try {
      opened = await this.#link.open(request.key, partition, await this.#egressPort(request.key), request.downloadDir, this.#identity());
    } catch (error) {
      if (error instanceof PaneUnavailable && this.#fallback) return this.#fallback.open(request);
      throw error;
    }
    this.#mark(request.key);
    let browser: CdpBrowser;
    try {
      browser = await CdpBrowser.connect(opened.endpoint, { identity: null, headless: false, permissions: false, downloadDir: request.downloadDir, viewport: null, platform: this.#platform, maxPages: PANE_TABS_PER_BROWSER, handleAuth: true });
      if (browser.pages().length === 0 && browser.settingUp().length === 0) await browser.newPage();
    } catch (error) {
      this.#link.close(request.key);
      throw error;
    }
    // What the person did may have changed the page under the bot's refs.
    const offInput = opened.onPersonInput(() => {
      for (const page of browser.pages()) page.refs.invalidateAll();
    });
    // A tab the person hands back may have changed under the bot's refs.
    const offHold = opened.endpoint.onHold((targetId, held) => { if (!held) browser.page(targetId)?.refs.invalidateAll(); });
    const exited = new Promise<void>((resolve) => { browser.connection.onClose(() => { offInput(); offHold(); resolve(); }); });
    return {
      browser,
      pageLimit: null,
      pid: null,
      version: opened.version,
      exited,
      surface: "pane",
      onSiteRefusal: (listener) => opened.endpoint.onRefusal(listener),
      onPersonInput: (listener) => opened.onPersonInput(listener),
      personControl: {
        hold: (targetId, held) => opened.endpoint.hold(targetId, held),
        owner: (targetId) => opened.endpoint.owner(targetId),
        held: (targetId) => opened.endpoint.held(targetId),
        holding: () => opened.endpoint.holding(),
      },
      close: async () => {
        await browser.close();
        this.#link.close(request.key);
      },
    };
  }

  #mark(key: string): void {
    if (profileKind(key) === "temp") return;
    mkdirSync(marksDir(this.#dataDir), { recursive: true, mode: 0o700 });
    writeFileSync(join(marksDir(this.#dataDir), profileHash(workspaceId(this.#dataDir), key)), "");
  }

  /** An imported sign-in, into the profile's partition; marked, so deleting the bot erases it as well. */
  cookieSink(key: string): CookieSink {
    return paneSink(async (cookies) => {
      this.#mark(key);
      return this.#link.setCookies(panePartition(this.#dataDir, key), cookies);
    });
  }

  /** A deleted bot's or profile's pane sign-ins, when its panes ever opened here. */
  erase(key: string): void {
    if (!this.used(key)) return;
    this.#link.erase(panePartition(this.#dataDir, key));
    rmSync(join(marksDir(this.#dataDir), profileHash(workspaceId(this.#dataDir), key)), { force: true });
  }
}
