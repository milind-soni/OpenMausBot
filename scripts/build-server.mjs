import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(root, ".server-build-"));
const output = join(root, "dist-server");

try {
  execFileSync(process.execPath, [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p", "tsconfig.server.build.json",
    "--outDir", temporary,
  ], { cwd: root, stdio: "inherit" });
  // The build is complete. Replace the generated tree to drop obsolete modules
  // before the packager copies it into the app.
  rmSync(output, { recursive: true, force: true });
  renameSync(temporary, output);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
