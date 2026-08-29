import { lstat } from "node:fs/promises";
import path from "node:path";

async function requireDirectory(directory) {
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`V3 package resource is not a directory: ${directory}`);
}

export default async function afterPack(context) {
  const resources = context.packager?.getResourcesDir?.(context.appOutDir) ?? path.join(context.appOutDir, "resources");
  await requireDirectory(path.join(resources, "ui"));
  await requireDirectory(path.join(resources, "server"));
  await requireDirectory(path.join(resources, "companion"));
}
