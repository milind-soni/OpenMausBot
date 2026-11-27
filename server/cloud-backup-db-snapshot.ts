// A Cloud server's backup asks the running home for consistent copies of its databases before it packs the volume
// (cloud-backup-stage.ts): `docker exec -u maus omb-home timeout 1800 node /app/dist-server/cloud-backup-db-snapshot.js`.
// Prints each database it staged, one per line. Exit 0 whatever it staged (the backup packs only what the stage holds);
// 2 with no data folder named; 1 when it could not run (the backup then packs the live files, as before).
import { prepareBackupStage } from "./cloud-backup-stage.ts";

const dataDir = process.env.OMB_DATA_DIR;
if (!dataDir) {
  console.error("omb backup: OMB_DATA_DIR is not set; no database snapshots");
  process.exit(2);
}
try {
  const { staged } = await prepareBackupStage({ dataDir });
  if (staged.length) console.log(staged.join("\n"));
  console.error(`omb backup: ${staged.length ? `snapshotted ${staged.join(", ")}` : "no database snapshotted"}`);
  process.exit(0);
} catch (error) {
  console.error(`omb backup: no database snapshots: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
