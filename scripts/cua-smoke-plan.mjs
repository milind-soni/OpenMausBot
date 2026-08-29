export function resolveCuaSmokePlan(platform) {
  if (platform === "win32") {
    return {
      prepareScript: "scripts/prepare-cua-win.mjs",
      smokeScript: "scripts/smoke-cua-win.mjs",
    };
  }
  if (platform === "darwin") {
    return {
      prepareScript: "scripts/prepare-cua.mjs",
      smokeScript: "scripts/smoke-cua.mjs",
    };
  }
  throw new Error(`unsupported CUA smoke platform: ${platform}`);
}
