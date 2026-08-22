// OpenCode harness support — `opencode acp` over ACP stdio, riding the generic
// runtime in acp/core.ts. Verified against opencode 1.18.18.
//
// Two things set OpenCode apart from the other ACP harnesses:
//
// 1. It is provider-plural. The model list is whatever the user has
//    credentials for — 471 entries on a configured machine, 7 (the free
//    OpenCode Zen ones) on a virgin HOME — so the catalog is discovered at
//    runtime instead of compiled in. And `opencode acp` takes no -m, so the
//    model is set with session/set_config_option (support.selectModel).
//
// 2. It cards none of the tools that matter. Measured on 1.18.18 with nothing injected: the
//    stock `build` agent's only catch-all rule is {permission:"*",
//    action:"allow", pattern:"*"}, and bash, edit and webfetch have no rule of
//    their own to override it, so all three resolve to `allow`. A bot would run
//    shell commands, write files and fetch URLs with no approval card at any
//    point. Injecting ASK_POLICY below is what makes OpenMausBot's cards work
//    for this engine, and it is the main thing this driver does beyond speaking
//    ACP.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { execCli } from "../../procs.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";

import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";

type Env = Record<string, string | undefined>;

const CATALOG_TTL_MS = 60_000;
// Bounds every execCli call in this file (`opencode models` and `debug
// config`). ProviderInstance.catalog's contract requires discovery to bound
// its own latency: describe() awaits every instance together, so a call
// that never settles stalls the whole /api/instances response, and server
// startup with it, not just this row. Measured at ~1.1s against 1.18.18;
// 10s leaves generous slack for a slower machine while landing close to
// core.ts's 8s snapshot() version-probe ceiling — describe() awaits that
// and this back to back for the same instance, so the two bounds stack,
// and the previous 20s let this half alone run two and a half times as
// long as the other.
const CLI_TIMEOUT_MS = 10_000;

// Injectable so the TTL can be tested by moving time rather than waiting for
// it — a test that needs a sleep to pass is wrong.
let now: () => number = () => Date.now();
const cache = new Map<string, { at: number; value: ModelCatalog }>();
// The cache only collapses callers that arrive one after another. describe()
// awaits snapshot() — which asks isAuthenticated, which discovers — before it
// awaits catalog(), so that pair is already free. Two /api/instances requests
// in flight together are not: both would miss the cache and both would spawn
// the CLI. Holding the in-flight promise makes the second one wait on the
// first instead.
const inFlight = new Map<string, Promise<ModelCatalog>>();

export const __catalogTestHooks = {
  reset() {
    cache.clear();
    inFlight.clear();
    now = () => Date.now();
  },
  setClock(clock: () => number) {
    now = clock;
  },
};

/** Run an opencode subcommand, resolving to null on any failure.
 *  `opencode models` is ~15 KB; the buffer is generous so a machine with many
 *  providers cannot silently truncate its own catalog.
 *
 *  These are NOT read-only, and an earlier version of this comment said they
 *  were — a maintainer can disprove it in one command, so say it here instead.
 *  Measured on 1.18.18, one `opencode models` against a genuinely empty HOME:
 *
 *      ~/.cache/opencode/models.json                3.8 MB, created
 *      ~/.config/opencode/opencode.jsonc            seeded (with a .gitignore)
 *      ~/.local/share/opencode/opencode.db{,-wal,-shm}  created
 *      ~/.local/state/opencode/locks/<hash>.lock/   created
 *
 *  The working directory is untouched. Choosing these over an ACP probe still
 *  stands — a stray model cache is not a stray session, and no turn, no
 *  session and no prompt is created — but it is a smaller claim than "no side
 *  effect at all". One consequence worth knowing before writing a test: the
 *  FIRST probe on a fresh HOME returned 8 models and the second 7, so the free
 *  OpenCode Zen list is not an invariant and must not be asserted as one. */
