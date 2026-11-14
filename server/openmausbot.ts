import { main } from "./cli.ts";
import { endQuietlyOnClosedPipe, exitAfterFlush } from "./exit.ts";
// The sentinel, run from here, reads the server's own lines back in every language it writes them in.
import "./server-line-packs.ts";

endQuietlyOnClosedPipe();
main().then(exitAfterFlush, (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  exitAfterFlush(1);
});
