import path from "node:path";

/** `execArgv` travels with the entry: the TypeScript source without its strip-types flag is a SyntaxError at fork. */
export function resolveCompanionEntry({ isPackaged, resourcesPath, appPath, exists }) {
  const packaged = path.join(resourcesPath, "companion", "index.js");
  if (isPackaged) return exists(packaged) ? { entry: packaged, execArgv: [] } : null;
  const built = path.join(appPath, "dist-companion", "index.js");
  if (exists(built)) return { entry: built, execArgv: [] };
  const source = path.join(appPath, "companion", "src", "index.ts");
  if (exists(source)) return { entry: source, execArgv: ["--experimental-strip-types"] };
  return null;
}
