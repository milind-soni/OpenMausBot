import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Every package the server loads at runtime through nativeRequire, which the bundle cannot include. */
function nativelyRequired() {
  const names = new Set();
  for (const file of readdirSync(join(root, "server"), { recursive: true })) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    for (const [, name] of readFileSync(join(root, "server", file), "utf8").matchAll(/nativeRequire\([^)]*\)\(\s*"([^"]+)"\s*\)/g)) names.add(name);
  }
  return [...names].sort();
}

describe("packaged native modules", () => {
  it("finds the Data engine, chart rendering and 1Password loads in the server", () => {
    expect(nativelyRequired()).toEqual(["@1password/sdk", "@duckdb/node-api", "@resvg/resvg-js"]);
  });

  it("declares every natively required package in the npm manifest at the app's exact pin", () => {
    const checkout = mkdtempSync(join(tmpdir(), "omb-npm-package-"));
    temporaryDirectories.push(checkout);
    const pins = Object.fromEntries(nativelyRequired().map((name, i) => [name, `9.9.${i}`]));
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ version: "0.0.1", dependencies: { ...pins, react: "19.0.0" } }));
    for (const file of ["dist-server/index.js", "dist-server/openmausbot.js", "dist/index.html", "LICENSE"]) {
      mkdirSync(join(checkout, file, ".."), { recursive: true });
      writeFileSync(join(checkout, file), "");
    }
    mkdirSync(join(checkout, "scripts"));
    copyFileSync(join(root, "scripts", "build-npm-package.mjs"), join(checkout, "scripts", "build-npm-package.mjs"));
    execFileSync(process.execPath, [join(checkout, "scripts", "build-npm-package.mjs")], { stdio: "pipe" });
    const manifest = JSON.parse(readFileSync(join(checkout, "release", "npm", "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual(pins);
  });

  it("stages the native tree in the Podman image where the server looks for it", () => {
    const text = readFileSync(join(root, "deploy", "podman", "Containerfile"), "utf8");
    expect(text.indexOf("RUN node scripts/prepare-duckdb.mjs")).toBeGreaterThan(text.indexOf("COPY . ."));
    expect(text).toMatch(/^COPY --from=build \S+ \/src\/dist-native\/duckdb\/linux-x64 \.\/duckdb$/m);
    expect(text).toMatch(/^WORKDIR \/app$/m);
    expect(text).toMatch(/\bOMB_DUCKDB_DIR=\/app\/duckdb\b/);
  });
});
