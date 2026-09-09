// The connector guardian as a process: `node managed-companion-guardian-main.mjs
// <cloudflared> <tokenFile> <socketPath> <pid> <originPort>`. Spawned by
// managed-companion-tunnel.mjs (desktop) and, bundled as
// dist-server/tunnel-guardian.js, by `openmausbot serve --tunnel`. Runs
// unconditionally: nothing imports this file, and the library it wraps has
// no side effects, so a bundle that inlines the library stays inert.
import { guardianArguments, runManagedCompanionGuardian } from "./managed-companion-guardian.mjs";

runManagedCompanionGuardian(guardianArguments(process.argv.slice(2))).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
