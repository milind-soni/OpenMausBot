import type { ModelCatalog } from "../contracts.ts";

interface PiModelEntry {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
}

interface PiModelsResponse {
  type: "response";
  command: "get_available_models";
  success: boolean;
  data?: { models?: PiModelEntry[] };
}

export function piCatalogFromFrame(frame: unknown, fallbackDefault: string): ModelCatalog | null {
  const res = frame as PiModelsResponse;
  if (res?.type !== "response" || res.command !== "get_available_models" || !res.success) return null;
  const options: Array<{ id: string; label: string; custom: true; provider: string; contextWindow?: number }> = [];
  for (const m of res.data?.models ?? []) {
    if (!m?.provider || !m?.id) continue;
    const id = `${m.provider}/${m.id}`;
    const contextWindow = m.contextWindow;
    options.push({
      id, label: m.name ?? m.id, custom: true, provider: m.provider,
      ...(typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    });
  }
  return { default: fallbackDefault || (options[0]?.id ?? ""), options };
}

export function parsePiCatalog(stdout: string, fallbackDefault = ""): ModelCatalog {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const catalog = piCatalogFromFrame(msg, fallbackDefault);
    if (catalog) return catalog;
  }
  return { default: fallbackDefault, options: [] };
}
