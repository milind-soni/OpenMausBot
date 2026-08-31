// Where the server's own files live at runtime, and the one place a spawned
// proxy's path is worked out.
//
// This must NOT be resolved relative to the module that happens to need it.
// esbuild inlines modules into an entry bundle (scripts/bundle-server.mjs), so
// a `".."` written inside drivers/claude.ts stops climbing from drivers/ and
// starts climbing from the BUNDLE's directory — one level too high, silently.
//
// That is not hypothetical: it shipped into the 0.1.24 release candidate.
// Every proxy resolved outside Resources/server, so permission prompting,
// computer use and dweb all died on the first turn that needed them, while
// /api/health stayed perfectly green and the packaging checks passed.
//
// This file sits at the server root and is only ever inlined into entries that
// also sit at the server root (index, computer-proxy, container-mcp) — the
// nested drivers/* entries import nothing local, which is what keeps the
// anchor correct in both the dev tree and the bundle. proxy-paths.test.ts pins
// that invariant. Resolve proxies through SPAWNED_PROXIES and nowhere else.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The directory holding the server's runtime files: server/ in dev, the
 * extraResources copy of dist-server/ (Resources/server) in the packaged app. */
export const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));

/** .ts in dev, where node strips types; the compiled sibling once packaged. */
export function resolveProxy(relative: string): string {
  const source = join(SERVER_ROOT, `${relative}.ts`);
  return existsSync(source) ? source : join(SERVER_ROOT, `${relative}.js`);
}

/** Every file the server spawns as its own process. Single source of truth so
 * the smoke test can assert each one actually exists in a packaged layout —
 * the check that would have caught the 0.1.24 breakage. */
export const SPAWNED_PROXIES = {
  computer: resolveProxy("computer-proxy"),
  permission: resolveProxy("permission-proxy"),
  containerMcp: resolveProxy("container-mcp"),
  vpsContainerMcp: resolveProxy("vps-container-mcp"),
  agents: resolveProxy("drivers/agents-proxy"),
  dweb: resolveProxy("drivers/dweb-proxy"),
  connectors: resolveProxy("connector-proxy"),
  phone: resolveProxy("drivers/phone-proxy"),
  // Loaded by the external `pi` process via `-e`, not by this server — but
  // resolved through the same single source of truth so the packaged layout
  // check can assert it ships.
  piMcpExtension: resolveProxy("drivers/pi-mcp-extension"),
} as const;
