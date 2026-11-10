// OpenCode's model discovery probe: an `opencode acp` in its own folder, opened just long enough to list the models.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../../atomic.ts";
import { DATA_DIR } from "../../config.ts";
import { titleCaseModelId, type ModelCatalog, type ModelVariantOption } from "../../contracts.ts";
import { killCliTree, spawnCli } from "../../procs.ts";
import { offeredModels, surveyModelVariants } from "./config-options.ts";
import { deleteAcpSessions, deletesAcpSessions } from "./session-delete.ts";

export const DISCOVERY_TIMEOUT_MS = 20_000;
const EFFORT_SURVEY_MS = 8_000;

export function labelForModel(id: string): string {
  return titleCaseModelId(id, /[-_.]+/);
}

export function providerLabel(id: string): string {
  if (id === "opencode") return "Zen";
  if (id === "opencode-go") return "Go";
  if (id === "openrouter") return "OpenRouter";
  return labelForModel(id);
}

export function validModelSlug(value: string): boolean {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator >= value.length - 1 || /\s/u.test(value)) return false;
  return [...value].every((character) => (character.codePointAt(0) ?? 0) > 0x1f);
}

/** The `model` select in session/new's configOptions: exactly what set_config_option accepts, and the only reliable list on V2. */
export function catalogFromOpenCodeSession(result: unknown): { options: ModelCatalog["options"]; current: string | null } | null {
  const configOptions = (result as { configOptions?: unknown } | null)?.configOptions;
  const model = Array.isArray(configOptions)
    ? configOptions.find((option: any) => option?.id === "model" && option?.type === "select")
    : null;
  const ids = offeredModels(result, "model");
  if (!model || !ids.length) return null;
  const names = new Map<string, string>();
  const visit = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry?.value === "string" && typeof entry.name === "string") names.set(entry.value, entry.name);
      else if (Array.isArray(entry?.options)) visit(entry.options);
    }
  };
  visit(model.options);
  const options = [...new Set(ids)].filter(validModelSlug).map((id) => {
    const separator = id.indexOf("/");
    // V1 names "OpenCode Zen/Big Pickle", V2 "opencode/Big Pickle": the provider comes from the id.
    const raw = names.get(id)?.trim() ?? "";
    const name = (raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw).trim() || labelForModel(id.slice(separator + 1));
    return { id, label: `${providerLabel(id.slice(0, separator))} · ${name}` };
  });
  return options.length
    ? { options, current: typeof (model as any).currentValue === "string" ? (model as any).currentValue : null }
    : null;
}

/** Security: the folder is the boxed probe's to write, and HOME may be a boxed bot's, so git reads no config but the
 * fresh repository's own, and none that runs a program. */
function runGit(directory: string, args: string[]): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return new Promise((resolveRun, rejectRun) => {
    execFile("git", [
      "-c", "user.name=OpenMaus", "-c", "user.email=model-discovery@openmaus.invalid",
      "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(directory, ".git", "no-hooks")}`, "-c", "core.fsmonitor=false",
      ...args,
    ], { cwd: directory, env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, timeout: 10_000, windowsHide: true }, (error) => {
      if (error) rejectRun(error);
      else resolveRun();
    });
  });
}

let discoveryFolder: Promise<string> | null = null;

export function forgetDiscoveryDirectory(): void {
  discoveryFolder = null;
}

/** OpenCode files every session under its working folder's project, and folders outside git share one
 * global project, so `opencode run --continue` there would resume the probe's empty session. */
export function discoveryDirectory(): Promise<string> {
  discoveryFolder ??= (async () => {
    const directory = join(DATA_DIR, "providers", "opencode", "discovery");
    mkdirSync(directory, { recursive: true });
    const marker = join(directory, ".openmaus-project");
    if (!existsSync(marker)) {
      try {
        rmSync(directory, { recursive: true, force: true });
        mkdirSync(directory, { recursive: true });
        await runGit(directory, ["init", "-q"]);
        await runGit(directory, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "OpenMaus model discovery"]);
        writeFileSync(marker, "OpenCode files this folder's sessions under its own project.\n");
      } catch {}
    }
    return directory;
  })();
  return discoveryFolder;
}

export interface OpenCodeSessionProbe {
  session: unknown;
  /** Each surveyed model's ACP effort choices; an empty list means it has none. */
  efforts: Map<string, ModelVariantOption[]>;
}

/** OpenCode (1.18.27, 1.19.4, 2.1.4) names a model's efforts only in the session's `effort` option once that
 * model is selected, and OpenCode 2.1.4 answers overlapping selections with another model's options. */
export function surveyOpenCodeEfforts(
  request: (method: string, params: unknown) => Promise<unknown>,
  session: unknown,
  budgetMs = EFFORT_SURVEY_MS,
): Promise<Map<string, ModelVariantOption[]>> {
  return surveyModelVariants(request, session, budgetMs);
}

/** Session id -> when a probe opened it. Only ids in here are ever deleted, so another client's sessions in the
 * discovery folder survive; a probe cut off by its timeout leaves its ids for the next probe to delete. */
type ProbeSessionLedger = Record<string, number>;

