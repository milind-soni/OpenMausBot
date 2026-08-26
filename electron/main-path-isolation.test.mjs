import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");
const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);
const devBuilderConfig = readFileSync(
  fileURLToPath(new URL("../electron-builder.dev.yml", import.meta.url)),
  "utf8",
);

it("applies Electron path overrides before credentials and logs are resolved", () => {
  const userDataOverride = source.indexOf('appPathOverride("OMB_USER_DATA_DIR")');
  const userDataSetPath = source.indexOf('app.setPath("userData", USER_DATA_OVERRIDE)');
  const logOverride = source.indexOf('appPathOverride("OMB_LOG_DIR")');
  const logSetPath = source.indexOf('app.setPath("logs", LOG_DIR_OVERRIDE)');
  const credentialsFile = source.indexOf("const CREDENTIALS_FILE =");
  const logDirectory = source.indexOf("const LOG_DIR = app.getPath");

  for (const position of [
    userDataOverride,
    userDataSetPath,
    logOverride,
    logSetPath,
    credentialsFile,
    logDirectory,
  ]) {
    expect(position).not.toBe(-1);
  }
  expect(userDataOverride).toBeLessThan(userDataSetPath);
  expect(userDataSetPath).toBeLessThan(credentialsFile);
  expect(logOverride).toBeLessThan(logSetPath);
  expect(logSetPath).toBeLessThan(logDirectory);
});

it("gives Chromium's explicit user-data-dir switch precedence", () => {
  expect(source).toMatch(
    /const USER_DATA_OVERRIDE = app\.commandLine\.hasSwitch\("user-data-dir"\)\s*\? null\s*: appPathOverride\("OMB_USER_DATA_DIR"\);/,
  );
  expect(source).toMatch(/if \(USER_DATA_OVERRIDE\) app\.setPath\("userData", USER_DATA_OVERRIDE\);/);
});

it("requires isolated absolute non-root path overrides", () => {
  expect(source).toMatch(/if \(!path\.isAbsolute\(configured\)\) throw new Error/);
  expect(source).toMatch(/resolved === path\.parse\(resolved\)\.root/);
  expect(source).toMatch(/fs\.mkdirSync\(resolved, \{ recursive: true, mode: 0o700 \}\)/);
  expect(source).toMatch(/fs\.statSync\(resolved\)\.isDirectory\(\)/);
});

it("keeps package smoke away from shared credentials, CUA, and updater state by default", () => {
  expect(source).toContain('const SMOKE_TEST = process.env.OMB_SMOKE_TEST === "1";');
  expect(source).toContain('const SMOKE_CUA = SMOKE_TEST && process.env.OMB_SMOKE_CUA === "1";');
  expect(source).toContain(
    'SMOKE_CUA && process.env.OMB_SMOKE_LINUX_CUA_BLOCKED !== "1"',
  );
  expect(source).toContain('const SMOKE_BUNDLED_CUA = SMOKE_TEST && process.env.OMB_SMOKE_BUNDLED_CUA === "1";');
  expect(source).toContain('const SMOKE_HARD_DEATH_CUA = SMOKE_TEST && process.env.OMB_SMOKE_HARD_DEATH === "1";');
  expect(source).toContain("if (app.isPackaged && !SMOKE_TEST)");
  expect(source).toContain("(!SMOKE_TEST || SMOKE_CUA || SMOKE_BUNDLED_CUA || SMOKE_HARD_DEATH_CUA)");
  expect(source).toContain("if (!SMOKE_TEST) startUpdater(win)");
});

it("packages acceptance builds under a non-production macOS identity", () => {
  expect(packageJson.scripts["package:mac:dev"]).toContain(
    "--config electron-builder.dev.yml --mac dir --arm64",
  );
  expect(devBuilderConfig).toContain("extends: ./electron-builder.yml");
  expect(devBuilderConfig).toContain("appId: com.openmausbot.app.full-task-dev");
  expect(devBuilderConfig).toContain("productName: OpenMausBot Full Task Dev");
  expect(devBuilderConfig).toContain("output: release-dev");
  expect(devBuilderConfig).not.toMatch(/^appId: com\.openmausbot\.app$/m);
  expect(devBuilderConfig).not.toMatch(/^productName: OpenMausBot$/m);
});
