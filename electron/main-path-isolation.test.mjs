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
  expect(source).toContain('const SMOKE_BUNDLED_CUA = SMOKE_TEST && process.env.OMB_SMOKE_BUNDLED_CUA === "1";');
  expect(source).toContain('const SMOKE_HARD_DEATH_CUA = SMOKE_TEST && process.env.OMB_SMOKE_HARD_DEATH === "1";');
  expect(source).toContain("if (app.isPackaged && !SMOKE_TEST)");
  expect(source).toContain("(!SMOKE_TEST || SMOKE_CUA || SMOKE_BUNDLED_CUA || SMOKE_HARD_DEATH_CUA)");
  expect(source).toContain("if (!SMOKE_TEST) startUpdater(win)");
});

it("bootstraps graph approval authority over private utility-process IPC, never argv or env", () => {
  expect(source).toContain('OMB_AGENT_GRAPH_APPROVAL_IPC: "1"');
  expect(source).toContain('type: "openmaus.agent-graph-authority.v1"');
  expect(source).toContain("proc.postMessage({");
  expect(source).not.toMatch(/OMB_AGENT_GRAPH_APPROVAL_SECRET\s*:\s*AGENT_GRAPH_APPROVAL_SECRET/);
  expect(source).not.toMatch(/OMB_AGENT_GRAPH_APPROVAL_BOOT_ID\s*:\s*AGENT_GRAPH_APPROVAL_BOOT_ID/);
});

it("checks the trusted frame and server-owned graph manifest before any approval POST", () => {
  const handler = source.indexOf('ipcMain.handle("agent-graphs:mutate"');
  const mainFrame = source.indexOf("event.senderFrame !== event.sender.mainFrame", handler);
  const trustedOrigin = source.indexOf("new URL(event.senderFrame.url).origin !== rendererOrigin()", handler);
  const currentGraph = source.indexOf("const currentResponse = await fetch", handler);
  const semanticManifest = source.indexOf("graphApprovalDetail(currentPayload, id, graphHash)", handler);
  const dialog = source.indexOf("dialog.showMessageBox", handler);
  const approvalPost = source.indexOf("return signedAgentGraphRequest(action, path, body)", currentGraph + 1);
  for (const position of [handler, mainFrame, trustedOrigin, currentGraph, semanticManifest, dialog, approvalPost]) {
    expect(position).toBeGreaterThanOrEqual(0);
  }
  expect(mainFrame).toBeLessThan(trustedOrigin);
  expect(trustedOrigin).toBeLessThan(currentGraph);
  expect(currentGraph).toBeLessThan(semanticManifest);
  expect(semanticManifest).toBeLessThan(dialog);
  expect(dialog).toBeLessThan(approvalPost);
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
