import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { testingError } from "./preview-testing.ts";

/** Only writes generated PNGs, never caller-supplied names. Resolve the evidence directory after mkdir to reject symlink escapes. */
export function saveTestingScreenshot(base64: unknown, dataDir: string, projectPath?: string) {
  if (typeof base64 !== "string" || base64.length > 11_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw testingError("Invalid or oversized Preview screenshot.");
  const image = Buffer.from(base64, "base64");
  if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw testingError("Preview did not return a PNG.");
  const root = realpathSync(projectPath ?? dataDir);
  const folder = join(root, projectPath ? ".gbs-preview-evidence" : "preview-artifacts");
  mkdirSync(folder, { recursive: true });
  const actual = realpathSync(folder);
  const rel = relative(root, actual);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw testingError("Evidence directory must stay inside its project.", 403);
  const file = join(actual, `${randomUUID()}.png`);
  writeFileSync(file, image, { flag: "wx", mode: 0o600 });
  return { artifactPath: file, ephemeral: !projectPath, bytes: image.length };
}
