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

/** The name we spawn when neither Settings nor a known install location has a
 * path. A bare name that does not resolve is exactly what "not installed"
 * looks like, so the user-facing error keys off this string and nothing else. */
export const HANDY_BARE_EXE = "Handy.exe";

export const HANDY_MISSING_ERROR = "Handy.exe not found — set its path in Settings → Wake word.";

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
  try {
    // Handy ships as an app bundle on macOS and is not on PATH; the README's
    // own tip is to invoke the bundle binary directly.
    if (platform === "darwin") {
      const bundle = "/Applications/Handy.app/Contents/MacOS/handy";
      if (!exists(HANDY_BARE_EXE) && exists(bundle)) return bundle;
    }
    const fallback = path.join(home, "AppData", "Local", "Handy", "handy.exe");
    if (!exists(HANDY_BARE_EXE) && exists(fallback)) return fallback;
  } catch {}
  return HANDY_BARE_EXE;
}

/** True when we are about to spawn the bare name because nothing was
 * configured and nothing was found — i.e. Handy is not installed here. */
export function handyExeMissing(exe, exists = fs.existsSync) {
  return exe === HANDY_BARE_EXE && !exists(exe);
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
 * Read-only snapshot of the user's Handy install: the executable we would
 * spawn, the model Handy has selected, and the models on disk. `selected` can
 * legitimately differ from `installed` — a model can be selected in Handy's
 * window before it has been downloaded — and reporting both is the honest
 * answer rather than silently pretending they agree.
 */
export async function readHandyEngine({ handyPath, appDataDir, environment }) {
  const exe = resolveHandyExe(handyPath, environment);
  const dir = path.join(appDataDir, HANDY_BUNDLE_ID);
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
    found: !handyExeMissing(exe, environment.exists),
    exe,
    selected,
    installed: installed.sort(),
    device: deviceFacts(),
  };
}