const probeLedgerPath = (cwd: string) => join(cwd, ".openmaus-probe-sessions.json");

function readProbeLedger(cwd: string): ProbeSessionLedger {
  try {
    const ledger: unknown = JSON.parse(readFileSync(probeLedgerPath(cwd), "utf8"));
    return ledger && typeof ledger === "object" && !Array.isArray(ledger) ? ledger as ProbeSessionLedger : {};
  } catch {
    return {};
  }
}

function changeProbeLedger(cwd: string, change: (ledger: ProbeSessionLedger) => void): void {
  const ledger = readProbeLedger(cwd);
  change(ledger);
  try {
    writeFileAtomic(probeLedgerPath(cwd), JSON.stringify(ledger), { durable: false });
  } catch {}
}

/** OpenCode (2.2.0, 2.2.6) keeps every ACP session, even one closed with session/close or whose process was killed,
 * and lists it in the user's history; only session/delete removes it, and it answers {} for an id it does not know. */
async function deleteProbeSessions(
  request: (method: string, params: unknown) => Promise<unknown>,
  cwd: string,
  opened: string[],
  timeoutMs: number,
): Promise<void> {
  const abandonedBefore = Date.now() - 2 * timeoutMs;
  const abandoned = Object.entries(readProbeLedger(cwd))
    .filter(([, openedAt]) => openedAt < abandonedBefore)
    .map(([sessionId]) => sessionId);
  const deleted = await deleteAcpSessions(request, [...opened, ...abandoned]);
  if (deleted.length) changeProbeLedger(cwd, (ledger) => { for (const sessionId of deleted) delete ledger[sessionId]; });
}

/** `settleMs` keeps the process open that long after it starts, then lists again: OpenCode 2's own catalog refresh
 * reaches a running process's later sessions only. */
/** Security: OpenCode starts the plugins and MCP servers its config names (~/.config/opencode), so while the bot box is
 * on the probe runs in the box, as a bot's turn does. `allowEnv`: the keys the instance's own settings put in `environment`. */
export async function probeOpenCodeSession(
  cli: string,
  environment: Record<string, string | undefined>,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  settleMs = 0,
  allowEnv: readonly string[] = [],
): Promise<OpenCodeSessionProbe> {
  const cwd = await discoveryDirectory();
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(cli, ["acp"], { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"], box: { allowEnv } });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let listed: OpenCodeSessionProbe | undefined;
    let buffer = "";
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const write = (message: unknown) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {}
    };
    const finish = (error: Error | null, value?: OpenCodeSessionProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {}
      void killCliTree(child);
      for (const waiter of pending.values()) waiter.reject(new Error("OpenCode closed"));
      pending.clear();
      const result = value ?? listed;
      if (result) resolve(result);
      else reject(error ?? new Error("OpenCode did not list its models"));
    };
    const timer = setTimeout(
      () => finish(Object.assign(new Error("OpenCode did not list its models in time"), { timedOut: true })),
      timeoutMs,
    );
    timer.unref?.();
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(new Error(`OpenCode exited ${code} while listing its models`)));
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id !== undefined && typeof message.method === "string") {
          write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
          continue;
        }
        const waiter = typeof message?.id === "number" ? pending.get(message.id) : undefined;
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) {
          waiter.reject(Object.assign(new Error(String(message.error.message ?? "ACP request failed")), {
            code: message.error.code,
            data: message.error.data,
          }));
        } else waiter.resolve(message.result);
      }
    });
    const request = (method: string, params: unknown) => new Promise<unknown>((resolveRequest, rejectRequest) => {
      if (settled) {
        rejectRequest(new Error("OpenCode closed"));
        return;
      }
      const id = ++nextId;
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      write({ jsonrpc: "2.0", id, method, params });
    });
    let deletesSessions = false;
    const opened: string[] = [];
    const openSession = async () => {
      const session = await request("session/new", { cwd, mcpServers: [] });
      const sessionId = (session as { sessionId?: unknown } | null)?.sessionId;
      if (deletesSessions && typeof sessionId === "string") {
        opened.push(sessionId);
        changeProbeLedger(cwd, (ledger) => { ledger[sessionId] = Date.now(); });
      }
      return session;
    };
    const cleanUp = () => deletesSessions ? deleteProbeSessions(request, cwd, opened, timeoutMs) : Promise.resolve();
    void (async () => {
      const initialized = await request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "openmausbot", version: "0.0.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      deletesSessions = deletesAcpSessions(initialized);
      const session = await openSession();
      listed = { session, efforts: new Map() };
      const budget = Math.min(EFFORT_SURVEY_MS, deadline - Date.now() - 1_000);
      const efforts = await surveyOpenCodeEfforts(request, session, budget);
      if (!settleMs) return { session, efforts };
      const wait = Math.min(settleMs, timeoutMs - 2_000) - (Date.now() - (deadline - timeoutMs));
      if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
      const later = await openSession();
      return { session: catalogFromOpenCodeSession(later) ? later : session, efforts };
    })().then(
      (result) => {
        listed = result;
        return cleanUp().then(() => finish(null, result));
      },
      (error: Error) => cleanUp().then(() => finish(error)),
    );
  });
}
