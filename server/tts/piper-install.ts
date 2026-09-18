// One-click Piper provisioning, the counterpart to the documented manual
// install: fetch the engine build for this machine plus one voice, verify each
// artifact against a pinned SHA-256, and unpack it into the workspace data dir.
//
// Nothing downloads on its own. This runs only when the user asks for it from
// Settings, exactly like the browser engine's install route, and every artifact
// is pinned to a hash so a swapped file is refused rather than executed.
//
// The engine ships as a .tar.gz everywhere except Windows, which gets a .zip;
// both are unpacked with the platform's own tar (GNU/BSD tar reads the former,
// and Windows' bundled bsdtar reads the latter from an absolute path so a
// hermetic PATH cannot break it). No new dependency, and no archive is ever
// unpacked before its hash matches.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { piperAvailable, piperRoot } from "./piper.ts";

export const PIPER_RELEASE = "2023.11.14-2";
const RELEASE_BASE = `https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE}`;
const VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

export interface PiperEngineArtifact {
  url: string;
  /** The hash the download must have before anything is unpacked. */
  sha256: string;
  archive: "zip" | "tar.gz";
}

/**
 * Engine builds per target, each with the hash it must match.
 *
 * Windows on arm64 and 32-bit Linux are absent on purpose: piper publishes no
 * build for them, so Settings offers no button there rather than a download
 * that could never run. An unknown target is refused with the docs pointer.
 */
export const PIPER_ENGINES: Record<string, PiperEngineArtifact> = {
  "win32-x64": {
    url: `${RELEASE_BASE}/piper_windows_amd64.zip`,
    sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
    archive: "zip",
  },
  "linux-x64": {
    url: `${RELEASE_BASE}/piper_linux_x86_64.tar.gz`,
    sha256: "a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992",
    archive: "tar.gz",
  },
  "linux-arm64": {
    url: `${RELEASE_BASE}/piper_linux_aarch64.tar.gz`,
    sha256: "fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb",
    archive: "tar.gz",
  },
  "darwin-x64": {
    url: `${RELEASE_BASE}/piper_macos_x64.tar.gz`,
    sha256: "ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b",
    archive: "tar.gz",
  },
  "darwin-arm64": {
    url: `${RELEASE_BASE}/piper_macos_aarch64.tar.gz`,
    sha256: "6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc",
    archive: "tar.gz",
  },
};

/** The voice installed alongside the engine: medium quality, which is the tier
 * that keeps synthesis ahead of speech on a laptop. */
export const PIPER_DEFAULT_VOICE = "en_US-amy-medium";

export const PIPER_VOICE_FILES: Record<string, Array<{ name: string; url: string; sha256: string }>> = {
  "en_US-amy-medium": [
    {
      name: "en_US-amy-medium.onnx",
      url: `${VOICE_BASE}/en/en_US/amy/medium/en_US-amy-medium.onnx`,
      sha256: "b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18",
    },
    {
      name: "en_US-amy-medium.onnx.json",
      url: `${VOICE_BASE}/en/en_US/amy/medium/en_US-amy-medium.onnx.json`,
      sha256: "95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77",
    },
  ],
};

