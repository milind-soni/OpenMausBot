// Alias for `openmausbot pair`: docs and images reference dist-server/pair-cli.js.
import { main } from "./cli.ts";
import { endQuietlyOnClosedPipe, exitAfterFlush } from "./exit.ts";

endQuietlyOnClosedPipe();
main(["pair", ...process.argv.slice(2)]).then(exitAfterFlush, (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  exitAfterFlush(1);
});
