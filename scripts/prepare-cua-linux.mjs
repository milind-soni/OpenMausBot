import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageLinuxCua } from "./cua-linux-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await stageLinuxCua({
  rootDirectory: root,
  offline: process.argv.includes("--offline") || process.env.OPENMAUSBOT_CUA_OFFLINE === "1",
  archivePath: process.env.OPENMAUSBOT_CUA_ARCHIVE_PATH,
});

console.log(`Staged CUA Driver ${result.manifest.version} from ${result.source} at ${result.stageDirectory}`);
