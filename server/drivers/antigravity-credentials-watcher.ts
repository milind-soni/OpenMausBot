import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { writeFileAtomic } from "../atomic.ts";
import { antigravityTokenPath, noteAntigravitySignedIn } from "./antigravity-acp.ts";

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

export interface TokenVerificationResult {
  ok: boolean;
  reason?: string;
  permanent?: boolean;
}

export interface GeminiCredentialsWatcherOptions {
  geminiDir?: string;
  baseDir?: string;
  targetTokenPath?: string;
  debounceMs?: number;
  verifyToken?: (token: OmAcpToken) => Promise<TokenVerificationResult>;
  fetchImpl?: typeof fetch;
  verifyTimeoutMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_VERIFY_TIMEOUT_MS = 10_000;
const DEFAULT_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_PROJECT_ID = "aicode-consumers";
export const REQUIRED_ACP_SCOPE = "https://www.googleapis.com/auth/aicode";
export const DEFAULT_ACP_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  REQUIRED_ACP_SCOPE,
] as const;

export function resolveAcpScopes(existingScopes?: string[], globalScope?: string): string[] {
  const base = Array.isArray(existingScopes) && existingScopes.length > 0
    ? existingScopes.filter((s) => typeof s === "string" && s.trim().length > 0)
    : globalScope
      ? globalScope.split(/\s+/u).filter(Boolean)
      : [...DEFAULT_ACP_SCOPES];
  const deduped = Array.from(new Set(base));
  if (!deduped.includes(REQUIRED_ACP_SCOPE)) {
    deduped.push(REQUIRED_ACP_SCOPE);
  }
  return deduped;
}

export async function verifyAcpRefreshTokenScope(
  token: Pick<OmAcpToken, "client_id" | "client_secret" | "refresh_token" | "token_uri" | "scopes">,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<TokenVerificationResult> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: token.client_id,
    client_secret: token.client_secret,
    refresh_token: token.refresh_token,
  });
  const scopeStr = token.scopes.filter(Boolean).join(" ");
  if (scopeStr) {
    params.set("scope", scopeStr);
  }
  try {
    const res = await fetchImpl(token.token_uri || DEFAULT_TOKEN_URI, {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({})) as { error?: string };
      const reason = typeof errBody.error === "string" && errBody.error
        ? errBody.error
        : `HTTP ${res.status}`;
      return { ok: false, reason, permanent: res.status >= 400 && res.status < 500 };
    }
    const body = await res.json().catch(() => ({})) as { access_token?: unknown };
    if (typeof body.access_token !== "string" || !body.access_token) {
      return { ok: false, reason: "missing_access_token", permanent: false };
    }
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason, permanent: false };
  }
}

