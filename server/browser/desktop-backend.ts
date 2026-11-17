import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Backend, BackendCaps, OpenedBrowser, OpenRequest } from "./backends.ts";
import { CdpBrowser } from "./cdp/browser.ts";
import { browserRoot, workspaceId } from "./chrome/profile.ts";
import { DesktopBrowserClient } from "./desktop-bridge.ts";

const CAPS: BackendCaps = {
  persistentProfile: true,
  window: false,
  egressGate: true,
  identityOverride: false,
  ownsAllTabs: true,
  downloads: "local",
  uploads: "path",
  botPasskeys: false,
};

export class DesktopBackend implements Backend {
  readonly kind = "desktop" as const;
  readonly caps = CAPS;
  readonly #client: DesktopBrowserClient;
  readonly #dataDir: string;
  readonly #egress: (key: string) => Promise<number>;

  constructor(options: { client: DesktopBrowserClient; dataDir: string; egressPort(key: string): Promise<number> }) {
    this.#client = options.client;
    this.#dataDir = resolve(options.dataDir);
    this.#egress = options.egressPort;
  }

  profileId(key: string): string {
    return createHash("sha256").update(workspaceId(this.#dataDir)).update("\0").update(key).digest("hex");
  }

  #marker(key: string): string {
    return join(browserRoot(this.#dataDir), "native-profiles", `${this.profileId(key)}.json`);
  }

  recorded(key: string): boolean {
    return existsSync(join(browserRoot(this.#dataDir), "native-profiles")) && existsSync(this.#marker(key));
  }

  available(): boolean {
    return this.#client.available;
  }

  summary(): { kind: "engine"; version: string; chrome: string } | { kind: "unavailable"; reason: string } {
    return this.available()
      ? { kind: "engine", version: "desktop-cdp", chrome: this.#client.product }
      : { kind: "unavailable", reason: "The native browser requires the local OpenMausBot desktop app." };
  }

  async #closeProfile(profileId: string, marker: string, persistent: boolean): Promise<void> {
    await this.#client.request("close", profileId);
    if (!persistent && existsSync(marker)) unlinkSync(marker);
  }

  async open(request: OpenRequest): Promise<OpenedBrowser> {
    if (!this.available()) throw new Error("The native browser requires the local desktop app.");
    const profileId = this.profileId(request.key);
    const persistent = !request.key.startsWith("temp:");
    const proxyPort = await this.#egress(request.key);
    const marker = this.#marker(request.key);
    mkdirSync(join(browserRoot(this.#dataDir), "native-profiles"), { recursive: true, mode: 0o700 });
    writeFileSync(marker, JSON.stringify({ version: 1, persistent }), { mode: 0o600 });
    const transport = await this.#client.open(profileId, { persistent, proxyPort, fresh: request.fresh }).catch(async error => {
      await this.#closeProfile(profileId, marker, persistent).catch(() => undefined);
      throw error;
    });
    let browser: CdpBrowser;
    try {
      browser = await CdpBrowser.connect(transport, {
        identity: null,
        headless: false,
        focusEmulation: true,
        viewport: null,
        interceptFileChooser: true,
        downloadDir: request.downloadDir,
        handleAuth: true,
        maxPages: 8,
      });
      const selected = this.#client.selectedTarget(profileId);
      if (selected) {
        const page = await browser.waitForPage(candidate => candidate.targetId === selected, 15_000);
        await browser.bringToFront(page);
      }
    } catch (error) {
      await this.#closeProfile(profileId, marker, persistent).catch(() => undefined);
      transport.close();
      throw error;
    }
    let ended!: () => void;
    const exited = new Promise<void>(resolve => { ended = resolve; });
    transport.onClose(() => ended());
    const client = this.#client;
    return {
      browser,
      pid: null,
      version: client.product,
      exited,
      native: {
        grant: async (targetId, viewerId, person, canOperate) => {
          const result = await client.request("grant", profileId, { targetId, viewerId: person, viewId: viewerId, canOperate });
          if (typeof result.token !== "string") throw new Error("Native view grant is unavailable.");
          return result.token;
        },
        revoke: async token => { await client.request("ungrant", profileId, { token }); },
        control: (owner, ready) => client.setControl(profileId, owner, ready),
        authorizeFile: async (path, roots) => {
          const result = await client.request("authorize-file", profileId, { path, roots });
          if (typeof result.url !== "string") throw new Error("The native artifact could not open.");
          return result.url;
        },
      },
      close: async () => {
        await browser.close();
        await this.#closeProfile(profileId, marker, persistent);
      },
    };
  }

  async erase(key: string): Promise<void> {
    if (!this.recorded(key)) return;
    const marker = this.#marker(key);
    if (!this.available()) throw new Error("Open the local desktop app to finish deleting its native browser profile.");
    await this.#client.request("erase", this.profileId(key));
    unlinkSync(marker);
  }
}
