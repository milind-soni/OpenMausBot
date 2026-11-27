// What a shell command does, read from its text: the run card names the commands that change something, never the reads.

const SEGMENT = /\s*(?:&&|\|\||;|\||\r?\n)\s*/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPER = new Set(["env", "sudo"]);
const WRAPPER_VALUE_FLAG = new Set(["-u", "-g", "-C"]);
const PACKAGE_RUNNER = new Set(["pnpm", "npm", "yarn", "bun"]);
const PACKAGE_RUNNER_WORD = new Set(["run", "exec", "-s", "--silent", "-r", "--"]);
const SCRIPT_RUNNER = new Set(["node", "npx", "tsx"]);
const CLI_SCRIPT = /^control:[\w-]+$/;
const CLI_FILE = /^control-[\w-]+\.(?:mjs|ts|js|cjs)$/;
const REDIRECT = /^\d*[<>]/;
const URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const LONG_FLAG_WITH_VALUE = /^--[^=]+$/;
const DRY_RUN = /(?:^|\s)--dry-run(?:=|\s|$)/;

const unquote = (token: string) => token.replace(/^['"`]+|['"`]+$/g, "");
const basenameOf = (token: string) => {
  const bare = unquote(token);
  return bare.split(/[\\/]/).pop() || bare;
};

function strip(argv: string[], runners: boolean): string[] {
  let i = 0;
  while (i < argv.length) {
    const word = argv[i];
    if (ENV_ASSIGNMENT.test(word)) i += 1;
    else if (word === "timeout" || word === "cd") i += 2;
    else if (WRAPPER.has(word)) {
      i += 1;
      while (i < argv.length && argv[i].startsWith("-")) i += WRAPPER_VALUE_FLAG.has(argv[i]) ? 2 : 1;
    } else if (!runners) break;
    else if (word === "deno") i += argv[i + 1] === "run" ? 2 : 1;
    else if (PACKAGE_RUNNER.has(word)) {
      i += 1;
      while (i < argv.length && PACKAGE_RUNNER_WORD.has(argv[i])) i += 1;
    } else if (SCRIPT_RUNNER.has(word)) {
      i += 1;
      while (i < argv.length && argv[i].startsWith("-")) i += 1;
    } else break;
  }
  return argv.slice(i);
}

function cliTokenOf(word: string): string | undefined {
  const token = unquote(word);
  if (CLI_SCRIPT.test(token)) return token;
  const basename = basenameOf(token);
  return CLI_FILE.test(basename) ? basename : undefined;
}

function subcommandOf(rest: string[], cli: string): string {
  let valueNext = false;
  for (const raw of rest) {
    const token = unquote(raw);
    if (token.startsWith("-")) valueNext = LONG_FLAG_WITH_VALUE.test(token) && token !== "--dry-run";
    else if (valueNext) valueNext = false;
    else if (token && !REDIRECT.test(token) && !URL.test(token)) return token;
  }
  return cli;
}

export function parseControlCommand(command: string): { subcommand: string; dryRun: boolean } | undefined {
  for (const segment of command.split(SEGMENT)) {
    const argv = strip(segment.split(/\s+/).filter(Boolean), true);
    const cli = argv.length > 0 ? cliTokenOf(argv[0]) : undefined;
    if (cli) return { subcommand: subcommandOf(argv.slice(1), cli), dryRun: DRY_RUN.test(segment) };
  }
  return undefined;
}

const READ_PROGRAM = new Set([
  "cat", "less", "more", "head", "tail", "wc", "stat", "file", "du", "df", "ls", "tree", "find",
  "which", "type", "where", "whereis", "pwd", "echo", "printf", "printenv", "env", "ps", "pgrep", "top",
  "grep", "rg", "ag", "ack", "fgrep", "egrep", "awk", "cut", "sort", "uniq", "tr", "diff", "cmp",
  "md5", "shasum", "sha256sum", "jq", "yq", "column",
  "export", "unset", "alias", "true", "false", ":", "sleep", "exit",
]);
const GIT_READ = new Set(["status", "log", "diff", "show", "blame", "ls-files", "rev-parse", "describe", "shortlog"]);
const GIT_VALUE_FLAG = new Set(["-C", "-c"]);
const GIT_REF_VALUE_FLAG = new Set(["--sort", "--format"]);
const GH_READ = new Set(["pr view", "pr list", "pr checks", "pr diff", "issue view", "issue list", "run view", "run list"]);
const GH_VALUE_FLAG = new Set(["-R", "--repo"]);
const NO_VALUE_FLAG = new Set<string>();
const SED_IN_PLACE = /^(?:-[a-zA-Z]*i|--in-place)/;
const HTTP_MUTATION = /^(?:POST|PUT|PATCH|DELETE)$/i;
const METHOD_FLAG = /^(?:-X|--request|--method)(?:=(.*))?$/;
const METHOD_ATTACHED = /^-X(\w+)$/;
const TRANSFER_FLAG = /^(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file|-o|--output|-O|--remote-name|--output-document|--post-data|--post-file)(?:=|$)/;
const GH_FIELD_FLAG = /^(?:-f|-F|--field|--raw-field)(?:=|$)/;

function words(rest: string[], valueFlags: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = unquote(rest[i]);
    if (valueFlags.has(token)) i += 1;
    else if (token.startsWith("-") || REDIRECT.test(token) || URL.test(token) || !token) continue;
    else found.push(token);
  }
  return found;
}

function isGitRead(rest: string[]): boolean {
  let i = 0;
  while (i < rest.length && unquote(rest[i]).startsWith("-")) {
    i += GIT_VALUE_FLAG.has(unquote(rest[i])) ? 2 : 1;
  }
  const subcommand = rest[i] && unquote(rest[i]);
  const args = rest.slice(i + 1).map(unquote);
  const flags: string[] = [];
  for (let j = 0; j < args.length; j += 1) {
    if (GIT_REF_VALUE_FLAG.has(args[j])) j += 1;
    else if (args[j].startsWith("-")) flags.push(args[j]);
  }
  switch (subcommand) {
    case "branch":
      if (flags.some((arg) => /^-[^-]*[dDmMcCfu]/.test(arg) || /^--(?:delete|delete-merged|move|copy|force|set-upstream-to|unset-upstream|edit-description)(?:=|$)/.test(arg))) return false;
      if (flags.some((arg) => /^-[^-]*[lar]/.test(arg) || /^--(?:list|all|remotes|show-current|contains|no-contains|merged|no-merged|points-at|forked)(?:=|$)/.test(arg))) return true;
      return words(args, GIT_REF_VALUE_FLAG).length === 0;
    case "tag":
      if (flags.some((arg) => /^-[^-]*[adfFsmue]/.test(arg) || /^--(?:delete|annotate|sign|force|message|file|local-user|edit|trailer|cleanup)(?:=|$)/.test(arg))) return false;
      if (flags.some((arg) => /^-[^-]*[lnv]/.test(arg) || /^--(?:list|verify|contains|no-contains|merged|no-merged|points-at)(?:=|$)/.test(arg))) return true;
      return words(args, GIT_REF_VALUE_FLAG).length === 0;
    case "remote": {
      const [verb] = words(args, NO_VALUE_FLAG);
      return verb === undefined || verb === "show" || verb === "get-url";
    }
    case "reflog": {
      const [verb] = words(args, NO_VALUE_FLAG);
      return !/^(?:expire|delete|drop|write)$/.test(verb ?? "");
    }
    default:
      return subcommand === undefined || GIT_READ.has(subcommand);
  }
}

function mutatesOverHttp(rest: string[]): boolean {
  for (let i = 0; i < rest.length; i += 1) {
    const token = unquote(rest[i]);
    const attached = METHOD_ATTACHED.exec(token);
    if (attached) {
      if (HTTP_MUTATION.test(attached[1])) return true;
      continue;
    }
    const flag = METHOD_FLAG.exec(token);
    if (!flag) continue;
    const method = flag[1] ?? unquote(rest[i + 1] ?? "");
    if (HTTP_MUTATION.test(method)) return true;
  }
  return false;
}

function isRead(argv: string[]): boolean {
  if (argv.length === 0) return true;
  const program = basenameOf(argv[0]);
  if (READ_PROGRAM.has(program)) return true;
  const rest = argv.slice(1);
  switch (program) {
    case "sed":
      return !rest.some((token) => SED_IN_PLACE.test(unquote(token)));
    case "git": return isGitRead(rest);
    case "gh": {
      const [group, verb] = words(rest, GH_VALUE_FLAG);
      if (group === "api") return !mutatesOverHttp(rest) && !rest.some((token) => GH_FIELD_FLAG.test(unquote(token)));
      return group === undefined || GH_READ.has(`${group} ${verb}`);
    }
    case "curl":
    case "wget":
      return !mutatesOverHttp(rest) && !rest.some((token) => TRANSFER_FLAG.test(unquote(token)));
    default:
      return false;
  }
}

const LABELLED_BY_SUBCOMMAND = new Set(["git", "gh", "npm", "pnpm", "docker", "kubectl"]);

function labelOf(argv: string[]): string {
  const program = basenameOf(argv[0]);
  if (!LABELLED_BY_SUBCOMMAND.has(program)) return program;
  const rest = PACKAGE_RUNNER.has(program) ? argv.slice(1).filter((word) => !PACKAGE_RUNNER_WORD.has(word)) : argv.slice(1);
  const [subcommand] = words(rest, program === "git" ? GIT_VALUE_FLAG : program === "gh" ? GH_VALUE_FLAG : NO_VALUE_FLAG);
  return subcommand ? `${program} ${subcommand}` : program;
}

export function parseRunCommand(command: string): { label: string; verified: boolean; dryRun: boolean } | undefined {
  const control = parseControlCommand(command);
  if (control) return { label: control.subcommand, verified: true, dryRun: control.dryRun };
  for (const segment of command.split(SEGMENT)) {
    const argv = strip(segment.split(/\s+/).filter(Boolean), false);
    if (isRead(strip(argv, true))) continue;
    return { label: labelOf(argv), verified: false, dryRun: DRY_RUN.test(segment) };
  }
  return undefined;
}
