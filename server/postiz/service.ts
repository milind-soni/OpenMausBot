// The Postiz connection as the Apps card and Settings → API keys see it. It is one `postiz` MCP server entry, so the
// MCP gate, each bot's server selection and a Team Cloud's scopes treat it like any other.
// Security: a key is checked before it is saved and only ever sent to the address it was saved for; no answer carries a
// key or a token.
import { POSTIZ_SERVER, type PostizStatus } from "../../shared/postiz.ts";
import type { AppConfig } from "../config.ts";
import { keyRejected, noteKeyAccepted, noteKeyRejected } from "../key-rejections.ts";
import { withMcpSignIn, type McpOAuthManager } from "../mcp-oauth.ts";
import { probeMcpServer, type McpProbeResult } from "../mcp-probe.ts";
import { isRemoteMcpServer, parseStoredMcpServer, type StoredMcpServer, type StoredRemoteMcpServer } from "../mcp-registry.ts";
import { postizAddress, postizCloud, postizEntryMethod, postizKeyUrl, postizSignInUrl, savedPostizAddress } from "./connection.ts";

export type PostizProblem = "address" | "unreachable" | "key_rejected" | "not_postiz" | "taken" | "busy" | "managed_policy";
export type PostizRefusal = { status: number; error: string; code: PostizProblem };
export type PostizKeyCheck = { ok: true; tools: number } | ({ ok: false } & PostizRefusal);

export interface PostizDeps {
  cfg(): Pick<AppConfig, "postiz" | "mcpServers">;
  mcpOAuth: McpOAuthManager;
  persistMcpServers(next: Record<string, unknown>): void;
  mcpConfigBusy: { get(): boolean; set(busy: boolean): void };
  mcpPolicyRefusal(name: string, server: object): string | undefined;
  appCatalog?: { serverChanged(name: string): void; forgetServer(name: string): void };
  team: { team: unknown; scopes: { scope(kind: "mcp", id: string): "team" | "person" }; forgetServer(name: string): void };
  /** Plain http to this computer's own Postiz: the desktop only, never a Cloud. */
  loopback: boolean;
  probe?: typeof probeMcpServer;
  now?: () => number;
}

const KEY_CHECK_MS = 15_000;
const RECHECK_MS = 5 * 60_000;
const BUSY_RETRY_MS = 50;
const BUSY_GIVE_UP_MS = 10_000;

const hostOf = (address: string) => { try { return new URL(address).host; } catch { return address; } };

/** What a check's failure means to the person, in words the card can say. */
export function keyCheckRefusal(result: Extract<McpProbeResult, { ok: false }>, address: string): PostizRefusal {
  const host = hostOf(address);
  if (result.reason === "keys" || result.auth === "required") {
    return { status: 400, code: "key_rejected", error: "Postiz didn't accept this API key. Copy it again from Postiz → Settings → Public API." };
  }
  if (result.reason === "unreachable" || result.reason === "timeout") {
    return { status: 400, code: "unreachable", error: `Couldn't reach a Postiz server at ${host}. Check the address and try again.` };
  }
  return { status: 400, code: "not_postiz", error: `${host} didn't answer like Postiz. Check the address. Postiz Cloud's is https://api.postiz.com.` };
}

