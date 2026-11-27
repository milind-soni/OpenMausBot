// Loaded with --import by a test's real server: the disk has plenty of room, whatever this machine has left. A Cloud keeps
// 15% of its disk in reserve, so on a nearly full runner or laptop it would otherwise refuse the test's files.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

fs.statfsSync = () => ({ bsize: 4096, frsize: 4096, blocks: 2 ** 26, bfree: 2 ** 25, bavail: 2 ** 25, files: 2 ** 20, ffree: 2 ** 19, type: 0 });
syncBuiltinESMExports();
