import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileAtomic } from "../atomic.ts";
import { antigravityTokenPath } from "./antigravity-acp.ts";

export interface GlobalOAuthCreds {
  access_token?: string;
  refresh_token: string;
  token_type?: string;
  expiry_date?: number;
  id_token?: string;
  scope?: string;
}

export interface OmAcpToken {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  token_uri: string;
  scopes: string[];
  project_id: string;
}

export interface AccountSwitchedInfo {
  refreshToken: string;
  email?: string;
}

export interface GeminiCredentialsWatcherOptions {
  geminiDir?: string;
  baseDir?: string;
  targetTokenPath?: string;
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_PROJECT_ID = "aicode-consumers";

export class GeminiCredentialsWatcher {
  private readonly instanceId: string;
  private readonly onAccountSwitched?: (info: AccountSwitchedInfo) => Promise<void> | void;
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastRefreshToken: string | null = null;
  private readonly geminiDir: string;
  private readonly targetTokenPath: string;
  private readonly debounceMs: number;
  private readonly waiters = new Set<(synced: boolean) => void>();

  constructor(
    instanceId: string,
    onAccountSwitched?: (info: AccountSwitchedInfo) => Promise<void> | void,
    options?: GeminiCredentialsWatcherOptions,
  ) {
    this.instanceId = instanceId;
    this.onAccountSwitched = onAccountSwitched;
    this.geminiDir = options?.geminiDir ?? join(homedir(), ".gemini");
    this.targetTokenPath = options?.targetTokenPath ?? antigravityTokenPath(this.instanceId, options?.baseDir);
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  public start(): void {
    if (this.watcher) return;
    const credsPath = join(this.geminiDir, "oauth_creds.json");
    if (!existsSync(this.geminiDir) && !existsSync(credsPath)) {
      return;
    }

    try {
      if (existsSync(this.geminiDir)) {
        this.watcher = watch(this.geminiDir, { persistent: false }, (_eventType, filename) => {
          if (!filename || filename.includes("oauth_creds") || filename.includes("google_accounts")) {
            this.scheduleSync();
          }
        });
        this.syncCredentials().catch(() => {});
        return;
      }
    } catch {}

    try {
      if (existsSync(credsPath)) {
        this.watcher = watch(credsPath, { persistent: false }, () => {
          this.scheduleSync();
        });
        this.syncCredentials().catch(() => {});
      }
    } catch {}
  }

  public stop(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {}
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const resolve of this.waiters) {
      resolve(false);
    }
    this.waiters.clear();
  }

  public scheduleSync(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.syncCredentials().catch((err) => {
        console.error("[GeminiCredentialsWatcher] Credential sync error:", err);
      });
    }, this.debounceMs);
  }

  public async syncCredentials(): Promise<boolean> {
    const credsPath = join(this.geminiDir, "oauth_creds.json");
    let content: string;
    try {
      content = await readFile(credsPath, "utf8");
    } catch {
      return false;
    }

    let globalCreds: GlobalOAuthCreds;
    try {
      globalCreds = JSON.parse(content) as GlobalOAuthCreds;
    } catch {
      return false;
    }

    if (!globalCreds.refresh_token || globalCreds.refresh_token === this.lastRefreshToken) {
      return false;
    }

    let activeEmail: string | undefined;
    try {
      const accContent = await readFile(join(this.geminiDir, "google_accounts.json"), "utf8");
      const acc = JSON.parse(accContent);
      activeEmail = typeof acc?.active === "string" ? acc.active : undefined;
    } catch {}

    let existingToken: Partial<OmAcpToken> = {};
    try {
      existingToken = JSON.parse(await readFile(this.targetTokenPath, "utf8"));
    } catch {}

    const updatedToken: OmAcpToken = {
      client_id: existingToken.client_id || DEFAULT_CLIENT_ID,
      client_secret: existingToken.client_secret || "",
      refresh_token: globalCreds.refresh_token,
      token_uri: existingToken.token_uri || DEFAULT_TOKEN_URI,
      scopes: globalCreds.scope ? globalCreds.scope.split(" ") : (existingToken.scopes || []),
      project_id: existingToken.project_id || DEFAULT_PROJECT_ID,
    };

    try {
      writeFileAtomic(this.targetTokenPath, JSON.stringify(updatedToken, null, 2), { mode: 0o600 });
    } catch (writeErr) {
      console.warn(`[GeminiCredentialsWatcher] Failed to write token file ${this.targetTokenPath}:`, writeErr);
      return false;
    }

    this.lastRefreshToken = globalCreds.refresh_token;

    if (this.onAccountSwitched) {
      try {
        await this.onAccountSwitched({ refreshToken: globalCreds.refresh_token, email: activeEmail });
      } catch (callbackErr) {
        console.warn("[GeminiCredentialsWatcher] onAccountSwitched callback error:", callbackErr);
      }
    }

    for (const resolve of this.waiters) {
      resolve(true);
    }
    this.waiters.clear();

    return true;
  }

  public async waitForNewToken(timeoutMs = 3000): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter = (synced: boolean) => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(synced);
      };
      timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }
}
