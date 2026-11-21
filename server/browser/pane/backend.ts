// A profile's browser as panes in the desktop app: real pages the person uses directly, driven by the same CDP driver.
import { randomBytes } from "node:crypto";

import type { Backend, BackendCaps, OpenedBrowser, OpenRequest } from "../backends.ts";
import { CdpBrowser } from "../cdp/browser.ts";
import { profileHash, profileKind, workspaceId } from "../chrome/profile.ts";
import type { PaneLink } from "./link.ts";

const PANE_CAPS: BackendCaps = { persistentProfile: true, window: true, egressGate: false, identityOverride: false, ownsAllTabs: true, downloads: "none", uploads: "path", botPasskeys: false };

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
  readonly #platform: NodeJS.Platform;

  constructor(link: PaneLink, dataDir: string, platform: NodeJS.Platform = process.platform) {
    this.#link = link;
    this.#dataDir = dataDir;
    this.#platform = platform;
  }

  get available(): boolean {
    return this.#link.available;
  }

  async open(request: OpenRequest): Promise<OpenedBrowser> {
    const opened = await this.#link.open(request.key, panePartition(this.#dataDir, request.key));
    let browser: CdpBrowser;
    try {
      browser = await CdpBrowser.connect(opened.endpoint, { identity: null, headless: false, permissions: false, downloadDir: null, viewport: null, platform: this.#platform, maxPages: 8, handleAuth: true });
      if (browser.pages().length === 0 && browser.settingUp().length === 0) await browser.newPage();
    } catch (error) {
      this.#link.close(request.key);
      throw error;
    }
    // What the person did may have changed the page under the bot's refs.
    const offInput = opened.onPersonInput(() => {
      for (const page of browser.pages()) page.refs.invalidateAll();
    });
    const exited = new Promise<void>((resolve) => { browser.connection.onClose(() => { offInput(); resolve(); }); });
    return {
      browser,
      pageLimit: null,
      pid: null,
      version: opened.version,
      exited,
      onPersonInput: (listener) => opened.onPersonInput(listener),
      close: async () => {
        await browser.close();
        this.#link.close(request.key);
      },
    };
  }

  /** A deleted bot's or profile's pane sign-ins. */
  erase(key: string): void {
    if (profileKind(key) !== "temp") this.#link.erase(panePartition(this.#dataDir, key));
  }
}