function run(cli: string, args: string[], env: Env, cwd: string | undefined): Promise<string | null> {
  return new Promise((resolve) => {
    execCli(cli, args, { timeout: CLI_TIMEOUT_MS, env, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

/** Where a probe runs. core.ts computes a turn's cwd as
 *  `turn.cwd ?? config.workspace ?? homedir()`; a catalog probe has no turn, so
 *  it matches the other two terms. Left to itself, execCli inherits the
 *  SERVER's cwd — wherever the app happened to be launched from, which is both
 *  non-deterministic and the wrong directory: in fullAuto, where project config
 *  stays enabled, a project-defined provider is runnable by the turn and
 *  invisible to the catalog. */
const probeCwd = (config: AcpConfig): string => config.workspace ?? homedir();

/** The model opencode itself would use. `debug config` is a debug command with
 *  no stability promise, so its failure is absorbed: the default falls back to
 *  the first catalog entry, which on a machine with no credentials is a free
 *  OpenCode Zen model.
 *
 *  `raw` IS A SECRET. `debug config` echoes the whole resolved config, which on
 *  a real machine carries MCP server credentials — measured: a token in an
 *  `mcp.*.environment` entry and a token inside an argv array both came back
 *  verbatim. So it is read for `.model` and dropped: never logged, never
 *  cached, and run() swallows the error object too (which would quote the
 *  command line on a spawn failure). Keep it that way — a `console.error(raw)`
 *  added while debugging this function would put the user's tokens in a log
 *  file. CONTRIBUTING.md:113-117 is the standing rule. */
async function defaultModel(cli: string, env: Env, cwd: string | undefined): Promise<string | null> {
  const raw = await run(cli, ["debug", "config"], env, cwd);
  if (!raw) return null;
  try {
    const model = JSON.parse(raw)?.model;
    return typeof model === "string" && model ? model : null;
  } catch {
    return null;
  }
}

/** Two instances can point at the same binary through different homes or
 *  configs and legitimately see different catalogs, so the key carries where
 *  opencode reads its config from AND what that config says.
 *
 *  It does NOT carry ambient provider credentials. Measured against 1.18.18,
 *  each of these alone changes what `opencode models` lists — the keys are not
 *  validated, so a bogus value is enough: ANTHROPIC_API_KEY (7 -> 22 lines),
 *  OPENAI_API_KEY (7 -> 55), OPENROUTER_API_KEY (7 -> 358). Enumerating every
 *  provider variable opencode auto-detects would be a list that goes stale
 *  upstream, so the honest statement of the bound is: two instances differing
 *  ONLY by an API key share one catalog for up to CATALOG_TTL_MS. Keying on the
 *  whole env is not the alternative — three tests mutate FAKE_ACP_MODELS as
 *  their "did it re-probe" signal, and a whole-env key would make every such
 *  mutation a cache miss.
 *
 *  The Windows half is not decoration either: HOME and the XDG_* variables are
 *  all undefined there, so a key naming only those collapses every opencode
 *  instance onto one entry — the silent-failure shape CONTRIBUTING.md forbids.
 *
 *  JSON rather than a joined string: joining on a separator lets a value that
 *  contains that separator collide with a different split of the same
 *  characters (HOME "a b" + XDG "c" against HOME "a" + XDG "b c"), and Windows
 *  paths routinely contain spaces. JSON also keeps an unset variable distinct
 *  from one explicitly set to empty. */
function cacheKey(cli: string, env: Env, cwd: string | undefined): string {
  return JSON.stringify([
    cli,
    // in fullAuto the project's own config still loads, so the directory the
    // probe runs in changes the list — same reasoning as the config keys below
    cwd,
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    // the Windows equivalents of the three above
    env.USERPROFILE,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.OPENCODE_CONFIG,
    env.OPENCODE_CONFIG_DIR,
    // can declare a whole provider, so it changes the list and not just where
    // the list is read from — and transformEnv writes it per instance
    env.OPENCODE_CONFIG_CONTENT,
  ]);
}

export async function discoverCatalog(cli: string, env: Env, cwd?: string): Promise<ModelCatalog> {
  const key = cacheKey(cli, env, cwd);
  const hit = cache.get(key);
  if (hit && now() - hit.at < CATALOG_TTL_MS) return hit.value;

  const running = inFlight.get(key);
  if (running) return running;

  const probe = (async (): Promise<ModelCatalog> => {
    const [listing, configured] = await Promise.all([
      run(cli, ["models"], env, cwd),
      defaultModel(cli, env, cwd),
    ]);
    // A CLI that could not run at all is not a CLI reporting no models. Caching
    // that would keep the engine dark for the whole TTL after the problem
    // cleared, and re-opening the picker would not help. Serve the last good
    // catalog if we have one, store nothing, and let the next call retry.
    if (listing === null) return hit?.value ?? { default: "", options: [] };

    const options = parseModels(listing);
    const chosen = configured && options.some((o) => o.id === configured) ? configured : (options[0]?.id ?? "");
    const value: ModelCatalog = { default: chosen, options };
    cache.set(key, { at: now(), value });
    return value;
  })();

  // Registered before the first await above can yield, so a caller arriving in
  // the same tick finds it. Cleared either way: a failed probe must not pin
  // every later caller to the same rejection.
  inFlight.set(key, probe);
  try {
    return await probe;
  } finally {
    inFlight.delete(key);
  }
}

/** Parse `opencode models`: one provider-qualified id per line, no decoration.
 *  Measured on 1.18.18: 471 lines, all matching, no ANSI. Anything that does
 *  not match is dropped rather than guessed at — if the format ever grows a
 *  header, the catalog goes empty and the engine reports itself unavailable,
 *  which is noisy but never a lie. */
export function parseModels(stdout: string): Array<{ id: string; label: string }> {
  const models: Array<{ id: string; label: string }> = [];
  // Split on \r?\n rather than \n: a CRLF stream would otherwise leave a \r
  // glued to every line, which `\S+$` cannot consume, and the whole catalog
  // would parse to nothing — silently, on the one platform we cannot exercise
  // from here.
  for (const line of stdout.split(/\r?\n/)) {
    if (!/^[\w.-]+\/\S+$/.test(line)) continue;
    models.push({ id: line, label: line.slice(line.indexOf("/") + 1) });
  }
  return models;
}

function opencodeConfigDir(env: Env): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

/** Upsert an OpenAI-compatible local provider and return OpenCode's native
 * provider/model id. Existing provider settings and models are preserved. */
export function ensureOpenCodeInjectModel(modelId: string, env: Env = process.env): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const native = `${inject.host}/${inject.model}`;
  const dir = opencodeConfigDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.json");
  let config: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      // Malformed user config: inject into a fresh object rather than fail the turn.
    }
  }
  const providers =
    config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)
      ? { ...(config.provider as Record<string, unknown>) }
      : {};
  const previous = providers[inject.host];
  const existing =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? { ...(previous as Record<string, unknown>) }
      : { npm: "@ai-sdk/openai-compatible", name: host.label, options: {}, models: {} };
  const options =
    existing.options && typeof existing.options === "object" && !Array.isArray(existing.options)
      ? { ...(existing.options as Record<string, unknown>) }
      : {};
  options.baseURL = host.baseUrl;
  if (!options.apiKey) options.apiKey = hostApiKey(host, env);
  const models =
    existing.models && typeof existing.models === "object" && !Array.isArray(existing.models)
      ? { ...(existing.models as Record<string, unknown>) }
      : {};
  if (!models[inject.model]) models[inject.model] = { name: `${inject.model} (${host.label})` };
  providers[inject.host] = {
    ...existing,
    npm: existing.npm || "@ai-sdk/openai-compatible",
    name: existing.name || host.label,
    options,
    models,
  };
  config.provider = providers;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return native;
}

// Mirrors the claude driver's default --permission-mode acceptEdits: reads and
// edits go through, anything that leaves the sandbox asks. `*: ask` is the
// conservative half — it also catches tools claude has no equivalent for.
//
// Two details are not decoration. The `read` sub-map exists to carry opencode's
// own `.env` guard THROUGH our policy rather than to invent it: measured on
// 1.18.18, the stock CLI already resolves `read *` allow / `*.env` ask /
// `*.env.*` ask / `*.env.example` allow with nothing injected at all. But our
// `"*": "ask"` is appended after those built-ins, and a bare `read: "allow"`
// after that would be the last match for every read — so omitting the sub-map
// makes every read a card, and flattening it to `"allow"` reads secrets with no
// card where the stock CLI would have asked. This is defence-in-depth over
// opencode's defaults, not the only thing standing between a bot and a `.env`.
// And the bookkeeping tools are allowed on purpose: with a bare `*: ask` the
// user gets an approval card for every directory listing and every to-do
// update, which trains them to click through cards — the opposite of what this
// policy is for.
const ASK_POLICY = {
  "*": "ask",
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
  glob: "allow",
  grep: "allow",
  lsp: "allow",
  list: "allow",
  todowrite: "allow",
  question: "allow",
  edit: "allow",
  bash: "ask",
  webfetch: "ask",
  websearch: "ask",
  external_directory: "ask",
} satisfies Record<string, "allow" | "ask" | "deny" | Record<string, "allow" | "ask" | "deny">>;

// The agents a stock 1.18.18 session runs: `build` is opencode's default
// and `plan` the one its plan mode selects — those two are the whole
// selectable list, measured. `general` and `explore` are subagents the
// `task` tool spawns; `general` is pinned here, `explore` is left to the
// top-level key.
// Each gets the same policy pinned on it — see permissionEnv for why
// naming them is what makes the top-level policy stick.
//
// `plan` is NOT a read-only sibling, and an earlier version of this comment
// called it one. The top-level `permission` key is merged into every stock agent
// LAST, after that agent's own defaults, so our `edit: "allow"` overrides plan's
// stock `edit: "*" deny` however we pin per agent — measured, plan's edit rules
// with our policy injected: [deny *, allow .opencode/plans/*.md, allow <plans
// dir>, allow *]. Same for general's stock `question`/`todowrite` denies.
// OpenMausBot never selects an agent itself — it pins `default_agent:
// "build"` and never sends a mode change — so plan's rules only decide
// anything if a global config evicts `build` (see permissionEnv). Nothing
// rides on plan being read-only — but a reader would have acted on the claim.
const PINNED_AGENTS = ["build", "plan", "general"] as const;

// The legacy `mode` key path, pinned for `build` and for nothing else. 1.18.18
// still folds `mode.<name>` into `agent.<name>` AFTER every config file has
// merged, with the `mode` entry winning the merge, so a global
// `mode.build.permission` outranked the `agent.build.permission` pin above until
// this key was named too.
//
// `build` only, and this is load-bearing: the fold hardcodes `mode: "primary"`
// onto whatever it copies. Naming `mode.general` would turn the `task` tool's
// subagent into a selectable primary agent — measured, it added `general` to a
// session's mode choices with no config on the machine at all. Widening this
// list would invent an agent the user does not have.
const PINNED_MODE_AGENT = "build";

/** A plain JSON object, or an empty one. Spreading a string or an array would
 *  smear indices into the config we are about to hand opencode. */
function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Compose the child's OPENCODE_CONFIG_CONTENT.
 *
 *  OPENCODE_CONFIG_CONTENT rather than the undocumented OPENCODE_PERMISSION:
 *  it is documented, and it merges after every config file, so it wins every
 *  key it names. We name only the keys we have to, so the user's MCP servers,
 *  skills, extra agents and per-agent models all survive.
 *
 *  What the pinning below is and is not. It stops a global config that was
 *  already hostile or misconfigured BEFORE the bot ran from outranking the
 *  policy through these key paths. It is NOT a boundary against the agent —
 *  transformEnv says why, and no comment here should claim otherwise.
 *
 *  Four key paths, each measured open against 1.18.18 with
 *  OPENCODE_DISABLE_PROJECT_CONFIG=1 already set, from the user's GLOBAL
 *  ~/.config/opencode/opencode.json, which that flag does not touch because it
 *  drops PROJECT config only:
 *
 *  - `permission` — the top-level policy. A config file's own top-level
 *    `permission` collides with ours on the same key path and loses the merge.
 *    This key alone used to be the whole fix, and it was not enough.
 *
 *  - `agent.<name>.permission` — a DIFFERENT key path, which is the entire
 *    reason it was not enough. A per-agent block does not collide; it is
 *    flattened into the resolved rule array AFTER the top-level policy, and
 *    evaluation is last-match-wins, so `{"agent":{"build":{"permission":
 *    {"bash":"allow"}}}}` restored uncarded shell. Naming the same key path
 *    takes it back — measured: the hostile block is replaced rather than
 *    appended, while sibling fields on that same agent (its `model`, say) still
 *    merge through untouched.
 *
 *  - `mode.<name>.permission` — the legacy spelling of the one above, and it
 *    outranks it, because `mode` is folded into `agent` after every config file
 *    has merged. `{"mode":{"build":{"permission":{"bash":"allow"}}}}` beat the
 *    `agent` pin on its own until this key was named. `build` only — see
 *    PINNED_MODE_AGENT.
 *
 *  - `default_agent` — otherwise a config can define a brand-new agent we do
 *    not name and point the session at it: `{"default_agent":"evil","agent":
 *    {"evil":{"permission":{"bash":"allow"}}}}` resolved to `evil`. Pinning
 *    collides on that key path too, so `build` wins.
 *
 *  Measured and NOT covered, deliberately: a config that EVICTS `build` instead
 *  of editing it. `agent.build.disable`, `agent.build.hidden`, or disabling all
 *  three pinned agents and declaring a new primary, all land the session
 *  somewhere else — measured: on `plan` (whose `agent.plan.permission` we do
 *  pin, but whose `mode.plan.permission` we do not) or on a brand-new primary
 *  we pin nothing on — the resolver deletes a disabled agent before
 *  `default_agent` is read, then falls back to the first visible primary.
 *  Pinning `disable: false`/`hidden: false` closes exactly those and was
 *  rejected: it re-enables `build` for a user who deliberately turned it off,
 *  and it does not close the class, because opencode accepts unknown top-level
 *  keys silently so the aliases cannot be enumerated. Do not add it without
 *  reading transformEnv first — the cheaper attack is not through these keys.
 *
 *  fullAuto is the user asking for no gate at all, so it hands over the
 *  top-level key and pins nothing. */
export function permissionEnv(existing: string | undefined, fullAuto: boolean): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed;
      else console.error("opencode: ignoring a non-object OPENCODE_CONFIG_CONTENT");
    } catch {
      // Not our JSON to repair. Say so: silently dropping it would make the
      // user's MCP servers vanish with nothing to grep for.
      console.error("opencode: ignoring an unparseable OPENCODE_CONFIG_CONTENT");
    }
  }
  if (fullAuto) return JSON.stringify({ ...base, permission: "allow" });

  const callerAgents = plainObject(base.agent);
  const agent: Record<string, unknown> = { ...callerAgents };
  for (const name of PINNED_AGENTS) {
    agent[name] = { ...plainObject(callerAgents[name]), permission: ASK_POLICY };
  }
  // `mode` gets the same treatment rather than riding through the `...base`
  // spread untouched: it is the key path that outranks `agent`, so leaving a
  // caller's copy of it in place would hand back what the agent pin just took.
  const callerModes = plainObject(base.mode);
  const mode: Record<string, unknown> = { ...callerModes };
  mode[PINNED_MODE_AGENT] = { ...plainObject(callerModes[PINNED_MODE_AGENT]), permission: ASK_POLICY };
  return JSON.stringify({ ...base, agent, mode, permission: ASK_POLICY, default_agent: "build" });
}