export function createPostiz(deps: PostizDeps) {
  const probe = deps.probe ?? probeMcpServer;
  const now = deps.now ?? Date.now;
  let checkedAt = -Infinity;

  const entry = (): StoredRemoteMcpServer | null | undefined => {
    const raw = deps.cfg().mcpServers?.[POSTIZ_SERVER];
    if (raw === undefined) return undefined;
    const parsed = parseStoredMcpServer(POSTIZ_SERVER, raw);
    return parsed.ok && isRemoteMcpServer(parsed.server) ? parsed.server as StoredRemoteMcpServer : null;
  };
  /** The entry's method, `taken` for a server named postiz this card did not set up, null for none. */
  const method = (): "sign-in" | "key" | "old-key" | "taken" | null => {
    const current = entry();
    if (current === undefined) return null;
    return current ? postizEntryMethod(current, deps.cfg().postiz) ?? "taken" : "taken";
  };
  const taken: PostizRefusal = { status: 409, code: "taken", error: "An MCP server named postiz is already set up in MCP servers. Remove it there to connect Postiz here." };

  /** Writes the entry once no MCP server edit is in flight, so neither overwrites the other. */
  const write = (next: StoredRemoteMcpServer | null, started = now()): void => {
    if (deps.mcpConfigBusy.get()) {
      if (now() - started < BUSY_GIVE_UP_MS) setTimeout(() => write(next, started), BUSY_RETRY_MS).unref?.();
      return;
    }
    deps.mcpConfigBusy.set(true);
    try {
      const servers = { ...deps.cfg().mcpServers };
      const before = entry();
      if (next) servers[POSTIZ_SERVER] = next; else delete servers[POSTIZ_SERVER];
      deps.persistMcpServers(servers);
      // A sign-in belongs to one address.
      if (!next || before?.url !== next.url) deps.mcpOAuth.forget(POSTIZ_SERVER);
      deps.appCatalog?.forgetServer(POSTIZ_SERVER);
      if (next) deps.appCatalog?.serverChanged(POSTIZ_SERVER);
      checkedAt = -Infinity;
    } finally {
      deps.mcpConfigBusy.set(false);
    }
  };
  const server = (url: string, enabled: boolean): StoredRemoteMcpServer => ({ type: "http", url, headers: {}, enabled });

  const status = (): PostizStatus => {
    const cfg = deps.cfg();
    const address = savedPostizAddress(cfg.postiz);
    const key = cfg.postiz?.key?.trim() ?? "";
    const team = Boolean(deps.team.team);
    const base = {
      address, host: hostOf(address), selfHosted: address !== postizCloud(), keySaved: key !== "",
      team, scope: team ? deps.team.scopes.scope("mcp", POSTIZ_SERVER) : "team" as const,
    };
    const how = method();
    const refusal = deps.mcpPolicyRefusal(POSTIZ_SERVER, server(how === "key" ? postizKeyUrl(address) : postizSignInUrl(), false));
    if (refusal) return { ...base, state: "blocked", how: null, message: refusal };
    if (how === "taken") return { ...base, state: "taken", how: null };
    const current = entry();
    if (!current || (how !== "sign-in" && how !== "key")) return { ...base, state: "not-connected", how: null };
    if (how === "sign-in") {
      const auth = deps.mcpOAuth.authState(POSTIZ_SERVER, current.url);
      if (auth === "needs-sign-in") return { ...base, state: "needs-sign-in", how };
      return { ...base, state: auth === "signed-in" && current.enabled ? "connected" : "not-connected", how };
    }
    if (!key) return { ...base, state: "not-connected", how };
    if (keyRejected(current.url, key)) return { ...base, state: "key-refused", how };
    return { ...base, state: current.enabled ? "connected" : "not-connected", how };
  };

  /** Initialize and tools/list with this key: nothing is saved, no tool runs. */
  const checkKey = async (rawAddress: string | undefined, key: string, signal?: AbortSignal): Promise<PostizKeyCheck> => {
    const address = postizAddress(rawAddress, { loopback: deps.loopback });
    if (!address.ok) return { ok: false, status: 400, code: "address", error: address.error };
    const target = server(postizKeyUrl(address.address), true);
    const refusal = deps.mcpPolicyRefusal(POSTIZ_SERVER, target);
    if (refusal) return { ok: false, status: 403, code: "managed_policy", error: refusal };
    const result = await probe({ ...target, headers: { Authorization: `Bearer ${key.trim()}` } }, KEY_CHECK_MS, signal);
    if (result.ok) return { ok: true, tools: result.total ?? result.tools.length };
    return { ok: false, ...keyCheckRefusal(result, address.address) };
  };

  return {
    status,

    /** Sets the `postiz` entry up for Postiz Cloud's sign-in, still off: the MCP sign-in routes run the sign-in, and the
     * card turns it on once its tools load. */
    prepareSignIn(): { ok: true; status: PostizStatus } | ({ ok: false } & PostizRefusal) {
      if (deps.mcpConfigBusy.get()) return { ok: false, status: 409, code: "busy", error: "MCP servers are being updated. Try again in a moment." };
      if (method() === "taken") return { ok: false, ...taken };
      const url = postizSignInUrl();
      const refusal = deps.mcpPolicyRefusal(POSTIZ_SERVER, server(url, false));
      if (refusal) return { ok: false, status: 403, code: "managed_policy", error: refusal };
      const current = entry();
      if (!current || current.url !== url) write(server(url, false));
      return { ok: true, status: status() };
    },

    checkKey,

    /** Before a config save: the address must be one Postiz can be reached at, and a new key must work there. */
    async configCheck(patch: { postiz?: { key?: string; url?: string } }): Promise<PostizRefusal | null> {
      if (!patch.postiz) return null;
      const cfg = deps.cfg();
      if (patch.postiz.url !== undefined) {
        const address = postizAddress(patch.postiz.url, { loopback: deps.loopback });
        if (!address.ok) return { status: 400, code: "address", error: address.error };
        patch.postiz.url = address.address === postizCloud() ? "" : address.address;
      }
      const key = patch.postiz.key?.trim();
      if (!key) return null;
      if (method() === "taken") return taken;
      const address = patch.postiz.url !== undefined ? patch.postiz.url : cfg.postiz?.url;
      const checked = await checkKey(address || undefined, key);
      return checked.ok ? null : checked;
    },

    /** After a config save: a saved key connects Postiz with it; a removed key, or a key's address changed alone,
     * removes the key's entry. */
    configSaved(patch: { postiz?: { key?: string; url?: string } }): void {
      if (!patch.postiz) return;
      const cfg = deps.cfg();
      const how = method();
      if (how === "taken") return;
      const keyUrl = postizKeyUrl(savedPostizAddress(cfg.postiz));
      const key = cfg.postiz?.key?.trim();
      const current = entry();
      if (patch.postiz.key !== undefined && key) {
        noteKeyAccepted(keyUrl, key);
        if (!current || current.url !== keyUrl || !current.enabled) write(server(keyUrl, true));
        return;
      }
      if (how === "old-key" || (how === "key" && patch.postiz.key !== undefined)) write(null);
    },

    /** Signs out and removes the entry, with every person's own sign-in and key for it. The key itself is removed by
     * the save that stores it (the desktop's encrypted store, or this server's config). */
    async disconnect(): Promise<{ ok: true; status: PostizStatus } | ({ ok: false } & PostizRefusal)> {
      if (deps.mcpConfigBusy.get()) return { ok: false, status: 409, code: "busy", error: "MCP servers are being updated. Try again in a moment." };
      const how = method();
      if (how === "taken") return { ok: false, ...taken };
      const current = entry();
      if (current) {
        await deps.mcpOAuth.signOut(POSTIZ_SERVER, current.url);
        write(null);
        deps.team.forgetServer(POSTIZ_SERVER);
      }
      return { ok: true, status: status() };
    },

    /** The saved connection checked again, at most every few minutes: a revoked sign-in asks for a new one, a revoked
     * key shows as refused. */
    async recheck(signal?: AbortSignal): Promise<PostizStatus> {
      const how = method();
      const current = entry();
      const key = deps.cfg().postiz?.key?.trim();
      if (!current || (how !== "sign-in" && how !== "key") || !current.enabled || now() - checkedAt < RECHECK_MS) return status();
      let target: StoredMcpServer | undefined;
      if (how === "sign-in" && deps.mcpOAuth.authState(POSTIZ_SERVER, current.url) === "signed-in") {
        const signedIn = (await withMcpSignIn({ [POSTIZ_SERVER]: current }, deps.mcpOAuth))[POSTIZ_SERVER];
        if (signedIn && "url" in signedIn) target = { ...current, headers: signedIn.headers };
      } else if (how === "key" && key) {
        target = { ...current, headers: { Authorization: `Bearer ${key}` } };
      }
      if (!target) return status();
      checkedAt = now();
      const result = await probe(target, KEY_CHECK_MS, signal);
      if (!result.ok && how === "sign-in" && (result.auth === "required" || result.reason === "keys")) deps.mcpOAuth.markNeedsSignIn(POSTIZ_SERVER, current.url);
      if (!result.ok && how === "key" && key && result.reason === "keys") noteKeyRejected(current.url, key);
      if (result.ok && how === "key" && key) noteKeyAccepted(current.url, key);
      return { ...status(), ...(result.ok ? { tools: result.total ?? result.tools.length } : {}) };
    },
  };
}

export type Postiz = ReturnType<typeof createPostiz>;
