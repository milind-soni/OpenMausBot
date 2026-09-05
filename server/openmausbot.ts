// Entry point for the `openmausbot` command (see cli.ts).
import { main } from "./cli.ts";

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
