import type { InstanceInfo, ModelSelection } from "@/state/store";
import { isDirectModelDriver } from "../../shared/model-arrangement";

const OFFICIAL_API_HOSTS: Record<string, readonly string[]> = {
  "openai-compat": ["api.openai.com", "openrouter.ai"],
  grok: ["api.x.ai"], minimax: ["api.minimax.io"], mistral: ["api.mistral.ai"],
  cerebras: ["api.cerebras.ai"], groq: ["api.groq.com"], meta: ["api.meta.ai"],
};

const RUNTIME_NAMES: Record<string, string> = {
  claudeAgent: "Claude Code", codex: "Codex", opencodeGo: "OpenCode", piAgent: "pi",
  antigravityAgent: "Antigravity", grokAgent: "Grok", geminiAgent: "Gemini CLI",
  kimiAgent: "Kimi", droidAgent: "Droid", cursorAgent: "Cursor",
  qwenAgent: "Qwen Code", hermesAgent: "Hermes", clineAgent: "Cline",
  museCode: "Muse Code", customAcp: "Custom agent",
};

export type ModelArrangement = {
  agent: string;
  model: string | null;
  route: string | null;
  location: "local" | "hosted" | "unknown";
  direct: boolean;
  modelControlledBy: string;
};

function endpointLocation(url: string | undefined, driverKind: string): ModelArrangement["location"] {
  if (!url) return "unknown";
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (["localhost", "127.0.0.1", "::1"].includes(host)) return "local";
    return OFFICIAL_API_HOSTS[driverKind]?.includes(host) ? "hosted" : "unknown";
  } catch {
    return "unknown";
  }
}

export function modelArrangement(instance: InstanceInfo | undefined, selection: ModelSelection, endpointUrl?: string): ModelArrangement {
  if (!instance) return { agent: "Unavailable connection", model: selection.model && selection.model !== "agent-default" ? selection.model : null,
    route: null, location: "unknown", direct: false, modelControlledBy: "the connection settings" };
  const direct = isDirectModelDriver(instance.driverKind);
  const option = instance.models.options.find((item) => item.id === selection.model);
  const agent = direct ? "OpenMausBot" : RUNTIME_NAMES[instance.driverKind] ?? instance.displayName;
  const model = !selection.model || selection.model === "agent-default" ? null : option?.label ?? selection.model;
  const url = instance.url ?? endpointUrl;
  const route = url ?? option?.provider ?? (direct ? instance.displayName : null);
  const endpoint = endpointLocation(url, instance.driverKind);
  const location = endpoint === "local" || option?.loaded === true ? "local" : endpoint;
  return { agent, model, route, location, direct,
    modelControlledBy: direct ? "OpenMausBot model settings" : `${agent} or its provider settings` };
}
