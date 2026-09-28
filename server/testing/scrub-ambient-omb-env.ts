// Side-effect import for suites that load modules snapshotting process.env.
//
// scripts/mcp-server.ts reads OPENMAUSBOT_URL / OMB_PORT into a module-scope
// const when it is evaluated, so deleting ambient values inside a test body is
// too late: the import above has already captured them (#1676). ESM evaluates
// static imports in statement order, so importing this module first scrubs the
// environment before the snapshot is taken. Import order is the contract —
// keep this line above any import of the module under test.
import { isAmbientOmbKey } from "./omb-env.ts";

for (const key of Object.keys(process.env)) {
  if (isAmbientOmbKey(key)) delete process.env[key];
}
