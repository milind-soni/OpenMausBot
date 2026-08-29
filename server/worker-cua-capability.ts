// The second fence: the short-lived CUA capability manifest.
//
// The base policy is the stable ceiling; this is the per-task boundary that
// intersects it, derived entirely from an already-approved task manifest so no
// new authority can enter here. The worker companion writes it and then
// requires the daemon to report back this exact digest before the task runs.
//
// Browser and generic desktop input are deliberately split. CUA refuses an
// origin-scoped browser manifest that also exposes generic input, because a
// generic click can reach anything on screen and would make the origin list
// decorative.
import { createHash } from "node:crypto";

import type { WorkerPlatform } from "./computer-workers.ts";
import type { WorkerTaskManifest } from "./worker-task-manifest.ts";

const WINDOWS_ABSOLUTE = /^[A-Za-z]:\\/;
const POSIX_ABSOLUTE = /^\//;

const FILE_MANAGER = {
  windows: "C:\\Windows\\explorer.exe",
  macos: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
} satisfies Record<WorkerPlatform, string>;

/** JSON double-quoted strings are valid YAML scalars, which avoids hand-rolling
 * quoting rules for Windows paths, profile names, and origins. */
const yamlString = (value: string): string => JSON.stringify(value);

function assertTaskRoot(platform: WorkerPlatform, taskRoot: string): void {
  const absolute = platform === "windows" ? WINDOWS_ABSOLUTE : POSIX_ABSOLUTE;
  if (!absolute.test(taskRoot) || /[\u0000\r\n]/.test(taskRoot)) {
    throw new Error(`Worker CUA task root must be an absolute ${platform} path`);
  }
}

function lifetime(manifest: WorkerTaskManifest, now: number) {
  const expiresSeconds = Math.floor((manifest.expiresAt - now) / 1_000);
  if (expiresSeconds < 1) throw new Error("Worker task capability manifest is expired");
  const idleSeconds = Math.max(1, Math.min(expiresSeconds, Math.floor(manifest.idleTimeoutMs / 1_000)));
  return { expiresSeconds, idleSeconds };
}

const BROWSER_TOOLS = [
  "start_session",
  "end_session",
  "list_windows",
  "browser_prepare",
  "get_browser_state",
  "browser_navigate",
  "browser_click",
  "browser_type",
];

const DESKTOP_TOOLS = [
  "start_session",
  "end_session",
  "launch_app",
  "list_windows",
  "get_window_state",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "wait",
  "bring_to_front",
];

const app = (executable: string): string[] => [
  `    - executable: ${yamlString(executable)}`,
  "      launch: true",
  "      windows: all",
  "      terminate: driver_launched",
];

/** Build the native CUA v3 capability manifest the interactive daemon loads. */
export function workerCuaCapabilityManifest(
  manifest: WorkerTaskManifest,
  taskRoot: string,
  now = Date.now(),
): string {
  assertTaskRoot(manifest.platform, taskRoot);
  const { expiresSeconds, idleSeconds } = lifetime(manifest, now);
  const head = [
    "version: 3",
    `expires_after: ${expiresSeconds}s`,
    `idle_timeout: ${idleSeconds}s`,
    "",
    "allow:",
    "  tools:",
  ];

  if (manifest.surface === "browser") {
    if (manifest.origins.length === 0) throw new Error("Browser CUA capability requires exact origins");
    return [
      ...head,
      ...BROWSER_TOOLS.map((tool) => `    - ${tool}`),
      "",
      "resources:",
      "  apps:",
      ...app(manifest.target.browserExecutable),
      "  browser:",
      "    profiles:",
      "      - kind: existing_profile",
      "    origins:",
      ...manifest.origins.map((origin) => `      - ${yamlString(origin)}`),
      "  desktop:",
      "    display: false",
      "",
    ].join("\n");
  }

  if (manifest.origins.length > 0) throw new Error("Desktop CUA capability cannot include browser origins");
  return [
    ...head,
    ...DESKTOP_TOOLS.map((tool) => `    - ${tool}`),
    "",
    "resources:",
    "  apps:",
    ...app(manifest.target.ideExecutable),
    ...app(FILE_MANAGER[manifest.platform]),
    "  files:",
    "    read:",
    `      - dir: ${yamlString(taskRoot)}`,
    "        recursive: true",
    "    write:",
    `      - dir: ${yamlString(taskRoot)}`,
    "        recursive: true",
    "  desktop:",
    "    display: false",
    "",
  ].join("\n");
}

export function workerCuaCapabilityDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
