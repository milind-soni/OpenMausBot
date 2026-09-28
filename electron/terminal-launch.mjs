import { execFile } from "node:child_process";

/** Resolve only after the launcher really spawns or reports an error. */
function launch(executable, args, options, run = execFile) {
  return new Promise((resolve) => {
    let child;
    try {
      child = run(executable, args, options);
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (ok) child.unref?.();
      resolve(ok);
    };
    child.once("spawn", () => finish(true));
    child.once("error", () => finish(false));
  });
}

/** Open a blank terminal. Installer text is deliberately not accepted here,
 * so renderer-controlled input can never become a process argument. */
export async function openBlankTerminal(platform = process.platform, run = execFile) {
  if (platform === "darwin") {
    return launch(
      "osascript",
      ["-e", 'tell application "Terminal" to activate'],
      undefined,
      run,
    );
  }
  if (platform === "win32") {
    // Launched directly, PowerShell's stdin and stdout are pipes to this app,
    // and from the windowless app it gets no visible window: the app reports
    // a terminal nobody can see or type into. A hidden PowerShell hands the
    // real one to Start-Process, which gives it a console window of its own.
    // The command is fixed text.
    return launch(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Start-Process powershell.exe"],
      { windowsHide: true },
      run,
    );
  }
  if (platform === "linux") {
    for (const terminal of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
      if (await launch(terminal, [], undefined, run)) return true;
    }
  }
  return false;
}
