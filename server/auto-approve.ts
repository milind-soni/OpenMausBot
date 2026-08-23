import { isAbsolute, relative, resolve } from "node:path";

// Guarded autonomy: routine task-scoped work keeps moving without asking.
//
// Permission requests have three outcomes: safe scoped work is allowed,
// broad irreversible destruction asks, and raw secret output is denied.
//
// The guard is deliberately tiny and literal. It is NOT a security
// boundary (an agent set on damage has a thousand spellings for `rm`);
// it is a "you probably didn't mean to hand THIS one over unattended"
// backstop for the obvious catastrophes. Real containment is the
// sandbox and the bot's own computer, not a regex.

const DESTRUCTIVE = [
  // Exact task-local deletion is routine. Recursive/glob deletion is broad;
  // cwd/path enforcement below separately cards absolute and traversal exits.
  /\brm\b[^|;&\n]*\s(?:-[A-Za-z]*r[A-Za-z]*|--recursive)(?:\s|$)/i,
  /\brm\b[^|;&\n]*[*?\[]/i,
  /\bmkfs\b|\bdiskutil\s+erase|\bdd\s+[^|]*\bof=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/, // fork bomb
  /\bgit\s+push\s+[^|;&\n]*(?:--force(?:-with-lease)?\b|--delete\b|--mirror\b|(?:^|\s):[^\s]+)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[^\s]*f/i,
  /\bgit\s+(?:branch|tag)\s+-[dD]\b|\bgh\s+repo\s+delete\b/i,
  /\bgit\s+update-ref\s+-d\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b|\bDELETE\s+FROM\b/i,
  /\bsudo\s+rm\b|\bchmod\s+-R\s+777\s+\//i,
  /\b(?:terraform\s+destroy|kubectl\s+delete\s+(?:namespace|cluster)|docker\s+system\s+prune)\b/i,
  /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/i,
  /\b(?:find|fd)\b[^|;&\n]*\s-delete\b|\bRemove-Item\b[^|;&\n]*(?:-Recurse\b|[*?\[])/i,
  /\bgh\s+api\b[^|;&\n]*(?:-X|--method)(?:=|\s*)DELETE\b/i,
  /\baws\s+s3\s+rm\b[^|;&\n]*\s--recursive\b|\baws\s+s3api\s+delete-[\w-]+\b/i,
];

const DESTRUCTIVE_TOOL = /(?:^|__|[./_-])(?:delete|remove|unlink|rmdir|trash|purge|destroy|wipe)(?:[./_-]|$)/i;
const LOCAL_FILE_DELETE_TOOL = /^(?:delete[_-]file|remove[_-](?:file|path)|trash[_-]file|unlink|rmdir)$/i;
const REMOTE_API_TOOL = /(?:^|__|[./_-])(?:api|http|request|fetch)(?:[./_-]|$)/i;
const REMOTE_DELETE_METADATA = /(?:^|[^\w])(?:method|verb|(?:http|request)[_-]?method)["']?\s*[:=]\s*["']?DELETE\b/i;
const REMOTE_DELETE_REQUEST = /(?:^|[\s"'(])DELETE\s+(?:https?:\/\/|\/)[^\s"'`]+/i;
const CUA_TOOL = /(?:^|__|[./_-])(?:computer|cua|browser|chrome|playwright)(?:[./_-]|$)|^(?:click|tap|type|press[_-]?key)$/i;
const IRREVERSIBLE_CUA_NOUN = "(?:(?:user\\s+)?account|workspace|project|repository|organization|database)";
const IRREVERSIBLE_CUA_RESULT = "(?:deletion|removal|closure|termination)";
// The destructive phrase must end here (or name the confirmation control).
// Without this, benign UI/docs text such as "account settings" or
// "repository removal documentation" inherits a destructive prefix.
const IRREVERSIBLE_CUA_COMPLETION =
  `(?=` +
  `\\s*(?:$|[.!?,;:)\\]}'"])` +
  `|\\s+(?:(?:and|then)\\s+confirm(?:\\s+(?:button|link))?|(?:button|link))\\s*(?:$|[.!?,;:)\\]}'"])` +
  `)`;
const CUA_IRREVERSIBLE_ACTION = new RegExp(
  `\\b(?:` +
    `(?:permanently\\s+)?(?:delete|remove|close|erase|terminate|destroy|purge|wipe)\\s+(?:(?:the|this|my|your)\\s+)?${IRREVERSIBLE_CUA_NOUN}` +
    `|(?:permanent\\s+)?${IRREVERSIBLE_CUA_NOUN}\\s+${IRREVERSIBLE_CUA_RESULT}` +
    `|${IRREVERSIBLE_CUA_RESULT}\\s+of\\s+(?:(?:the|this|my|your)\\s+)?${IRREVERSIBLE_CUA_NOUN}` +
    `)${IRREVERSIBLE_CUA_COMPLETION}`,
  "i",
);

// Names and paths that may contain protected values. A mention alone is
// safe; matchRawValueAccess combines these with an output/transfer action.
const SENSITIVE_NAME = [
  /(^|[\s/"'])\.env(\.|$|["'\s])/i,
  /\.ssh\/|id_rsa|id_ed25519|authorized_keys/i,
  /\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json/i,
  /security\s+find-(generic|internet)-password|\bkeychain\b/i,
  /\bcredentials?\.json\b|\bserviceaccount\b/i,
];

// A path/name is not itself a leak. Require an operation that emits or
// transfers its contents; brokered execution by logical name stays routine.
const VALUE_READ_VERB = /\b(?:read|cat|head|tail|less|more|sed|awk|grep|strings|base64|xxd|cp|scp|rsync)\b/i;
const VALUE_READ_TOOL = /(?:^|__|[./_-])(?:read(?:[./_-]?file)?|get[./_-]?file|download[./_-]?file)(?:[./_-]|$)/i;
const VALUE_OUTPUT_OPERATIONS = [
  /\bsecurity\s+find-(?:generic|internet)-password\b[^|;&\n]*\s-w(?:\s|$)/i,
  /\bcredvault[_-]?(?:get[_-]?secret|read[_-]?secret|show[_-]?secret|reveal|export|raw)\b/i,
  /(?:^|[;&|\n]\s*)\b(?:credvault|cv)\s+(?:get|read|show|reveal|dump|export|raw)\b/i,
  /(?:^|[;&|\n]\s*)\bop\s+read\s+op:\/\//i,
  /(?:^|[;&|\n]\s*)\bpass\s+(?:show|grep)\b/i,
  /\b(?:get|read|show|reveal|dump|export)[_-]?(?:secret|credential|token|password)[_-]?(?:value|raw)?\b/i,
  /(?:^|\s--\s|[;&|]\s*|\b(?:ba|z)?sh\s+-c\s+["']?)\s*(?:sudo\s+)?(?:\/usr\/bin\/)?(?:env|set)\s*(?:["']?\s*$|[|>&])/i,
  /(?:^|\s--\s|[;&|]\s*|\b(?:ba|z)?sh\s+-c\s+["']?)\s*(?:sudo\s+)?(?:\/usr\/bin\/)?env\s+(?:-0|--null)\b/i,
  /\bprintenv(?:\s*["']?\s*$|\s+[A-Z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)[A-Z0-9_]*\s*(?:["']?\s*$|[|>&]))/i,
  /\bjq\b[^|;&\n]*\s(?:env|\$ENV)(?:\s|$)/i,
  /\b(?:echo|printf)\b[^|;&\n]*\$(?:\{)?[A-Z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)[A-Z0-9_]*(?:\})?/i,
  /\b(?:show|print|reveal|return|dump|export|copy)\b.{0,48}\b(?:api[- ]?key|access[- ]?token|password|secret|credential)(?:\s+(?:value|contents?))?\b/i,
  /\b(?:auth|config)\b.{0,80}\b(?:token|password|secret|credential)\b/i,
];

const VALUE_OUTPUT_TOOL =
  /(?:^|__|[./_-])(?:get|read|fetch|show|reveal|return|dump|export|copy)[_-]?(?:api[_-]?key|access[_-]?token|secret|credential|token|password)(?:[./_-]|$)/i;

const CREDVAULT_EXEC = /\b(?:credvault(?:[_-]env)?[_-]exec|credvault\s+exec|cv\s+exec)\b/i;
// Deliberate raw-output runtime boundary: shell/eval families, JS runtimes,
// Python/PyPy release executables, and PowerShell preview builds. This is not
// an arbitrary language-runtime ban (for example Lua/R remain normal tools).
const VALUE_CAPABLE_PROGRAM = /^(?:\.|env|printenv|eval|source|sh|ash|bash|dash|zsh|fish|ksh|csh|tcsh|cmd|wscript|cscript|mshta|(?:node|nodejs|ruby|perl|php)(?:\d+(?:\.\d+)*)?|(?:python|pythonw|pypy|py)(?:\d+(?:\.\d+)*(?:[a-z]+)?)?|deno|bun|osascript|pwsh(?:-preview)?|powershell)$/i;

interface EffectiveCommand {
  words: string[];
  program: string;
  programIndex: number;
  executableToken: string;
  executableTokens: string[];
}

/** First matching pattern's source, so a verdict can NAME the rule that
 * made it — the decision log's whole value is "which rule", and deriving
 * the match a second time at the call site is how the log and the verdict
 * drift apart. */
function matchFirst(rules: RegExp[], text: string): string | null {
  for (const re of rules) if (re.test(text)) return re.source;
  return null;
}

function cleanCommandWord(word: string): string {
  return word.replace(/^[('" ]+|[)'", ]+$/g, "");
}

function programName(word: string): string {
  return (cleanCommandWord(word).split(/[/\\]/).pop() ?? "").replace(/\.exe$/i, "").toLowerCase();
}

/** Minimal shell-word lexer for executable classification. It preserves
 * quoted whitespace and common backslash escapes, while rejecting syntax it
 * cannot reconstruct exactly. Expansion/substitution is rejected earlier by
 * requestStaysInsideTask; an unclosed quote fails closed here. */
function tokenizeCommand(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"') {
        index += 1;
        if (index >= command.length) return null;
        word += command[index];
      } else {
        word += char;
      }
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      index += 1;
      if (index >= command.length) return null;
      word += command[index];
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    word += char;
    started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

function skipOptions(words: string[], start: number, optionsWithValue: Set<string>): number | null {
  let index = start;
  while (index < words.length) {
    const word = cleanCommandWord(words[index] ?? "");
    if (word === "--") return index + 1;
    if (!word.startsWith("-") || word === "-") return index;
    const option = word.split("=", 1)[0] ?? word;
    index += 1;
    if (optionsWithValue.has(option) && !word.includes("=")) {
      if (index >= words.length) return null;
      index += 1;
    }
  }
  return index;
}

/** Resolve transparent process wrappers to the executable they launch.
 * Unknown/dynamic wrappers return null so guarded autonomy asks rather than
 * blessing the wrapper name while ignoring its consumer. */
function effectiveCommand(command: string): EffectiveCommand | null {
  const words = tokenizeCommand(command.replace(/^\(+/, "").trim());
  if (!words) return null;
  let index = 0;
  const executableTokens: string[] = [];
  const skipAssignments = () => {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cleanCommandWord(words[index] ?? ""))) index += 1;
  };
  skipAssignments();

  for (let depth = 0; depth < 16 && index < words.length; depth += 1) {
    const executableToken = cleanCommandWord(words[index] ?? "");
    const program = programName(executableToken);
    if (!program) return null;
    executableTokens.push(executableToken);

    let next: number | null;
    switch (program) {
      case "sudo":
      case "doas":
        next = skipOptions(
          words,
          index + 1,
          new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-D", "--chdir", "-R", "--chroot", "-p", "--prompt"]),
        );
        break;
      case "env":
        // env -S reparses one string into a new argv. The whitespace token
        // stream below cannot reconstruct shell quoting faithfully, so card
        // it instead of mistaking words inside the split string for argv.
        if (
          words
            .slice(index + 1)
            .map(cleanCommandWord)
            .some((word) => word === "-S" || word.startsWith("-S") || word === "--split-string" || word.startsWith("--split-string="))
        ) return null;
        next = skipOptions(words, index + 1, new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]));
        if (next !== null) {
          const envIndex = index;
          index = next;
          skipAssignments();
          if (index >= words.length) {
            return { words, program: "env", programIndex: envIndex, executableToken, executableTokens };
          }
          continue;
        }
        return null;
      case "command":
        if (/^-v$/i.test(cleanCommandWord(words[index + 1] ?? "")) || cleanCommandWord(words[index + 1] ?? "") === "-V") {
          return { words, program: "command-lookup", programIndex: index, executableToken, executableTokens };
        }
        next = skipOptions(words, index + 1, new Set());
        break;
      case "builtin":
        next = skipOptions(words, index + 1, new Set());
        break;
      case "busybox":
        next = skipOptions(words, index + 1, new Set());
        break;
      case "nice":
        next = skipOptions(words, index + 1, new Set(["-n", "--adjustment"]));
        break;
      case "nohup":
      case "unbuffer":
      case "setsid":
        next = skipOptions(words, index + 1, new Set());
        break;
      case "exec":
        next = skipOptions(words, index + 1, new Set(["-a"]));
        break;
      case "stdbuf":
        next = skipOptions(words, index + 1, new Set(["-i", "--input", "-o", "--output", "-e", "--error"]));
        break;
      case "timeout": {
        next = skipOptions(words, index + 1, new Set(["-k", "--kill-after", "-s", "--signal"]));
        if (next === null || !/^(?:\d|inf)/i.test(cleanCommandWord(words[next] ?? ""))) return null;
        next += 1;
        break;
      }
      case "time":
        next = skipOptions(words, index + 1, new Set(["-f", "--format", "-o", "--output"]));
        break;
      case "watch":
        next = skipOptions(words, index + 1, new Set(["-n", "--interval"]));
        break;
      case "ionice":
        next = skipOptions(words, index + 1, new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]));
        break;
      case "taskset": {
        const optionStart = index + 1;
        next = skipOptions(words, optionStart, new Set(["-c", "--cpu-list"]));
        if (next === null) return null;
        if (next === optionStart || !/[c]/i.test(words.slice(optionStart, next).join(""))) next += 1;
        break;
      }
      case "chrt":
        next = skipOptions(words, index + 1, new Set(["-T", "--sched-runtime", "-P", "--sched-period", "-D", "--sched-deadline"]));
        if (next !== null) next += 1; // scheduling priority precedes command
        break;
      case "xargs":
      case "parallel":
        return null; // stdin can inject paths/arguments not present in summary
      default:
        if (
          program === "script" ||
          (/^(?:find|fd)$/.test(program) &&
            words
              .slice(index + 1)
              .some((word) => /^(?:(?:-x|-X|--exec|--exec-batch)(?:=.*)?|-exec|-execdir|-ok|-okdir)$/.test(cleanCommandWord(word))))
        ) {
          return null;
        }
        return { words, program, programIndex: index, executableToken, executableTokens };
    }
    if (next === null || next >= words.length) return null;
    index = next;
    skipAssignments();
  }
  return null;
}

function matchRawValueAccess(text: string): string | null {
  const direct = matchFirst(VALUE_OUTPUT_OPERATIONS, text);
  if (direct) return direct;
  const path = matchFirst(SENSITIVE_NAME, text);
  return path && VALUE_READ_VERB.test(text) ? `${VALUE_READ_VERB.source} + ${path}` : null;
}

function matchRawValueRequest(tool: string, summary: string): string | null {
  if (VALUE_OUTPUT_TOOL.test(tool)) return VALUE_OUTPUT_TOOL.source;
  const direct = matchRawValueAccess(summary) ?? matchRawValueAccess(tool);
  if (direct) return direct;
  const path = matchFirst(SENSITIVE_NAME, summary);
  const pathMatch = path && (VALUE_READ_VERB.test(tool) || VALUE_READ_TOOL.test(tool))
    ? `${VALUE_READ_TOOL.source} + ${path}`
    : null;
  return pathMatch ?? matchWrappedRawValueAccess(tool, summary);
}

function credVaultCommandTail(tool: string, summary: string): string | null {
  const inTool = CREDVAULT_EXEC.test(tool);
  const match = inTool ? null : CREDVAULT_EXEC.exec(summary);
  if (!inTool && !match) return null;
  const tail = inTool ? summary : summary.slice((match?.index ?? 0) + (match?.[0].length ?? 0));
  const delimiter = tail.indexOf(" -- ");
  return delimiter < 0 ? null : tail.slice(delimiter + 4).trim();
}

/** Detect raw environment output after transparent wrappers. This is kept
 * separate from scope classification because value disclosure is a deny,
 * not an approval card. */
function matchWrappedRawValueAccess(tool: string, summary: string): string | null {
  const credentialCommand = credVaultCommandTail(tool, summary);
  if (!credentialCommand && !COMMAND_TOOLS.has(bareToolName(tool))) return null;
  const command = credentialCommand ?? summary;
  for (const segment of command.split(/&&|\|\||[;|\n]/).map((part) => part.trim()).filter(Boolean)) {
    const effective = effectiveCommand(segment);
    if (!effective) continue;
    const normalized = effective.words.slice(effective.programIndex).join(" ");
    const normalizedMatch = matchRawValueAccess(normalized);
    if (normalizedMatch) return normalizedMatch;
    if (effective.program === "env") return "wrapped-environment-output";
    if (effective.program !== "printenv") continue;
    const operands = effective.words
      .slice(effective.programIndex + 1)
      .map(cleanCommandWord)
      .filter((word) => word && !word.startsWith("-"));
    if (!operands.length || operands.some((word) => /(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)/i.test(word))) {
      return "wrapped-environment-output";
    }
  }
  return null;
}

/** A named CredVault use is eligible only when it binds one logical name to
 * one fixed, non-interpreter command. The value stays inside that consumer;
 * dynamic shell/eval/output forms ask or deny before execution. */
function credVaultCommandIsFixed(tool: string, summary: string): boolean | null {
  const hasCredentialExec = CREDVAULT_EXEC.test(tool) || CREDVAULT_EXEC.test(summary);
  if (!hasCredentialExec) return null;
  const command = credVaultCommandTail(tool, summary);
  if (command === null) return false;
  if (!command || /[;&|`$<>\n\r]/.test(command)) return false;
  const effective = effectiveCommand(command);
  return effective !== null && !VALUE_CAPABLE_PROGRAM.test(effective.program);
}

export function looksSensitive(text: string): boolean {
  return matchRawValueAccess(text) !== null;
}

export function looksDestructive(text: string): boolean {
  return (
    matchFirst(DESTRUCTIVE, text) !== null ||
    matchParsedCommandDestruction("Bash", text) !== null ||
    matchRemoteDeleteCommand("Bash", text) !== null
  );
}

/** The key an "Always allow" remembers.
 *
 * A bare tool name is far too coarse for a command runner: remembering
 * "Bash" would hand the bot a permanent unattended shell, which is the
 * opposite of what someone pressing "always allow" on `git status`
 * intends. Command tools are therefore keyed by their program —
 * `Bash:git`, `Bash:npm` — so the grant is as narrow as the thing you
 * actually looked at. Computed once, server-side, and echoed back by the
 * client so the two sides can never disagree about what was granted. */
const COMMAND_TOOLS = new Set(["bash", "shell", "execute", "run_command", "computer_exec", "terminal"]);
const FILE_TOOLS = /^(?:read|write|edit|patch|apply_patch|read_file|write_file|edit_file|filesystem|delete_file|remove_file|remove_path|trash_file|unlink|rmdir)(?:$|__|[./_-])/i;
const LOCAL_DELETE_PROGRAM = /^(?:rm|unlink|rmdir|del|erase|remove-item)$/i;
const PATH_INSENSITIVE_PROGRAM = /^(?:echo|printf|command-lookup)$/i;

/** MCP server names may contain underscores. Stop at the protocol's double
 * underscore delimiter, not at the first underscore in the server name. */
function bareToolName(tool: string): string {
  return tool.replace(/^mcp__.+?__/i, "").toLowerCase();
}

function isLocalFileDeleteTool(tool: string): boolean {
  if (!LOCAL_FILE_DELETE_TOOL.test(bareToolName(tool))) return false;
  if (!/^mcp__/i.test(tool)) return true;
  const server = /^mcp__(.+?)__/i.exec(tool)?.[1] ?? "";
  return /(?:^|_)(?:filesystem|file_system)(?:_|$)/i.test(server);
}

function matchDestructiveTool(tool: string): string | null {
  if (!DESTRUCTIVE_TOOL.test(tool)) return null;
  return isLocalFileDeleteTool(tool) ? null : DESTRUCTIVE_TOOL.source;
}

function matchRemoteDestructive(tool: string, summary: string): string | null {
  if (!REMOTE_API_TOOL.test(tool)) return null;
  const request = REMOTE_DELETE_REQUEST.test(summary)
    ? REMOTE_DELETE_REQUEST.source
    : REMOTE_DELETE_METADATA.test(summary)
      ? REMOTE_DELETE_METADATA.source
      : null;
  return request ? `${REMOTE_API_TOOL.source} + ${request}` : null;
}

function matchIrreversibleCua(tool: string, summary: string): string | null {
  return CUA_TOOL.test(tool) && CUA_IRREVERSIBLE_ACTION.test(summary)
    ? `${CUA_TOOL.source} + ${CUA_IRREVERSIBLE_ACTION.source}`
    : null;
}

function matchRemoteDeleteCommand(tool: string, summary: string): string | null {
  if (!COMMAND_TOOLS.has(bareToolName(tool))) return null;
  for (const segment of summary.split(/&&|\|\||[;|\n]/).map((part) => part.trim()).filter(Boolean)) {
    const effective = effectiveCommand(segment);
    if (!effective) continue;
    const args = effective.words.slice(effective.programIndex + 1).map(cleanCommandWord);
    if (/^(?:curl|wget)$/.test(effective.program)) {
      const hasDeleteMethod = args.some((word, index) =>
        /^(?:-X|--request|--method)=?DELETE$/i.test(word) ||
        (/^(?:-X|--request|--method)$/i.test(word) && args[index + 1]?.toUpperCase() === "DELETE"),
      );
      if (hasDeleteMethod) return "remote-http-delete";
    }
    if (/^(?:http|https|xh)$/.test(effective.program)) {
      if (args.some((word) => word.toUpperCase() === "DELETE")) return "remote-http-delete";
    }
  }
  return null;
}

/** Quote-clean checks for destructive command forms whose raw spelling may
 * hide flags from the literal regex layer. Exact local deletion remains
 * routine; only recursive/glob deletion and remote bucket destruction card. */
function matchParsedCommandDestruction(tool: string, summary: string): string | null {
  if (!COMMAND_TOOLS.has(bareToolName(tool))) return null;
  for (const segment of summary.split(/&&|\|\||[;|\n]/).map((part) => part.trim()).filter(Boolean)) {
    const effective = effectiveCommand(segment);
    if (!effective) continue;
    const args = effective.words.slice(effective.programIndex + 1).map(cleanCommandWord);
    if (effective.program === "rm") {
      if (args.some((word) => /^-[^-]*r/i.test(word) || word === "--recursive")) return "parsed-rm-recursive";
      if (args.some((word) => /[*?\[]/.test(word))) return "parsed-rm-glob";
    }
    if (
      effective.program === "aws" &&
      ((args[0] === "s3" && args[1] === "rm" && args.includes("--recursive")) ||
        (args[0] === "s3api" && /^delete-[\w-]+$/i.test(args[1] ?? "")))
    ) {
      return "parsed-aws-destruction";
    }
  }
  return null;
}

export function approvalKey(tool: string, summary: string, scope?: "local-computer"): string {
  const bare = bareToolName(tool);
  if (!COMMAND_TOOLS.has(bare)) return scope ? `${scope}:${tool}` : tool;
  const program = effectiveCommand(summary.split(/&&|\|\||[;|\n]/, 1)[0] ?? "")?.program ?? "";
  const key = program ? `${tool}:${program}` : tool;
  return scope ? `${scope}:${key}` : key;
}

export interface AutoApprover {
  autoApprove?: boolean;
  alwaysAllow?: string[];
}

/** Why a verdict landed the way it did. `unattended-block` remains for old
 * decision-log rows; safe webhook work now uses guarded autonomy. */
export type AutoVerdictSource =
  | "always-allow"
  | "auto-mode"
  | "guarded-autonomy"
  | "unattended-block"
  | "local-computer-block"
  | "destructive-guard"
  | "sensitive-guard"
  | "credential-scope-guard"
  | "incomplete-summary"
  | "unscoped-guard"
  | "no-grant";

export interface AutoVerdict {
  /** Provider behavior. `ask` leaves the request open for a human. */
  behavior: "allow" | "deny" | "ask";
  /** Chip text for an automatic allow; null for ask or deny.
   * The string becomes the chip in the transcript, so an auto-approved
   * action is never invisible. */
  approve: string | null;
  source: AutoVerdictSource;
  /** What identifies the rule that decided: the matched regex (guards) or
   * the granted key (always-allow, and unattended-block over one). Auto
   * mode has no narrower identity than the mode itself, so it carries none. */
  rule?: string;
}

export interface GuardedAutoContext {
  /** the turn was started by an outside event, with nobody at the keyboard */
  unattended?: boolean;
  /** the request controls the user's active desktop */
  scope?: "local-computer";
  /** Explicit true only when the provider retained the full executable ask. */
  summaryComplete?: boolean;
  taskScope?: {
    taskThreadId: string;
    requestThreadId: string;
    taskCwd: string;
    requestCwd: string;
    workspaceBound: boolean;
  };
}

function hasExactTaskScope(context?: GuardedAutoContext): boolean {
  const scope = context?.taskScope;
  if (!scope || !scope.workspaceBound || scope.taskThreadId !== scope.requestThreadId) return false;
  if (!isAbsolute(scope.taskCwd) || !isAbsolute(scope.requestCwd)) return false;
  return resolve(scope.taskCwd) === resolve(scope.requestCwd);
}

function isStrictTaskDescendant(target: string, taskCwd: string): boolean {
  const cleaned = cleanCommandWord(target);
  if (!cleaned || /[*?\[\]{}]/.test(cleaned)) return false;
  if (/^(?:\.|\.\/|\/)$/.test(cleaned)) return false;
  const rel = relative(taskCwd, resolve(taskCwd, cleaned));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function commandDeleteTargetsAreStrict(command: EffectiveCommand, taskCwd: string): boolean {
  const operands: string[] = [];
  let afterOptions = false;
  for (const raw of command.words.slice(command.programIndex + 1)) {
    const word = cleanCommandWord(raw);
    if (!afterOptions && word === "--") {
      afterOptions = true;
      continue;
    }
    if (!afterOptions && word.startsWith("-")) continue;
    operands.push(word);
  }
  return operands.length > 0 && operands.every((target) => isStrictTaskDescendant(target, taskCwd));
}

function fileDeleteTargetsAreStrict(summary: string, taskCwd: string): boolean {
  if (/^[{[]/.test(summary.trim())) {
    try {
      const parsed: unknown = JSON.parse(summary);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const record = parsed as Record<string, unknown>;
      const allowed = new Set(["path", "filePath", "target", "paths"]);
      if (Object.keys(record).some((key) => !allowed.has(key))) return false;
      const targets: string[] = [];
      for (const key of ["path", "filePath", "target"] as const) {
        const value = record[key];
        if (typeof value === "string") targets.push(value);
        else if (value !== undefined) return false;
      }
      if (record.paths !== undefined) {
        if (!Array.isArray(record.paths) || !record.paths.every((value) => typeof value === "string")) return false;
        targets.push(...record.paths);
      }
      return targets.length > 0 && targets.every((target) => isStrictTaskDescendant(target, taskCwd));
    } catch {
      return false;
    }
  }
  const structured = summary
    .split("\n")
    .map((line) => /^(?:delete|remove)\s+(.+)$/i.exec(line.trim())?.[1])
    .filter((target): target is string => Boolean(target));
  const targets = structured.length ? structured : [summary.trim()];
  return targets.every((target) => isStrictTaskDescendant(target, taskCwd));
}

function explicitPathsStayInsideTask(
  text: string,
  taskCwd: string,
  executableTokens: Set<string>,
  deletesPath: boolean,
): boolean {
  const absolutePaths = text.match(/(?:^|[\s='"(])(?:\/[^\s'"`;|&)]*|[A-Za-z]:\\[^\s'"`;|&)]+)/g) ?? [];
  return absolutePaths.every((raw) => {
    const candidate = raw.trim().replace(/^[='"(]+|[),]+$/g, "");
    if (!candidate || !isAbsolute(candidate)) return true;
    if (executableTokens.has(candidate)) return true;
    const rel = relative(taskCwd, resolve(candidate));
    return (!deletesPath || rel !== "") && (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)));
  });
}

function requestStaysInsideTask(tool: string, summary: string, context?: GuardedAutoContext): boolean {
  const scope = context?.taskScope;
  if (!scope) return false;
  const bare = bareToolName(tool);
  const commandTool = COMMAND_TOOLS.has(bare);
  if (!commandTool && !FILE_TOOLS.test(bare)) return true;
  const taskCwd = resolve(scope.taskCwd);
  const fileToolDeletesPath = isLocalFileDeleteTool(tool);

  // Dynamic shells/interpreters and path expansion cannot be proven cwd-only
  // from the approval summary. Card them instead of approving a guess.
  if (
    /(?:^|[\s"'=(]|[/\\])\.\.(?:[/\\]|$)|(?:^|\s)~(?:[/\\\s]|$)|\$(?:\{|\(|[A-Za-z_])|`/.test(summary) ||
    /\\\\[^\\\s]+\\[^\\\s]+/.test(summary) ||
    /\bfile:\/\/(?:\/|\\)/i.test(summary)
  ) return false;
  if (fileToolDeletesPath && !fileDeleteTargetsAreStrict(summary, taskCwd)) return false;
  if (commandTool) {
    // Every shell segment gets its own executable check. Looking only at the
    // first word let `git status; python -c ...` inherit git's approval.
    const segments = summary.split(/&&|\|\||[;|\n]/).map((segment) => segment.trim()).filter(Boolean);
    if (!segments.length) return false;
    for (const segment of segments) {
      const effective = effectiveCommand(segment);
      if (!effective || VALUE_CAPABLE_PROGRAM.test(effective.program)) return false;
      const deletesPath = LOCAL_DELETE_PROGRAM.test(effective.program);
      if (deletesPath) {
        if (!commandDeleteTargetsAreStrict(effective, taskCwd)) return false;
      }
      if (!PATH_INSENSITIVE_PROGRAM.test(effective.program)) {
        const executableTokens = new Set(effective.executableTokens);
        if (!explicitPathsStayInsideTask(segment, taskCwd, executableTokens, deletesPath)) return false;
      }
    }
    return true;
  }
  return explicitPathsStayInsideTask(summary, taskCwd, new Set(), fileToolDeletesPath);
}

/** The verdict AND its provenance. The decision itself is unchanged from
 * autoDecision below — this exists so the decision log can record which
 * rule decided without the call site re-deriving (and eventually
 * mis-deriving) the match. */
export function autoVerdict(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: GuardedAutoContext,
): AutoVerdict {
  // Guards outrank every grant. Destruction asks; raw value access denies.
  const destructive =
    matchFirst(DESTRUCTIVE, summary) ??
    matchFirst(DESTRUCTIVE, tool) ??
    matchParsedCommandDestruction(tool, summary) ??
    matchRemoteDeleteCommand(tool, summary) ??
    matchRemoteDestructive(tool, summary) ??
    matchIrreversibleCua(tool, summary) ??
    matchDestructiveTool(tool);
  // Match separately: prefixing the tool used to defeat anchored shell rules
  // such as bare `printenv` and made a raw-value request look routine.
  const sensitive = destructive ? null : matchRawValueRequest(tool, summary);
  if (sensitive) return { behavior: "deny", approve: null, source: "sensitive-guard", rule: sensitive };
  if (destructive) return { behavior: "ask", approve: null, source: "destructive-guard", rule: destructive };

  const fixedCredentialCommand = credVaultCommandIsFixed(tool, summary);
  if (fixedCredentialCommand === false) {
    return { behavior: "ask", approve: null, source: "credential-scope-guard", rule: CREDVAULT_EXEC.source };
  }
  if (context?.summaryComplete !== true) {
    return { behavior: "ask", approve: null, source: "incomplete-summary" };
  }

  const key = approvalKey(tool, summary, context?.scope);
  // Host CUA crosses cwd and sandbox boundaries, and terse metadata such as
  // "click" cannot prove reversibility. Never auto-answer it, even when a
  // legacy Auto toggle or remembered grant is present.
  if (context?.scope === "local-computer") {
    return {
      behavior: "ask",
      approve: null,
      source: "local-computer-block",
      rule: bot.alwaysAllow?.includes(key) ? key : undefined,
    };
  }
  if (!hasExactTaskScope(context) || !requestStaysInsideTask(tool, summary, context)) {
    return { behavior: "ask", approve: null, source: "unscoped-guard" };
  }

  // Safe scoped work is automatic. Webhook origin is provenance, not a
  // blanket veto; the same destructive and raw-value guards still apply.
  const grant =
    bot.alwaysAllow?.includes(key)
      ? { approve: `auto-approved ${key} (always allowed)`, source: "always-allow" as const, rule: key }
      : bot.autoApprove
        ? { approve: `auto-approved ${tool}`, source: "auto-mode" as const, rule: undefined }
        : {
            approve: `auto-approved ${tool} (guarded autonomy)`,
            source: "guarded-autonomy" as const,
            rule: undefined,
          };
  return { behavior: "allow", ...grant };
}

/** Why this request may be answered without the human, or null to ask. */
export function autoDecision(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: GuardedAutoContext,
): string | null {
  const verdict = autoVerdict(bot, tool, summary, context);
  return verdict.behavior === "allow" ? verdict.approve : null;
}
