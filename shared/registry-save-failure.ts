const HELD_OR_READ_ONLY = new Set(["EPERM", "EACCES", "EBUSY", "EROFS"]);

export type RegistryFile = "bots.json" | "groups.json";

export function registrySaveFailure(action: string, file: RegistryFile, code: unknown): string {
  const reason = typeof code === "string" && HELD_OR_READ_ONLY.has(code)
    ? `another program is holding OpenMausBot's ${file}, or its folder is read-only`
    : `OpenMausBot couldn't write ${file}`;
  return `Couldn't save ${action}: ${reason}.`;
}
