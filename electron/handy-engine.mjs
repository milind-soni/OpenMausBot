// Where Handy (https://handy.computer) keeps its own state, and how to find
// its executable. Extracted from the IPC handlers so the part that decides
// *which* Handy the app is talking to — and which model it will run — is
// pinned by tests that need no Electron process and no microphone.
//
// Read-only by design. Handy owns its settings file, rewrites it on exit, and
// changing the user's engine there would alter dictation in every app on the
// machine, not just this one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Handy's Tauri bundle identifier: the folder name it uses for app data. */
export const HANDY_BUNDLE_ID = "com.pais.handy";

/**
 * The bare name we spawn when neither Settings nor a known install location has
 * a path: the Windows build installs as Handy.exe, every other build as
 * `handy`. A bare name that does not resolve is exactly what "not installed"
 * looks like, so both the user-facing error and the "found" flag key off it.
 */
export function handyExeName(platform = process.platform) {
  return platform === "win32" ? "Handy.exe" : "handy";
}

/** Windows' bare name, kept as the documented default for callers and tests. */
export const HANDY_BARE_EXE = handyExeName("win32");

export const HANDY_MISSING_ERROR = `${handyExeName()} not found — set its path in Settings → Wake word.`;

/** AppleDouble companions (`._encoder.onnx`) are checkout metadata, not
 * models — counting them would report a model that is not there. */
export function isHandyModelFile(name) {
  return !name.startsWith("._") && /\.(gguf|bin|onnx)$/i.test(name);
}

/**
 * One resolution of the Handy executable for every channel that needs it: the
 * path from Settings, else PATH, else the platform's standard install spot, so
 * the toggle, the transcribe call and the model readout can never disagree
 * about which Handy they are talking to.
 *
 * `environment.exists` is injected rather than read from disk directly, which
 * is what makes the fallback order testable on any operating system.
 */
export function resolveHandyExe(handyPath, environment) {
  const explicit = typeof handyPath === "string" && handyPath.trim() ? handyPath.trim() : null;
  if (explicit) return explicit;
  const { home, platform, exists } = environment;
  const bare = handyExeName(platform);
  try {
    // Handy ships as an app bundle on macOS and is not on PATH; the README's
    // own tip is to invoke the bundle binary directly.
    if (platform === "darwin") {
      const bundle = "/Applications/Handy.app/Contents/MacOS/handy";
      if (!exists(bare) && exists(bundle)) return bundle;
    }
    // Windows installs per user and is not on PATH either. Linux builds
    // (AppImage, distro package, AUR) have no single install location to guess
    // at, so guessing one would only invent a path that is not there: the bare
    // name on PATH is the honest answer.
    if (platform === "win32") {
      const fallback = path.join(home, "AppData", "Local", "Handy", "handy.exe");
      if (!exists(bare) && exists(fallback)) return fallback;
    }
  } catch {}
  return bare;
}

/** True when we are about to spawn the bare name because nothing was
 * configured and nothing was found — i.e. Handy is not installed here. */
export function handyExeMissing(exe, exists = fs.existsSync, platform = process.platform) {
  return exe === handyExeName(platform) && !exists(exe);
}

/** The specs the renderer turns into model advice. */
export function deviceFacts() {
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? "",
    cores: os.cpus().length,
    ramGB: Math.round(os.totalmem() / 2 ** 30),
  };
}

/**
 * The model ids `--model` actually accepts.
 *
 * This is NOT the models-directory folder name: `--model
 * parakeet-tdt-0.6b-v2-int8` fails with "Model not found" while
 * `--model parakeet-tdt-0.6b-v2` runs, and a pin Handy cannot resolve is a
 * dictation that errors out. The catalog is therefore the only honest source
 * for the picker, and it is also what knows which entries are downloaded —
 * pinning an entry that is not downloaded fails the same way.
 *
 * Returns [] rather than throwing when Handy cannot answer: an empty list
 * degrades the picker, while a throw would take the whole panel down.
 */
export async function readHandyCatalog({ exe, run, timeoutMs = 20_000 }) {
  try {
    const parsed = JSON.parse(await run(exe, ["--list-models", "--json"], timeoutMs));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((model) => typeof model?.id === "string" && model.id)
      .map((model) => ({
        id: model.id,
        name: typeof model.name === "string" && model.name ? model.name : model.id,
        sizeMB: typeof model.size_mb === "number" ? model.size_mb : 0,
        downloaded: model.is_downloaded === true,
      }));
  } catch {
    return [];
  }
}

/**
 * Handy's own state directory: Tauri's app_data_dir is the platform's data
 * directory plus the bundle identifier. That is %APPDATA% on Windows and
 * ~/Library/Application Support on macOS, which is what Electron's appData
 * reports too — but on Linux Tauri uses $XDG_DATA_HOME (~/.local/share), NOT
 * the ~/.config that Electron's appData points at. Reading the wrong directory
 * there would report an installed Handy as having no models at all.
 */
export function handyDataDir(environment) {
  const { home, platform, appData, env = process.env } = environment;
  if (platform === "linux") {
    const dataHome =
      typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim()
        ? env.XDG_DATA_HOME.trim()
        : path.join(home, ".local", "share");
    return path.join(dataHome, HANDY_BUNDLE_ID);
  }
  return path.join(appData, HANDY_BUNDLE_ID);
}

/**
 * Read-only snapshot of the user's Handy install: the executable we would
 * spawn, the model Handy has selected, and the models on disk. `selected` can
 * legitimately differ from `installed` — a model can be selected in Handy's
 * window before it has been downloaded — and reporting both is the honest
 * answer rather than silently pretending they agree.
 */
export async function readHandyEngine({ handyPath, dataDir, environment }) {
  const exe = resolveHandyExe(handyPath, environment);
  const dir = dataDir ?? handyDataDir(environment);
  const modelsDir = path.join(dir, "models");
  let selected = null;
  const installed = [];
  try {
    const raw = await fs.promises.readFile(path.join(dir, "settings_store.json"), "utf8");
    const value = JSON.parse(raw)?.settings?.selected_model;
    if (typeof value === "string" && value.trim()) selected = value.trim();
  } catch {}
  try {
    for (const entry of await fs.promises.readdir(modelsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = await fs.promises.readdir(path.join(modelsDir, entry.name)).catch(() => []);
      if (files.some(isHandyModelFile)) installed.push(entry.name);
    }
  } catch {}
  return {
    ok: true,
    found: !handyExeMissing(exe, environment.exists, environment.platform),
    exe,
    selected,
    installed: installed.sort(),
    device: deviceFacts(),
  };
}