export class GeminiCredentialsWatcher {
  private readonly instanceId: string;
  private readonly onAccountSwitched?: (info: AccountSwitchedInfo) => Promise<void> | void;
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastRefreshToken: string | null = null;
  private lastRejectedRefreshToken: string | null = null;
  private readonly geminiDir: string;
  public readonly targetTokenPath: string;
  private readonly debounceMs: number;
  private readonly verifyToken?: (token: OmAcpToken) => Promise<TokenVerificationResult>;
  private readonly fetchImpl?: typeof fetch;
  private readonly verifyTimeoutMs?: number;
  private readonly waiters = new Set<(synced: boolean) => void>();
  private syncQueue: Promise<boolean> = Promise.resolve(false);
  private syncGeneration = 0;
  private isStopped = false;

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
    this.verifyToken = options?.verifyToken;
    this.fetchImpl = options?.fetchImpl;
    this.verifyTimeoutMs = options?.verifyTimeoutMs;
  }

  public clearCachedRefreshToken(): void {
    this.lastRefreshToken = null;
    this.lastRejectedRefreshToken = null;
  }

  public start(): void {
    if (this.watcher) return;
    this.isStopped = false;
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
    this.isStopped = true;
    this.syncGeneration++;
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
    if (this.isStopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.syncCredentials().catch((err) => {
        console.error("[GeminiCredentialsWatcher] Credential sync error:", err);
      });
    }, this.debounceMs);
  }

  public async syncCredentials(): Promise<boolean> {
    if (this.isStopped) return false;
    const nextSync = this.syncQueue.then(() => {
      if (this.isStopped) return false;
      return this.doSyncCredentials();
    });
    this.syncQueue = nextSync.catch(() => false);
    return nextSync;
  }

  private async doSyncCredentials(): Promise<boolean> {
    if (this.isStopped) return false;
    const currentGeneration = this.syncGeneration;
    const credsPath = join(this.geminiDir, "oauth_creds.json");
    let content: string;
    try {
      content = await readFile(credsPath, "utf8");
    } catch {
      return false;
    }

    if (this.isStopped || this.syncGeneration !== currentGeneration) return false;

    let globalCreds: GlobalOAuthCreds;
    try {
      globalCreds = JSON.parse(content) as GlobalOAuthCreds;
    } catch {
      return false;
    }

    if (
      !globalCreds.refresh_token
      || globalCreds.refresh_token === this.lastRefreshToken
      || globalCreds.refresh_token === this.lastRejectedRefreshToken
    ) {
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

    if (this.isStopped || this.syncGeneration !== currentGeneration) return false;

    const updatedToken: OmAcpToken = {
      client_id: existingToken.client_id || DEFAULT_CLIENT_ID,
      client_secret: existingToken.client_secret || "",
      refresh_token: globalCreds.refresh_token,
      token_uri: existingToken.token_uri || DEFAULT_TOKEN_URI,
      scopes: resolveAcpScopes(existingToken.scopes, globalCreds.scope),
      project_id: existingToken.project_id || DEFAULT_PROJECT_ID,
    };

    const shouldVerify = Boolean(this.verifyToken) || Boolean(updatedToken.client_id && updatedToken.client_secret);
    if (shouldVerify) {
      const verify = this.verifyToken
        ? await this.verifyToken(updatedToken)
        : await verifyAcpRefreshTokenScope(updatedToken, {
            fetchImpl: this.fetchImpl,
            timeoutMs: this.verifyTimeoutMs,
          });
      if (this.isStopped || this.syncGeneration !== currentGeneration) return false;
      if (!verify.ok) {
        if (verify.permanent) {
          this.lastRejectedRefreshToken = globalCreds.refresh_token;
        }
        const who = activeEmail ? ` for ${activeEmail}` : "";
        console.warn(
          `[GeminiCredentialsWatcher] Refusing to sync incompatible token${who} (${verify.reason ?? "verification_failed"}); keeping existing ACP token.`,
        );
        return false;
      }
    }

    if (this.isStopped || this.syncGeneration !== currentGeneration) return false;

    // Validate that the creds snapshot on disk is still current before committing
    try {
      const freshContent = await readFile(credsPath, "utf8");
      const freshCreds = JSON.parse(freshContent) as GlobalOAuthCreds;
      if (freshCreds.refresh_token !== globalCreds.refresh_token) {
        return false;
      }
    } catch {
      return false;
    }

    if (this.isStopped || this.syncGeneration !== currentGeneration) return false;

    try {
      await mkdir(dirname(this.targetTokenPath), { recursive: true });
      if (this.isStopped || this.syncGeneration !== currentGeneration) return false;
      writeFileAtomic(this.targetTokenPath, JSON.stringify(updatedToken, null, 2), { mode: 0o600 });
      noteAntigravitySignedIn(this.targetTokenPath);
    } catch (writeErr) {
      console.warn(`[GeminiCredentialsWatcher] Failed to write token file ${this.targetTokenPath}:`, writeErr);
      return false;
    }

    if (this.isStopped || this.syncGeneration !== currentGeneration) return false;

    this.lastRefreshToken = globalCreds.refresh_token;
    this.lastRejectedRefreshToken = null;

    noteAntigravitySignedIn(this.targetTokenPath);

    if (this.isStopped || this.syncGeneration !== currentGeneration) return false;

    if (this.onAccountSwitched) {
      try {
        await this.onAccountSwitched({ refreshToken: globalCreds.refresh_token, email: activeEmail });
      } catch (callbackErr) {
        console.warn("[GeminiCredentialsWatcher] onAccountSwitched callback error:", callbackErr);
      }
    }

    if (this.isStopped || this.syncGeneration !== currentGeneration) return false;

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
