import { resolve } from "node:path";

import { listConfigBackups, restoreConfigBackup } from "./config-backup.ts";
import { defaultDataDir, type DataHomes } from "./data-dir.ts";
import { parseStoredConfig } from "./config.ts";
import { parseJson } from "./schema.ts";

export const CONFIG_USAGE = `openmausbot config backups [--data-dir DIR] [--json]
openmausbot config restore NAME [--data-dir DIR] [--dry-run] [--json]

Shows and puts back the dated copies of the settings file. Every save keeps a
copy of the file as it was, named config.json.bak.YYYYMMDD-HHMMSS, beside it,
and the last ten are kept. A save never replaces a file it could not read: it
fails and says so, so a settings file that cannot be read is never overwritten.

backups   list the dated copies, oldest first
restore   put a copy back, by name or "latest"; the file it replaces is kept,
          so the restore can be undone. Stop the server first if it is
          running, so nothing it holds in memory is written over the copy.

--data-dir DIR  the OpenMausBot data folder (default ~/.openmausbot)
--dry-run        say what a restore would do, and change nothing
--json           print the result as JSON`;

export interface ConfigCliArgs {
  command: "backups" | "restore" | "help";
  dataDir: string;
  name: string | undefined;
  json: boolean;
  help: boolean;
  dryRun: boolean;
}

export interface ConfigCliError {
  error: string;
  json: boolean;
}

/** A copy is only put back when it is a settings file the server can read: a file the loader would reject would
 * change the settings without saying so. */
function settingsProblem(text: string): string | null {
  try {
    parseStoredConfig(parseJson(text));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "it does not match the settings format";
  }
}

export function parseConfigArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, homes: DataHomes = {}): ConfigCliArgs | ConfigCliError {
  const json = argv.includes("--json");
  const help = argv.includes("--help") || argv.includes("-h");
  const dryRun = argv.includes("--dry-run");
  const fail = (error: string): ConfigCliError => ({ error, json });
  let dataDir = argv.includes("--data-dir") ? "" : defaultDataDir(env, homes.under, homes.realHome);
  let name: string | undefined;
  const words = argv.filter((arg) => arg !== "--json" && arg !== "--help" && arg !== "-h" && arg !== "--dry-run");
  const command = words[0];
  if (command !== "backups" && command !== "restore") {
    // A request for the help is answered with the help, whatever else it says.
    if (help) return { command: "help", dataDir, name: undefined, json, help, dryRun };
    return fail(command ? `unknown command "${command}"; say "backups" or "restore"` : "say what to do: \"backups\" or \"restore\"");
  }
  for (let index = 1; index < words.length; index += 1) {
    const arg = words[index]!;
    if (arg === "--data-dir") {
      const value = words[index + 1];
      if (value === undefined || value.startsWith("--")) return fail("--data-dir needs the folder that holds config.json");
      dataDir = resolve(value);
      index += 1;
    } else if (command === "restore" && name === undefined && !arg.startsWith("-")) name = arg;
    else return fail(`unknown argument "${arg}"; see openmausbot config --help`);
  }
  // The help comes before the name is asked for: "config restore --help" is a question, not a request.
  if (command === "restore" && name === undefined && !help) return fail("restore needs the name of a copy, or \"latest\"; run openmausbot config backups to see them");
  return { command, dataDir, name, json, help, dryRun };
}

export function runConfigCli(
  argv: string[],
  io: { log(line: string): void; error(line: string): void } = console,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const args = parseConfigArgs(argv, env);
  if ("error" in args) {
    if (args.json) io.log(JSON.stringify({ ok: false, error: args.error }));
    else io.error(`config: ${args.error}`);
    return 2;
  }
  if (args.help) {
    io.log(CONFIG_USAGE);
    return 0;
  }
  const copies = listConfigBackups(args.dataDir);
  if (args.command === "backups") {
    if (args.json) io.log(JSON.stringify({ ok: true, dataDir: args.dataDir, backups: copies.map((copy) => ({ name: copy.name, stamp: copy.stamp, bytes: copy.bytes })) }));
    else if (!copies.length) io.log(`config: no dated copies of the settings file in ${args.dataDir}`);
    else for (const copy of copies) io.log(`${copy.stamp}  ${copy.name}  ${copy.bytes} bytes`);
    return 0;
  }
  const name = args.name === "latest" ? copies[copies.length - 1]?.name : args.name;
  if (!name) {
    if (args.json) io.log(JSON.stringify({ ok: false, error: `there is no dated copy to put back in ${args.dataDir}` }));
    else io.error(`config: there is no dated copy to put back in ${args.dataDir}; a copy is taken at every save`);
    return 1;
  }
  const restored = restoreConfigBackup(args.dataDir, name, { dryRun: args.dryRun, check: settingsProblem });
  if (!restored.ok) {
    if (args.json) io.log(JSON.stringify({ ok: false, error: restored.error }));
    else io.error(`config: ${restored.error}`);
    return 1;
  }
  if (args.json) io.log(JSON.stringify({ ok: true, restored: restored.name, kept: restored.kept, restoredNow: restored.restored }));
  else if (!restored.restored) io.log(`config: ${restored.name} would be put back as config.json; nothing was changed`);
  else io.log(`config: put ${restored.name} back as config.json${restored.kept ? `; the file it replaced was kept at ${restored.kept}` : ""}`);
  return 0;
}
