import { globSync } from "node:fs";
import path from "node:path";

// Most e2e files drive OMB's own logic through a real server and fake engines, which is the same on every OS, so CI
// runs them on Linux only. The files below also run on the Windows and macOS shards, which set OMB_VITEST_E2E=host:
// each one either has a test that never runs on Linux or depends on how the OS treats paths, processes or Chrome.
export const E2E = /\.e2e\.test\.[cm]?[jt]s$/;

export const HOST_E2E: Readonly<Record<string, string>> = {
  "server/acp-shutdown.e2e.test.ts": "Windows ends an engine on SIGTERM at once, without its exit handlers",
  "server/browser/egress/hostile-pages.e2e.test.ts": "a real Chrome behind the egress gate on each OS",
  "server/cloud-lending.e2e.test.ts": "Windows keeps a running process's working folder, and the lent computer is named for its OS",
  "server/cloud-send-kinds.e2e.test.ts": "this computer's paths, Windows backslashes included, in what a moved bot is told",
  "server/cloud-sync.e2e.test.ts": "a PC folder's paths and copies on the desktop's own file system",
  "server/group-local-vm.e2e.test.ts": "This computer behind the control gate and the macOS permission failure, which Linux has not",
  "server/headless-cli.e2e.test.ts": "the omb command line as a real process on each OS",
  "server/host-lazy-claim.e2e.test.ts": "Auto on the person's own desktop, which only macOS and Windows have",
  "server/long-running-chief.e2e.test.ts": "a teammate's screen call on the person's own desktop, macOS and Windows only",
  "server/room-roots.e2e.test.ts": "the host desktop fallback, macOS and Windows only",
  "server/runtime-roots.e2e.test.ts": "the host desktop fallback, macOS and Windows only",
  "server/session-credentials.e2e.test.ts": "Auto on this computer, macOS and Windows only",
  "server/setup-import.e2e.test.ts": "importing through links, which Windows makes as junctions",
  "server/shared-computers.e2e.test.ts": "PowerShell commands and Windows process trees on a shared computer",
  "server/surface-pins.e2e.test.ts": "the desktop's own computer connection, validated per OS and absent on Linux",
  "server/voice-notes.e2e.test.ts": "the built-in Mac voices",
};

/** True on the CI shards that run only HOST_E2E of the e2e files. */
export function hostE2eOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_VITEST_E2E === "host";
}

/** Whether a repo-relative POSIX path is an e2e file that runs on Linux only. */
export function isPortableE2e(file: string): boolean {
  return E2E.test(file) && !Object.hasOwn(HOST_E2E, file);
}

/** The repo-relative POSIX paths of every e2e file the include globs find that runs on Linux only. */
export function portableE2eFiles(root: string, include: readonly string[]): string[] {
  return globSync([...include], { cwd: root, exclude: (file) => /(^|[\\/])node_modules$/.test(file) })
    .map((file) => file.split(path.sep).join("/"))
    .filter(isPortableE2e)
    .sort();
}
