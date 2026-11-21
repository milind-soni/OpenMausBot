import path from "node:path";
import os from "node:os";

export function resolvePaths(overrides = {}) {
  const home = os.homedir();
  const ombDataDir = overrides.ombDataDir || process.env.OMB_DATA_DIR || path.join(home, ".openmausbot");
  const toolsDir = overrides.toolsDir || process.env.ANTIGRAVITY_TOOLS_DIR || path.join(home, ".antigravity_tools");
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");

  return {
    ombDataDir,
    toolsDir,
    configPath: path.join(ombDataDir, "config.json"),
    botsPath: path.join(ombDataDir, "bots.json"),
    statePath: path.join(ombDataDir, "antigravity-sync-state.json"),
    lockPath: path.join(ombDataDir, "antigravity-sync-daemon.lock"),
    logPath: path.join(ombDataDir, "logs", "antigravity-sync-daemon.log"),
    guiConfigPath: path.join(toolsDir, "gui_config.json"),
    accountsIndexPath: path.join(toolsDir, "accounts.json"),
    accountsDetailDir: path.join(toolsDir, "accounts"),
    startupVbsPath: path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "antigravity-sync-daemon.vbs"),
    runtimeDaemonPath: path.join(ombDataDir, "antigravity-sync-daemon.mjs")
  };
}

export function redactSecrets(text) {
  if (typeof text !== "string") {
    try {
      text = JSON.stringify(text);
    } catch {
      return text;
    }
  }
  return text
    .replace(/1\/\/[a-zA-Z0-9_\-]+/g, "1//[REDACTED_REFRESH_TOKEN]")
    .replace(/GOCSPX-[a-zA-Z0-9_\-]+/g, "GOCSPX-[REDACTED_CLIENT_SECRET]")
    .replace(/sk-[a-zA-Z0-9_\-]{8,}/g, "sk-[REDACTED_KEY]")
    .replace(/ya29\.[a-zA-Z0-9_\-]+/g, "ya29.[REDACTED_ACCESS_TOKEN]")
    .replace(/(Bearer\s+)[a-zA-Z0-9_\.\-]+/gi, "$1[REDACTED_BEARER]");
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const options = {
    mode: "status", // default if none provided
    policy: "primary-and-unhealthy",
    force: false,
    json: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--status") {
      options.mode = "status";
    } else if (arg === "--sync-now" || arg === "--once") {
      options.mode = "sync-now";
    } else if (arg === "--dry-run") {
      options.mode = "dry-run";
    } else if (arg === "--daemon") {
      options.mode = "daemon";
    } else if (arg === "--install-autostart") {
      options.mode = "install-autostart";
    } else if (arg === "--uninstall-autostart") {
      options.mode = "uninstall-autostart";
    } else if (arg === "--register-gateway") {
      options.mode = "register-gateway";
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--policy") {
      const next = argv[++i];
      if (next === "all" || next === "primary-and-unhealthy") {
        options.policy = next;
      }
    }
  }

  return options;
}
