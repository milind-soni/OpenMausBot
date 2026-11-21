/** Hooks for the private --settings file. Claude Code runs each command with the event JSON on
 * stdin and applies any hookSpecificOutput it prints. */
export function claudeHookSettings(helperPath: string, platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  // Claude Code runs `command` as a shell line: sh on macOS and Linux; on Windows Git Bash, or PowerShell
  // when Git Bash is missing, and the two quote differently. Given `args` (2.1.139), it starts `command` itself.
  // JSON quoting is not shell quoting: $(), backticks and $names expand inside double quotes.
  const hook = platform === "win32"
    ? { type: "command", command: process.execPath, args: [helperPath], timeout: 5 }
    : { type: "command", command: [process.execPath, helperPath].map(path => `'${path.replace(/'/g, "'\\''")}'`).join(" "), timeout: 5 };
  // Claude Code holds a tool's result until its synchronous hooks exit, and every hook starts a process (on Windows the
  // whole Electron binary). An async hook holds nothing; 2.1.308 still kills one at its timeout (2.1.325 does not), so it
  // gets room for a slow start. The matchers keep a process from starting for events whose reply the harness never sends.
  return {
    PostToolUse: [{ matcher: "", hooks: [{ ...hook, async: true, timeout: 60 }] }],
    PostToolUseFailure: [{ matcher: "Bash", hooks: [hook] }],
    PreCompact: [{ matcher: "", hooks: [hook] }],
    SessionStart: [{ matcher: "compact", hooks: [hook] }],
  };
}
