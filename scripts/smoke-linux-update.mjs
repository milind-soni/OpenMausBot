// End-to-end proof that an AppImage update lands on the path the user
// launches, run against the real release feed.
//
// The unit tests drive AppImageUpdater.doInstall with hand-made files. This
// drives the whole thing: the shipped bundle, extracted from the packaged
// AppImage, checking the real canonical release feed, downloading the real
// asset, and installing it over a copy that carries a version in its name —
// the exact shape that used to orphan the launcher.
//
// The current version is reported by the app adapter, not read from the file,
// so a build newer than the latest release can still be told to update: we
// claim an old version and let the published release be the newer one.
//
// Runs under Electron (electron-updater needs its net stack):
//   xvfb-run -a pnpm exec electron scripts/smoke-linux-update.mjs
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { app } = require("electron");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");

// A version older than the oldest release we would ever test against, so the
// published feed is always an upgrade regardless of what is packaged here.
const PRETEND_VERSION = "0.0.1";

function fail(message) {
  console.error(`[smoke-linux-update] ${message}`);
  app.exit(1);
}

// Missing is an answer, not a crash: when the install renames instead of
// overwriting, the launched path is gone and that is the finding to report.
function sha512(file) {
  try {
    return createHash("sha512").update(readFileSync(file)).digest("base64");
  } catch {
    return null;
  }
}

function onlyAppImage() {
  const matches = readdirSync(releaseDir).filter((name) => name.endsWith(".AppImage"));
  if (matches.length !== 1) throw new Error(`expected one packaged AppImage, found ${matches.length}`);
  return path.join(releaseDir, matches[0]);
}

async function main() {
  const packaged = onlyAppImage();
  const workspace = mkdtempSync(path.join(tmpdir(), "omb-update-smoke-"));
  const installDir = path.join(workspace, "opt");
  const applications = path.join(workspace, "applications");
  mkdirSync(installDir);
  mkdirSync(applications);

  // The bug shape: a version in the filename, and a launcher pinned to it.
  const launched = path.join(installDir, "OpenMausBot-0.0.1-x86_64.AppImage");
  copyFileSync(packaged, launched);
  const desktopEntry = path.join(applications, "com.openmausbot.app.desktop");
  writeFileSync(
    desktopEntry,
    `[Desktop Entry]\nName=OpenMausBot\nExec=${launched} %U\nType=Application\n`,
  );

  // Isolate every path the updater writes to.
  process.env.XDG_CACHE_HOME = path.join(workspace, "cache");
  process.env.APPIMAGE = launched;
  app.setPath("userData", path.join(workspace, "userdata"));

  // The updater under test is the one that ships, not the one in the tree.
  // Electron resolves paths inside an asar natively, so this loads the exact
  // module the packaged app would require. An explicit path lets the same
  // harness run against an unpatched bundle, which must fail — a smoke that
  // cannot fail proves nothing.
  const bundle =
    process.argv.find((argument) => argument.startsWith("--updater="))?.slice("--updater=".length) ??
    path.join(root, "release/linux-unpacked/resources/app.asar/electron/vendor/electron-updater.cjs");
  console.log(`[smoke-linux-update] updater under test: ${bundle}`);
  const { AppImageUpdater } = require(bundle);

  const updateConfig = path.join(workspace, "app-update.yml");
  copyFileSync(path.join(root, "release/linux-unpacked/resources/app-update.yml"), updateConfig);

  // The constructor parses the current version once, so this has to be in
  // place before the updater exists. Without it the comparison runs against
  // Electron's own version and every real release looks like a downgrade.
  app.getVersion = () => PRETEND_VERSION;

  const updater = new AppImageUpdater();
  updater.updateConfigPath = updateConfig;
  updater.forceDevUpdateConfig = true;
  updater.autoDownload = false;
  updater.logger = { info: log, warn: log, error: log, debug: () => {} };

  function log(...values) {
    console.log("   ", ...values.map(String));
  }

  console.log("[smoke-linux-update] checking the real release feed…");
  const result = await updater.checkForUpdates();
  if (!result?.updateInfo?.version) throw new Error("the feed returned no update");
  // A feed response alone is not an offer: a version comparison that decided
  // "not available" still carries updateInfo, and reading only that would let
  // this smoke pass without ever installing anything.
  if (result.isUpdateAvailable !== true) {
    throw new Error(
      `the feed's ${result.updateInfo.version} was not treated as an update over ${PRETEND_VERSION}`,
    );
  }
  const offered = result.updateInfo.version;
  console.log(`[smoke-linux-update] feed offers ${offered}`);

  const expected = result.updateInfo.files?.find((file) => file.url.endsWith(".AppImage"));
  if (!expected?.sha512) throw new Error("the feed declares no AppImage checksum");

  console.log("[smoke-linux-update] downloading…");
  await updater.downloadUpdate(result.cancellationToken);

  // Record the relaunch instead of starting a second app; the file placement
  // is what this proves, and the target it would launch is part of that.
  let relaunched = null;
  updater.spawnLog = (target) => {
    relaunched = target;
  };
  updater.quitAndInstall(true, true);

  const survivors = readdirSync(installDir);
  const desktop = readFileSync(desktopEntry, "utf8");
  const execTarget = desktop.match(/^Exec=(.*?) %U$/m)?.[1];
  console.log(`[smoke-linux-update] files left in the install directory: ${survivors.join(", ")}`);

  const checks = [
    ["the update stayed on the launched path", survivors.includes(path.basename(launched))],
    ["no second AppImage appeared", survivors.length === 1],
    [
      "the launcher still points at a real file",
      execTarget === launched && existsSync(launched),
    ],
    ["the file now holds the published build", sha512(launched) === expected.sha512],
    ["the relaunch uses the launched path", relaunched === launched],
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✔" : "✖"} ${label}`);
    if (!ok) failed += 1;
  }
  if (failed > 0) {
    console.error(`[smoke-linux-update] ${failed} check(s) failed; workspace kept at ${workspace}`);
    app.exit(1);
    return;
  }

  rmSync(workspace, { recursive: true, force: true });
  console.log(`[smoke-linux-update] OK — updated 0.0.1 → ${offered} in place`);
  app.exit(0);
}

app.whenReady().then(main).catch((error) => fail(error.stack ?? String(error)));
