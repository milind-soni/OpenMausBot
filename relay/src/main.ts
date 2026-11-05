import { loadConfig } from "./config.ts";
import { jsonLogger } from "./log.ts";
import { startRelay } from "./server.ts";

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  process.stderr.write(`relay: ${(error as Error).message}\n`);
  process.exit(1);
}
const log = jsonLogger(config.node);
const relay = await startRelay(config, { log });

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), config.limits.shutdownMs).unref();
  relay
    .drain()
    .then(() => relay.close())
    .finally(() => {
      log({ ev: "stop" });
      process.exit(0);
    });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
