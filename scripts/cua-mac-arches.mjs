export const DEFAULT_MAC_ARCHES = ["arm64", "x64"];

/** Which darwin CUA trees to stage. electron-builder packages both arches
 *  unless the caller opts into a one-arch local stage. An empty override
 *  is never a silent no-op. */
export function resolveCuaMacArches(env = process.env) {
  const raw = env.OPENMAUSBOT_CUA_ARCHES;
  if (raw === undefined) return [...DEFAULT_MAC_ARCHES];
  const arches = raw.split(",").map((arch) => arch.trim()).filter(Boolean);
  if (arches.length === 0) {
    throw new Error(
      "OPENMAUSBOT_CUA_ARCHES is empty; omit the variable to stage arm64 and x64",
    );
  }
  if (env.OPENMAUSBOT_CUA_ARCHES_PARTIAL !== "1") {
    const missing = DEFAULT_MAC_ARCHES.filter((arch) => !arches.includes(arch));
    if (missing.length) {
      throw new Error(
        `OPENMAUSBOT_CUA_ARCHES omits ${missing.join(", ")} but electron-builder packages both arm64 and x64. Set OPENMAUSBOT_CUA_ARCHES_PARTIAL=1 for a one-arch local stage.`,
      );
    }
  }
  return arches;
}
