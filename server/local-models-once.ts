// A local model is offered to a bot once. Claude and Codex each list the models a local server on this computer serves
// (Ollama, LM Studio and the like, local-inject.ts), because both can route a turn to one. When the person has also set
// up the Other (OpenAI-compatible) engine on that same server, the model is listed there too: three entries for one
// model in list_models. So a model that engine offers is not listed again under Claude or Codex there; one short line
// says those two can still run it with their own tools. Only the bot's list_models changes: the model picker and
// Settings list what they always did, and an id runs whether or not a list shows it.
import { INJECT_SEP, localHost } from "./drivers/local-inject.ts";
import { pickedName } from "./drivers/ollama-context.ts";
import { OpenAICompatDriver } from "./drivers/openai-compat.ts";

/** The engines whose lists carry local models only as a second route to them. */
const ROUTED_THROUGH = new Set(["claudeAgent", "codex"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** A server on this computer, by port: 127.0.0.1, localhost and ::1 are one place, and /v1 or not is one server. */
export function localServer(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!LOOPBACK.has(parsed.hostname.toLowerCase())) return null;
    return `${parsed.protocol}//loopback:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return null;
  }
}

/** One name for a model however it is spelled: `gemma4` and `gemma4:latest`, and the app's own names that carry a window. */
const sameModel = (model: string) => {
  const name = pickedName(model).toLowerCase();
  return name.endsWith(":latest") ? name.slice(0, -":latest".length) : name;
};

const key = (server: string, model: string) => `${server} ${sameModel(model)}`;

export interface DirectLocalEngine {
  driver: string;
  enabled?: boolean;
  hidden?: boolean;
  config?: unknown;
}

export interface DirectLocal {
  /** server+model pairs the Other engine offers. */
  models: Set<string>;
  /** Its name, by instance id, for the line that says Claude and Codex can still run them. */
  names: Map<string, string>;
}

/** The server+model pairs an Other (OpenAI-compatible) engine on this computer offers now: its saved model and its list,
 * which for Ollama is everything the server holds. `offered(instanceId)` gives the models a bot could open a thread on
 * there (ready, allowed by the organization and by this server), or null when none: a blocked or unavailable Other
 * engine never takes a model away from Claude and Codex. */
export function directLocalModels(
  configs: Readonly<Record<string, DirectLocalEngine>>,
  offered: (instanceId: string, models: readonly string[]) => { name: string; models: readonly string[] } | null,
): DirectLocal {
  const direct: DirectLocal = { models: new Set(), names: new Map() };
  for (const [instanceId, entry] of Object.entries(configs)) {
    if (entry.driver !== "openai-compat" || entry.enabled === false || entry.hidden === true) continue;
    let config: { url: string; model?: string };
    try {
      // As the engine reads it: the saved address, else the one the server was started with.
      config = OpenAICompatDriver.decodeConfig(entry.config);
    } catch {
      continue;
    }
    const server = localServer(config.url);
    if (!server) continue;
    const engine = offered(instanceId, config.model ? [config.model] : []);
    if (!engine?.models.length) continue;
    direct.names.set(instanceId, engine.name);
    for (const model of engine.models) direct.models.add(key(server, model));
  }
  return direct;
}

/** The server+model a Claude or Codex local id routes to, when it is one. */
function routedTo(id: string): string | null {
  const sep = id.indexOf(INJECT_SEP);
  const host = sep > 0 ? localHost(id.slice(0, sep)) : undefined;
  const server = host && localServer(host.baseUrl);
  return server ? key(server, id.slice(sep + INJECT_SEP.length)) : null;
}

type Listed = { instanceId: string; driverKind: string; displayName: string | undefined; models: { default: string; options: ReadonlyArray<{ id: string }> } };

/** `engines` with Claude's and Codex's copies of a model the Other engine offers left out, and, when any was, the line
 * that keeps the second route known. The current model and the bot's own are listed by the menu whatever this leaves. */
export function localModelsOnce<E extends Listed>(engines: readonly E[], direct: DirectLocal): { engines: E[]; also?: string } {
  if (!direct.models.size) return { engines: [...engines] };
  const routes = new Map<string, Set<string>>();
  const listed = engines.map((engine) => {
    if (!ROUTED_THROUGH.has(engine.driverKind)) return engine;
    const options = engine.models.options.filter((option) => {
      const routed = routedTo(option.id);
      if (!routed || !direct.models.has(routed)) return true;
      const ids = routes.get(engine.instanceId) ?? new Set<string>();
      routes.set(engine.instanceId, ids.add(option.id.slice(0, option.id.indexOf(INJECT_SEP))));
      return false;
    });
    return options.length === engine.models.options.length ? engine : { ...engine, models: { ...engine.models, options } };
  });
  if (!routes.size) return { engines: listed };
  const through = engines.filter((engine) => routes.has(engine.instanceId)).map((engine) => engine.displayName || engine.instanceId);
  const hosts = [...new Set([...routes.values()].flatMap((ids) => [...ids]))].map((host) => `"${host}${INJECT_SEP}<model>"`).join(" or ");
  return { engines: listed, also: `${[...direct.names.values()].join(", ")}'s local models also run on ${through.join(", ")} with their own tools: model ${hosts}` };
}
