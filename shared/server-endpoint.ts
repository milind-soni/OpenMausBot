/** Endpoint resolution shared by the MCP server and the control-omb CLI.
 * Both read the same environment pair (OPENMAUSBOT_URL / OMB_PORT) and apply
 * the same origin rules, so the parsing lives here once. */

/** The environment variables that name an explicit OpenMausBot endpoint. */
export interface ServerEndpointEnv {
  OPENMAUSBOT_URL?: string | undefined;
  OMB_PORT?: string | undefined;
  ALLOW_INSECURE_HTTP?: string | undefined;
}

/** Resolve OPENMAUSBOT_URL / OMB_PORT into an explicit base URL. Returns
 * undefined when neither is set so each caller keeps its own default and
 * discovery behavior; a whitespace-only OPENMAUSBOT_URL counts as unset. */
export function configuredServerUrl(env: ServerEndpointEnv): string | undefined {
  const explicit = env.OPENMAUSBOT_URL?.trim() || "";
  return explicit || (env.OMB_PORT ? `http://127.0.0.1:${env.OMB_PORT}` : undefined);
}

export function validateBaseUrl(url: string, env: ServerEndpointEnv = process.env): string {
  const trimmed = url.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid OpenMausBot URL: '${url}'`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OpenMausBot URL must use http:// or https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("OpenMausBot URL must not contain credentials; use OPENMAUSBOT_TOKEN instead");
  }
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new Error("OpenMausBot URL must be an origin without a path, query, or fragment");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (parsed.protocol === "http:" && !isLoopback && env.ALLOW_INSECURE_HTTP !== "true") {
    throw new Error(
      `Insecure cleartext HTTP origin '${parsed.origin}' is rejected. Use https:// or set ALLOW_INSECURE_HTTP=true.`,
    );
  }
  return parsed.origin;
}
