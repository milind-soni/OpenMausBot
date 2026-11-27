import { execFile } from "node:child_process";

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

/** Installer text is deliberately not accepted, so renderer-controlled input never becomes a process argument. */
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
    // Launched directly from the windowless app, PowerShell gets piped stdio and no visible window;
    // a hidden PowerShell hands the real one to Start-Process, which gets its own console.
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
