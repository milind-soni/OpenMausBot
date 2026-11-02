// Claude Code keeps what an organization allows in its account config: `modelAccessCache`, `[{ apiName, entitled }]`, as
// it stood at the CLI's last start (2.1.312). The CLI answers a turn on a denied model with the organization's default.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ModelCatalog } from "../contracts.ts";
import { userHome } from "../env-path.ts";
import { conversationLanguage, serverLine } from "../server-lines.ts";
import { topLevelJsonMember } from "../setup-import.ts";

/** The account config of a very long project history: too large to scan on the server's thread for this list. */
const ACCOUNT_FILE_MAX_BYTES = 32 * 1024 * 1024;

/** 2.1.312 builds its deny list only on its first-party and gateway backends: on these the cloud account decides, and a
 * list left by an earlier claude.ai login means nothing. */
const CLOUD_BACKEND_ENV = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
];

/** How 2.1.312 matches names: API ids may carry a release date (`claude-haiku-4-5-20251001`) and a `[1m]` suffix that
 * catalog ids leave out. */
export function claudeModelKey(id: string): string {
  return id.trim().toLowerCase().replace(/(?:\[1m\])+$/, "").replace(/-\d{8}$/, "");
}

/** Fails open: a missing or malformed file hides nothing, and only an explicit `entitled: false` counts. */
export function parseOrgBlockedModels(text: string): Set<string> {
  const blocked = new Set<string>();
  const cache = topLevelJsonMember(text, "modelAccessCache");
  if (!Array.isArray(cache)) return blocked;
  for (const entry of cache as Array<{ apiName?: unknown; entitled?: unknown } | null>) {
    if (typeof entry?.apiName === "string" && entry.entitled === false) blocked.add(claudeModelKey(entry.apiName));
  }
  return blocked;
}

/** Where 2.1.312 keeps its account config: `.config.json` in its config folder when that has content (older installs), else
 * `.claude.json` in `CLAUDE_CONFIG_DIR` or the home folder. Its home folder is `os.homedir()`: on Windows that is USERPROFILE,
 * never a HOME a POSIX-flavoured shell left behind. */
export function claudeAccountFiles(env: Record<string, string | undefined>): string[] {
  const home = userHome(env);
  const folder = env.CLAUDE_CONFIG_DIR?.trim();
  return [join(folder || join(home, ".claude"), ".config.json"), join(folder || home, ".claude.json")];
}

/** The catalog as this account may use it. A blocked default gives way to the first model the organization allows, so a
 * new bot never starts on one. */
export function withOrgBlocks(catalog: ModelCatalog, blocked: ReadonlySet<string>): ModelCatalog {
  const options: ModelCatalog["options"] = catalog.options.map(({ orgBlocked: _stale, ...option }) =>
    !option.custom && blocked.has(claudeModelKey(option.id)) ? { ...option, orgBlocked: true as const } : option);
  const usable = (id: string) => options.some((option) => option.id === id && !option.orgBlocked);
  const fallback = options.find((option) => !option.orgBlocked && !option.custom)?.id;
  return { ...catalog, default: usable(catalog.default) ? catalog.default : fallback ?? catalog.default, options };
}

type AccountEnv = Record<string, string | undefined>;

/** Keeps the catalog in step with the account config. `environments` names every place the CLI may have written it: on a
 * Team Cloud each audience's engine home holds its own copy of the same organization's answer, and the newest speaks. */
export function createOrgModelBlocks(
  environments: () => AccountEnv[],
  apply: (blocked: ReadonlySet<string>) => void,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
) {
  let lastRead = "";
  return {
    async refresh(force = false): Promise<void> {
      let newest: { path: string; mtimeMs: number; size: number } | null = null;
      for (const env of environments()) {
        if (CLOUD_BACKEND_ENV.some((key) => env[key])) return apply(new Set());
        for (const path of claudeAccountFiles(env)) {
          const found = await stat(path).catch(() => null);
          if (!found?.isFile() || found.size === 0) continue;
          if (!newest || found.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: found.mtimeMs, size: found.size };
          break;
        }
      }
      const version = newest ? `${newest.path}:${newest.mtimeMs}` : "none";
      if (!force && version === lastRead) return;
      if (!newest || newest.size > ACCOUNT_FILE_MAX_BYTES) {
        lastRead = version;
        return apply(new Set());
      }
      // Windows refuses a read while the CLI is renaming this file into place: what was known stands until a read succeeds.
      const text = await read(newest.path).catch(() => null);
      if (text === null) return;
      lastRead = version;
      apply(parseOrgBlockedModels(text));
    },
  };
}

const OFFICIAL_MODEL = /^claude-[a-z0-9.-]+$/;

/** Both ids name Anthropic's own models and they differ. An alias, a local model, a cloud provider's id or the CLI's
 * `<synthetic>` frames promise nothing to compare. */
export function otherModelAnswered(picked: string | null | undefined, answered: unknown): answered is string {
  if (!picked || typeof answered !== "string") return false;
  const [asked, got] = [claudeModelKey(picked), claudeModelKey(answered)];
  return OFFICIAL_MODEL.test(asked) && OFFICIAL_MODEL.test(got) && asked !== got;
}

const told = new WeakMap<object, Set<string>>();

/** The line telling the person a turn came back from another model: once per engine session for each pair, since the
 * model menu shows the same thing until they choose. A subagent's frame says nothing about the turn's own model. Null when
 * there is nothing to tell. */
export function modelSwapNotice(
  session: object,
  threadId: string,
  picked: string | null | undefined,
  frame: { parent_tool_use_id?: unknown; message?: { model?: unknown } },
  catalog: ModelCatalog,
): string | null {
  const answered = frame.message?.model;
  if (frame.parent_tool_use_id || !otherModelAnswered(picked, answered)) return null;
  const said = told.get(session) ?? new Set<string>();
  told.set(session, said);
  const pair = `${claudeModelKey(picked!)} ${claudeModelKey(answered)}`;
  if (said.has(pair)) return null;
  said.add(pair);
  const option = (id: string) => catalog.options.find((candidate) => claudeModelKey(candidate.id) === claudeModelKey(id));
  const names = { picked: option(picked!)?.label ?? picked!, answered: option(answered)?.label ?? answered };
  return serverLine(conversationLanguage(threadId), option(picked!)?.orgBlocked ? "server.model.orgBlockedAnswered" : "server.model.otherAnswered", names);
}