export function piperTarget(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function piperEngineArtifact(target: string): PiperEngineArtifact | null {
  return PIPER_ENGINES[target] ?? null;
}

export function piperInstallable(target: string): boolean {
  return piperEngineArtifact(target) !== null;
}

/** The platform's own tar for the archive shape at hand. */
export function unpackCommand(
  archivePath: string,
  artifact: PiperEngineArtifact,
  destination: string,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const flag = artifact.archive === "zip" ? "-xf" : "-xzf";
  if (platform === "win32") {
    return {
      command: join(env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
      args: [flag, archivePath, "-C", destination],
    };
  }
  return { command: "tar", args: [flag, archivePath, "-C", destination] };
}

async function download(url: string, sha256: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256) {
    throw new Error(`Checksum mismatch for ${url}: expected ${sha256}, got ${digest}`);
  }
  return bytes;
}

export async function unpackArchive(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.trim().split("\n").slice(-1)[0] ?? "unknown error"}`));
    });
  });
}

export interface PiperInstallOptions {
  /** Defaults to the workspace engine root (`<data dir>/piper`). */
  root?: string;
  target?: string;
  voiceId?: string;
  fetchImpl?: typeof fetch;
  /** Test seam for the unpacker. */
  unpack?: (command: string, args: string[]) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Install the engine and one voice into `root`. Throws with a message safe to
 * show the user; leaves nothing behind on failure, so a retry starts clean.
 */
export async function installPiper(options: PiperInstallOptions = {}): Promise<void> {
  const root = options.root ?? piperRoot();
  const target = options.target ?? piperTarget();
  const voiceId = options.voiceId ?? PIPER_DEFAULT_VOICE;
  const artifact = piperEngineArtifact(target);
  const log = options.log ?? (() => {});
  if (!artifact) {
    throw new Error(`Piper publishes no engine for ${target} — install it manually (see the voice docs).`);
  }
  const voiceFiles = PIPER_VOICE_FILES[voiceId];
  if (!voiceFiles) throw new Error(`Unknown Piper voice ${voiceId}.`);
  if (piperAvailable(root) && voiceFiles.every((file) => existsSync(join(root, "voices", file.name)))) {
    log(`piper is already installed at ${root}`);
    return;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const unpack = options.unpack ?? unpackArchive;

  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, ".install-"));
  try {
    const archivePath = join(staging, artifact.archive === "zip" ? "engine.zip" : "engine.tar.gz");
    log(`downloading ${artifact.url}`);
    await writeFile(archivePath, await download(artifact.url, artifact.sha256, fetchImpl));

    const extracted = join(staging, "engine");
    await mkdir(extracted, { recursive: true });
    const { command, args } = unpackCommand(archivePath, artifact, extracted);
    await unpack(command, args);

    // Voice files first, engine last: every availability check in the app keys
    // on the engine binary, so it must appear only once the installation is
    // complete. Doing it the other way round reports a usable engine while the
    // voice is still downloading — the panel then hides the install button and
    // speaking fails with "no voice models", which is exactly what it looks like
    // when the order is wrong.
    const voicesDir = join(root, "voices");
    await mkdir(voicesDir, { recursive: true });
    for (const file of voiceFiles) {
      log(`downloading ${file.name}`);
      await writeFile(join(voicesDir, file.name), await download(file.url, file.sha256, fetchImpl));
    }

    // Every published archive wraps its files in a piper/ directory; tolerate a
    // flat one too rather than assuming a layout we do not control.
    const source = existsSync(join(extracted, "piper")) ? join(extracted, "piper") : extracted;
    for (const entry of await readdir(source)) {
      const destination = join(root, entry);
      // `voices/` is never in an engine archive, so this cannot delete a voice
      // the user already has; it only replaces engine files being upgraded.
      await rm(destination, { recursive: true, force: true });
      await rename(join(source, entry), destination);
    }
    if (!piperAvailable(root)) throw new Error("The archive did not contain the Piper engine binary.");
    log(`piper installed at ${root}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

let installPromise: Promise<void> | null = null;
let installError: string | null = null;

/** One install at a time, reported through this state rather than a throw —
 * the settings panel polls it the same way it polls engine availability. */
export function piperInstallState(): { installing: boolean; error: string | null } {
  return { installing: installPromise !== null, error: installError };
}

/** `done` resolves when the install settles, whether it succeeded or not —
 * the route awaits it to broadcast the new status instead of polling. */
export function startPiperInstall(
  options: PiperInstallOptions = {},
): { started: boolean; done: Promise<void> } {
  if (installPromise) return { started: false, done: installPromise };
  installError = null;
  installPromise = installPiper(options)
    .then(
      () => {
        installError = null;
      },
      (error: unknown) => {
        installError = error instanceof Error ? error.message : String(error);
      },
    )
    .finally(() => {
      installPromise = null;
    });
  return { started: true, done: installPromise };
}
