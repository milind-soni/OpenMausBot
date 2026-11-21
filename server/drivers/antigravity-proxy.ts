import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ProxyAuth {
  username?: string;
  password?: string;
}

export interface ProxyEntry {
  id: string;
  name?: string;
  url: string;
  auth?: ProxyAuth | null;
  enabled?: boolean;
  priority?: number;
  latency?: number | null;
}

export interface ProxyPoolConfig {
  enabled?: boolean;
  proxies?: ProxyEntry[];
  account_bindings?: Record<string, string>;
  strategy?: string;
  auto_failover?: boolean;
}

export interface AntigravityAccountItem {
  id: string;
  email?: string;
  name?: string;
  disabled?: boolean;
  proxy_disabled?: boolean;
  proxy_id?: string;
}

export interface AntigravityAccountsIndex {
  accounts?: AntigravityAccountItem[];
  current_account_id?: string;
  current_classic_account_id?: string;
}

export async function resolveAccountProxy(
  activeEmailOrId?: string,
  toolsDir?: string,
): Promise<string | undefined> {
  if (!activeEmailOrId) return undefined;

  const baseDir = toolsDir ?? join(homedir(), ".antigravity_tools");

  let guiConfig: { proxy_pool?: ProxyPoolConfig } | undefined;
  let accountsIndex: AntigravityAccountsIndex | undefined;

  try {
    const guiRaw = await readFile(join(baseDir, "gui_config.json"), "utf8");
    guiConfig = JSON.parse(guiRaw);
  } catch {
    return undefined;
  }

  const proxyPool = guiConfig?.proxy_pool;
  if (!proxyPool || proxyPool.enabled === false || !Array.isArray(proxyPool.proxies)) {
    return undefined;
  }

  try {
    const accRaw = await readFile(join(baseDir, "accounts.json"), "utf8");
    accountsIndex = JSON.parse(accRaw);
  } catch {
    return undefined;
  }

  const accounts = accountsIndex?.accounts;
  if (!Array.isArray(accounts)) return undefined;

  const matchedAccount = accounts.find(
    (a) => a.id === activeEmailOrId || a.email === activeEmailOrId,
  );
  if (!matchedAccount || matchedAccount.proxy_disabled === true) {
    return undefined;
  }

  const proxyId = proxyPool.account_bindings?.[matchedAccount.id] ?? matchedAccount.proxy_id;
  if (!proxyId) return undefined;

  const proxy = proxyPool.proxies.find(
    (p) => p.id === proxyId && p.enabled !== false,
  );
  if (!proxy || !proxy.url) return undefined;

  if (proxy.auth?.username && proxy.auth?.password) {
    try {
      const urlObj = new URL(proxy.url);
      urlObj.username = proxy.auth.username;
      urlObj.password = proxy.auth.password;
      return urlObj.toString();
    } catch {
      return proxy.url;
    }
  }

  return proxy.url;
}
