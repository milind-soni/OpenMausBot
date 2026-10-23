import type { AppConfig } from "./config-types.ts";

export function openaiCompatConnectionUrl(cfg: AppConfig): string {
  const config = cfg.instances?.openaiCompat?.config as { url?: unknown } | undefined;
  return typeof config?.url === "string" && config.url ? config.url : cfg.openaiCompat?.url || "https://openrouter.ai/api/v1";
}
