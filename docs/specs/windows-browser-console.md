# Windows built-in browser opens a console window

Status: open; documented from `main` at `6a9f8b9e2` (0.1.155). This change adds
no fix. It records the reproduction, the two spawn paths that produce the
window, what already exists in the tree, and the options a fix has.

Related: [#4572](https://github.com/milind-soni/OpenMausBot/issues/4572),
[#2891](https://github.com/milind-soni/OpenMausBot/pull/2891),
[#4391](https://github.com/milind-soni/OpenMausBot/pull/4391),
[#3033](https://github.com/milind-soni/OpenMausBot/issues/3033),
[#4660](https://github.com/milind-soni/OpenMausBot/issues/4660),
[#4737](https://github.com/milind-soni/OpenMausBot/issues/4737).

## What happens

On Windows, when a bot uses its built-in browser, a `cmd.exe` window opens and
stays for the browsing session. With Windows Terminal as the default terminal,
the same console appears as a Terminal window. Closing it kills the browser,
and the bot's next browser call opens another one.

The window is not the browser itself: Chrome is headed and has no console. It
is a console allocated for a child process that the browser engine starts.

## Reproduction

1. On Windows, with the bundled browser engine and either Google Chrome
   installed or the bundled headless shell, ask a bot to open a page with its
   browser tools.
2. Watch the process tree: `OpenMausBot.exe` → `agent-browser.exe` →
   `cmd.exe` → `chrome.exe`, often with `OpenConsole.exe` or
   `WindowsTerminal.exe` started for the new console.
3. Ask the bot for another browser action. In the reported cases the chain
   restarts, and every launch opens another window.

Reported on 0.1.141 through 0.1.143, Windows 10/11, with
`agent-browser 0.36.0-omb.1`. The same code paths are present at `main`
(0.1.155).

## The two paths

| Machine | Process chain | Why the console appears |
|---|---|---|
| Google Chrome installed | `agent-browser.exe` → `cmd.exe` → `chrome.exe` | The engine launches the generated `chrome-launcher.cmd` batch file. A batch file runs through `cmd.exe`, which is a console program. The engine's daemon was started with no console, so Windows allocates a new one for `cmd.exe`. The batch waits for Chrome, so the window stays for the browser's lifetime. |
| No Google Chrome | `agent-browser.exe` → `chrome-headless-shell.exe` | The bundled headless shell is a console-subsystem executable. It is spawned without `CREATE_NO_WINDOW`, so Windows allocates a console for it. |

Both are descendants of `agent-browser`, not of the OpenMausBot server, so
OpenMausBot's own `windowsHide: true` cannot reach them.

## Why the batch file exists

OpenMausBot gives the bot's Chrome an identity that matches a headed browser:
its own user agent, client hints and screen size. The engine accepts extra
Chrome flags through `AGENT_BROWSER_ARGS`, but agent-browser 0.36/0.37 splits
that value at commas, and a user agent contains commas (`(KHTML, like Gecko)`).
The flags therefore ride a generated launcher instead:

- `server/browser/chrome/wrapper.ts` writes
  `%USERPROFILE%\.openmausbot\browser\chrome-launcher.cmd` on Windows and
  `chrome-launcher.sh` elsewhere (`launcherPath`, `launcherScript`).
- `server/browser/chrome/launcher.ts` points
  `AGENT_BROWSER_EXECUTABLE_PATH` at that launcher (`env()`).
- `server/browser-processes.ts` already expects the batch file's `cmd.exe`
  parent when it identifies a Chrome process on Windows, which confirms the
  chain in the code and in the process table.

The server starts `agent-browser` with `windowsHide: true`
(`server/procs.ts`), and that flag hides the engine's own console. It is not
inherited by the children the engine creates.

## What already exists

- **Candidate vendor revision 0.36.0-omb.2** adds `CREATE_NO_WINDOW` at
  agent-browser's Chrome launch site, with a native Windows regression test
  that asserts `GetConsoleWindow() == 0`
  (`third_party/browser/agent-browser-windows-stdio.patch`). #2891 prepared and
  validated the candidate, and the reporting user confirmed the console
  disappeared after replacing only the engine binary on a local install.
- **Production still pins 0.36.0-omb.1**
  (`server/browser-engine-release.ts`), and
  `third_party/browser/README.md` says the resolver keeps it until the
  candidate passes native checks and its published digest is reviewed.
  `docs/browser-packaging.md` records the same state in its Windows backport
  section.
- **A workaround exists:** `browserEngine.engine: "chrome"` runs OpenMausBot's
  own Chrome driver instead of agent-browser. That driver spawns Chrome
  directly with `windowsHide: true` and writes no launcher, so there is no
  `cmd.exe` in the chain (confirmed in #4572's comments). It uses a separate
  browser profile, so existing bot sign-ins are not carried over.

## Open questions for a fix

1. Does 0.36.0-omb.2's `CREATE_NO_WINDOW` also cover the `cmd.exe` that runs
   the generated `.cmd`, or only the headless shell? The flag is set on
   agent-browser's Chrome `Command`; the batch wrapper is a separate `cmd.exe`
   process. This needs native verification on a machine with Google Chrome
   installed before the revision is pinned.
2. Can the identity flags reach agent-browser without a batch file (a newer
   argument format, or a small executable launcher)? That removes `cmd.exe`
   from the chain instead of hiding it.
3. The reported relaunch loop is a separate symptom: OpenMausBot polls the
   launcher's `cmd.exe` pid as if it were the browser. Closing the window, or
   the engine stopping its child, can look like a dead browser and start
   another one. Tracking the Chrome pid belongs in the relaunch fix, not in
   the console fix.

## Options, not implemented here

1. Publish and pin a verified Windows vendor revision that sets
   `CREATE_NO_WINDOW` on every console-subsystem child (headless shell and the
   `cmd.exe` wrapper).
2. Replace the `.cmd` launcher with an executable launcher that inherits no
   console, keeping the same identity flags.
3. Pass the identity flags through the engine's supported argument mechanism,
   if a version accepts them without comma splitting, and drop the launcher.
4. Make the direct Chrome driver the default on Windows once it reaches parity
   with the engine for profiles and signed-in sites.

## Out of scope

The separate console windows from a bot's own shell and PowerShell commands,
and from background SSH, Docker, ADB, Tailscale and MCP probes, are tracked in
#4660 and #4737. They share the missing-`windowsHide`/`CREATE_NO_WINDOW`
pattern but have different spawn sites.
