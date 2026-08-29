import { homedir } from "node:os";
import { join } from "node:path";

process.env.OMB_PRODUCT_ID = "centipede-v3";
process.env.OMB_PORT ??= "18899";
process.env.OMB_WEBHOOK_PORT ??= "18900";
process.env.OMB_DATA_DIR ??= join(homedir(), ".centipede-v3");
await import("./index.ts");
