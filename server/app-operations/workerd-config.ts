// The workerd config for one app's process, and the module that turns a request from our server into a call of the app's
// operation with its ctx.
//
// Security (workerd 1.20261110.1, open-source build):
// - globalOutbound is a network service that allows no address, so fetch() and connect() reach nothing: public, private,
//   loopback and unix addresses are all refused by workerd's peer filter, and https has no TLS client at all.
// - The only binding is HOST, an external service at our host-service socket. workerd adds the app's secret header to
//   every request to it and removes any header of that name the worker set, so the secret is never visible to the
//   worker's JavaScript and cannot be forged by it. Any module of the app can still reach HOST (cloudflare:workers
//   exposes env), so the host service decides everything from the secret and an invocation token it issued itself.
// - No disk service, no nodejs_compat flag: no node: modules, no process, no require, no file system.
// - The V8 heap is capped by --max-old-space-size; past it, the whole process aborts (our server restarts it). CPU time is
//   not limited by the open-source workerd build: an endless loop wedges the process until our server kills it.

export interface WorkerdConfigOptions {
  /** "unix:/path" or "127.0.0.1:0": where workerd listens for our calls. */
  listen: string;
  /** "unix:/path" or "127.0.0.1:port": our host service. */
  host: string;
  secret: string;
  compatibilityDate: string;
  heapMb: number;
}

export const APP_SECRET_HEADER = "x-omb-app-secret";
export const INVOCATION_HEADER = "x-omb-invocation";

const text = (value: string) => JSON.stringify(value);

export function workerdConfig(options: WorkerdConfigOptions): string {
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "app", worker = (
      modules = [
        (name = "main.js", esModule = embed "main.js"),
        (name = "operations.js", esModule = embed "operations.js"),
      ],
      compatibilityDate = ${text(options.compatibilityDate)},
      bindings = [ (name = "HOST", service = "host") ],
      globalOutbound = "nowhere",
    )),
    (name = "host", external = (
      address = ${text(options.host)},
      http = (injectRequestHeaders = [ (name = ${text(APP_SECRET_HEADER)}, value = ${text(options.secret)}) ]),
    )),
    (name = "nowhere", network = (allow = [])),
  ],
  sockets = [ (name = "http", address = ${text(options.listen)}, http = (), service = "app") ],
  v8Flags = [ ${text(`--max-old-space-size=${options.heapMb}`)} ],
);
`;
}

/** The app's entry module. Our server posts { name, input, invocation }; the answer is { ok, result } or { ok: false, code, error }. */
export const WRAPPER_MODULE = `import * as operations from "./operations.js";

function host(env, invocation, path, body) {
  return env.HOST.fetch("http://host" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ${JSON.stringify(INVOCATION_HEADER)}: invocation },
    body: JSON.stringify(body),
  }).then(async (response) => {
    const answer = await response.json();
    if (!response.ok) {
      const error = new Error(answer.error || "The host refused this.");
      error.code = answer.code;
      throw error;
    }
    return answer.value;
  });
}

export default {
  async fetch(request, env) {
    const { name, input, invocation } = await request.json();
    const operation = Object.prototype.hasOwnProperty.call(operations, name) ? operations[name] : undefined;
    if (typeof operation !== "function") {
      return Response.json({ ok: false, code: "unknown_operation", error: "server/operations.js exports no function " + name + "." });
    }
    const logs = [];
    const ctx = Object.freeze({
      input,
      db: Object.freeze({
        query: (sql, params) => host(env, invocation, "/db/query", { sql, params }),
        exec: (sql, params) => host(env, invocation, "/db/exec", { sql, params }),
      }),
      data: Object.freeze({ query: (sql, params) => host(env, invocation, "/data/query", { sql, params }) }),
      connectors: Object.freeze({ call: (connector, tool, args) => host(env, invocation, "/connectors/call", { connector, tool, args }) }),
      log: (...parts) => { logs.push(host(env, invocation, "/log", { text: parts.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" ") }).catch(() => {})); },
    });
    let answer;
    try {
      const result = await operation(input, ctx);
      answer = { ok: true, result: result === undefined ? null : result };
    } catch (error) {
      answer = { ok: false, code: (error && error.code) || "operation_failed", error: String((error && error.message) || error) };
    }
    await Promise.allSettled(logs);
    return Response.json(answer);
  },
};
`;
