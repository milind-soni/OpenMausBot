/** Musterd product surface: lean local harness vs upstream-parity full build. */

export type ProductEdition = "local" | "full";

/** `MUSTERD_EDITION` / `OMB_EDITION`; default `local`. */
export function productEdition(env: NodeJS.ProcessEnv = process.env): ProductEdition {
  const raw = (env.MUSTERD_EDITION ?? env.OMB_EDITION ?? "local").trim().toLowerCase();
  return raw === "full" ? "full" : "local";
}

export function isLocalEdition(env: NodeJS.ProcessEnv = process.env): boolean {
  return productEdition(env) === "local";
}

export function isFullEdition(env: NodeJS.ProcessEnv = process.env): boolean {
  return productEdition(env) === "full";
}
