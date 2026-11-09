// No answer ever carries a saved value: a saved secret is only ever replaced.
import { SECRET_VALUE_MAX_BYTES, VAULT_SECRET_NAME_MAX } from "../../shared/vault.ts";
import type { VaultStore } from "../vault-store.ts";
import { isJson, parseBots, type LoginRouteDeps } from "./logins.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface VaultRouteDeps {
  logins: Pick<LoginRouteDeps, "list" | "botExists" | "onePassword">;
  secrets: Pick<VaultStore, "listSecrets" | "saveSecret" | "updateSecret" | "removeSecret">;
}

const SECRETS = "/api/vault/secrets";
const ID = /^[\w-]{1,128}$/u;

export const VAULT_ERRORS = {
  name: `Give the secret a name of at most ${VAULT_SECRET_NAME_MAX} characters.`,
  value: `Enter the secret. It can be at most ${SECRET_VALUE_MAX_BYTES} bytes.`,
} as const;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Absent leaves it. */
function parseName(raw: unknown): Parsed<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const name = typeof raw === "string" ? [...raw].map((ch) => (ch.charCodeAt(0) < 0x20 || ch === "\u007f" ? " " : ch)).join("").trim() : "";
  return name && name.length <= VAULT_SECRET_NAME_MAX ? { ok: true, value: name } : { ok: false, error: VAULT_ERRORS.name };
}

function parseValue(raw: unknown): Parsed<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = typeof raw === "string" ? raw.trim() : "";
  return value && Buffer.byteLength(value) <= SECRET_VALUE_MAX_BYTES ? { ok: true, value } : { ok: false, error: VAULT_ERRORS.value };
}

export function createVaultRoutes(deps: VaultRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== "/api/vault" && !path.startsWith("/api/vault/")) return PASS;
    res.setHeader("cache-control", "no-store");
    if (path === "/api/vault") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      return json(res, 200, { logins: [...deps.logins.list(), ...deps.logins.onePassword.list()], secrets: deps.secrets.listSecrets(), onePassword: deps.logins.onePassword.status() });
    }
    if (path !== SECRETS && !path.startsWith(`${SECRETS}/`)) return json(res, 404, { error: "not found" });
    // JSON only, so a form posted from another local page cannot add or change one.
    if (method !== "GET" && method !== "DELETE" && !isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
    if (path === SECRETS) {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const body = await readBody(req, SECRET_VALUE_MAX_BYTES * 4);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "send the secret as a JSON object" });
      const name = parseName(body.name);
      if (!name.ok || name.value === undefined) return json(res, 400, { error: VAULT_ERRORS.name });
      const value = parseValue(body.value);
      if (!value.ok || value.value === undefined) return json(res, 400, { error: VAULT_ERRORS.value });
      const bots = parseBots(body.bots ?? "all", deps.logins.botExists);
      if (!bots.ok) return json(res, 400, { error: bots.error });
      return json(res, 201, { secret: deps.secrets.saveSecret({ name: name.value, value: value.value, source: "settings", bots: bots.value ?? "all" }) });
    }
    const id = path.slice(`${SECRETS}/`.length);
    if (!ID.test(id)) return json(res, 404, { error: "no such secret" });
    if (method === "DELETE") return deps.secrets.removeSecret(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such secret" });
    if (method !== "PATCH") return json(res, 405, { error: "method not allowed" });
    const body = await readBody(req, SECRET_VALUE_MAX_BYTES * 4);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "send the change as a JSON object" });
    const name = parseName(body.name);
    if (!name.ok) return json(res, 400, { error: name.error });
    const value = parseValue(body.value);
    if (!value.ok) return json(res, 400, { error: value.error });
    const bots = parseBots(body.bots, deps.logins.botExists);
    if (!bots.ok) return json(res, 400, { error: bots.error });
    const secret = deps.secrets.updateSecret(id, {
      ...(name.value === undefined ? {} : { name: name.value }),
      ...(value.value === undefined ? {} : { value: value.value }),
      ...(bots.value === undefined ? {} : { bots: bots.value }),
    });
    return secret ? json(res, 200, { secret }) : json(res, 404, { error: "no such secret" });
  };
}
