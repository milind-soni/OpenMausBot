// The workerd binary for tests: OMB_WORKERD_BINARY when set (a binary ensureRuntime fetched), else the one the dev
// dependency on wrangler already installed. Null when neither is there.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

export async function testWorkerdBinary(): Promise<string | null> {
  const given = process.env.OMB_WORKERD_BINARY;
  if (given) return existsSync(given) ? given : null;
  try {
    const fromWrangler = createRequire(createRequire(import.meta.url).resolve("wrangler/package.json"));
    const fromMiniflare = createRequire(fromWrangler.resolve("miniflare"));
    const module = await import(fromMiniflare.resolve("workerd")) as { default: string | { default: string } };
    const binary = typeof module.default === "string" ? module.default : module.default.default;
    return existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}