const support: AcpSupport = {
  driverKind: "opencodeAgent",
  displayName: "OpenCode",
  defaultCli: "opencode",
  nativeSource: "opencode.acp",
  // The real catalog is per-machine and comes from catalog(); this is only the
  // honest fallback if discovery fails. An empty list makes the engine report
  // itself unusable, which beats advertising models the user cannot run.
  models: { default: "", options: [] },
  // The list is per-machine, so it is read from the CLI on demand rather than
  // compiled in; discoverCatalog bounds its own latency, as the contract asks.
  // It runs where a turn would run, not where the server was launched — see
  // probeCwd.
  catalog: async (config, env) =>
    mergeLocalInject(await discoverCatalog(config.cli, env, probeCwd(config)), env),
  // `opencode acp` accepts no -m, so the model has to be set through the
  // session's config option before the prompt goes out.
  selectModel: { configId: "model" },
  resolveTurnModel: (model, env) => (model ? ensureOpenCodeInjectModel(model, env) : model),

  spawnArgs: () => ["acp"],

  // OPENCODE_API_KEY unlocks the OpenCode Zen provider: on a virgin HOME the
  // catalog goes from 8 free models to 81 once it is set (measured, 1.18.18).
  // core.ts strips every PROVIDER_CREDENTIAL_ENV name a support does not claim,
  // so this line is what keeps it. Nothing else belongs here — the user's own
  // providers authenticate through opencode's auth.json, not through us, and a
  // foreign key in this child would only be a leak.
  credentialEnv: ["OPENCODE_API_KEY"],

  transformEnv: (env, config) => {
    env.OPENCODE_CONFIG_CONTENT = permissionEnv(env.OPENCODE_CONFIG_CONTENT, config.fullAuto);
    if (config.fullAuto) return;
    // permissionEnv owns the four config key paths below. These
    // three env vars sidestep the config merge instead, and all three are
    // inherited from our own process, so strip them from the child the way kimi
    // strips a stray API key:
    //
    //   - OPENCODE_PERMISSION is applied after every config merge, so an
    //     inherited one lands after the policy we just injected and, under
    //     last-match-wins, beats it.
    //   - OPENCODE_CONFIG / OPENCODE_CONFIG_DIR point opencode at a config file
    //     or directory we do not control; a hostile one there also resolved to
    //     `bash: allow`. cacheKey already names both as things that change what
    //     opencode resolves — same reasoning, other half of the driver.
    //
    // OPENCODE_DISABLE_PROJECT_CONFIG closes the workspace route, and that one
    // is a real boundary: a repository OpenMausBot clones cannot lower the
    // policy, because its opencode.json and .opencode/agent/*.md are not read at
    // all. The cost is real and deliberate — that repository's own opencode
    // config is ignored while a bot works in it, MCP servers it defines
    // included — and we take it because `edit` is allowed here and a fresh child
    // spawns per turn, so an agent that could write .opencode/agent/build.md
    // would hold uncarded shell on its very next turn.
    //
    // The user's GLOBAL config still loads, and we neither disable it nor could:
    // it is where their providers and MCP servers live. permissionEnv pins four
    // of its key paths, which stops a config that was ALREADY hostile or
    // misconfigured from outranking the policy through them.
    //
    // That is not a boundary against the agent, and nothing here should be
    // written as if it were. core.ts runs a turn in
    // `turn.cwd ?? config.workspace ?? homedir()` and this policy allows `edit`,
    // so an agent working in the default cwd can write
    // ~/.config/opencode/opencode.json itself — either a `permission` block on
    // some key path we have not pinned, or an `mcp` block, which 1.18.18 runs as
    // an arbitrary command at the next session/new with no card at all. Pinning
    // more key paths does not reach this: `mcp` cannot be pinned away without
    // deleting the user's own MCP servers, and unknown top-level keys are
    // accepted silently, so the list cannot be closed by enumeration. The claude
    // driver carries the identical exposure (claude.ts:339
    // `cwd: turn.cwd ?? homedir()`, claude.ts:254 `--permission-mode
    // acceptEdits`), so this is a property of the application's
    // working-directory default rather than of this engine, and the fix is to
    // give a turn a real workspace — not to add another key here.
    delete env.OPENCODE_PERMISSION;
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_CONFIG_DIR;
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  },

  // The only advertised method is {id:"opencode-login"}, whose own description
  // says to run a terminal command — it cannot be driven over ACP. Ride the
  // ambient login instead, exactly like kimi.
  pickAuthMethod: () => null,
  authFailure: "continue",

  // OpenCode runs with no login at all: a virgin HOME still lists the free
  // OpenCode Zen models, and they answer. So readiness is "is there anything
  // left to run", not "is there a credential file".
  isAuthenticated: async (env, config) =>
    ((await mergeLocalInject(
      await discoverCatalog(config.cli, env, probeCwd(config)),
      env,
    ).catch(() => null))?.options.length ?? 0) > 0,

  loginNote: "OpenCode has no usable model — run `opencode auth login` to connect a provider",

  install: {
    // The vendor's primary installer, and it needs no Node. There is no
    // PowerShell one-liner (opencode.ai/install.ps1 is a 404), so Windows gets
    // npm, the only documented route that does not need another package
    // manager first. needsNode is deliberately unset: it is a whole-descriptor
    // flag and would show a false "Needs Node.js" under the curl commands.
    command: {
      darwin: "curl -fsSL https://opencode.ai/install | bash",
      linux: "curl -fsSL https://opencode.ai/install | bash",
      win32: "npm install -g opencode-ai",
    },
    docsUrl: "https://opencode.ai/docs/",
    signInCommand: "opencode auth login",
  },

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const OpenCodeAgentDriver = createAcpDriver(support);
