import { join } from "node:path";

import { botBox, BOX_BROKER_PORT } from "../bot-box/box.ts";
import { openCredentialBroker } from "../bot-box/broker.ts";
import { DATA_DIR } from "../config.ts";

const broker = await openCredentialBroker({ socketPath: join(DATA_DIR, "mcp.sock") });
botBox.broker = () => ({ port: BOX_BROKER_PORT, mintForThread: broker.mintForThread, touchThread: broker.touchThread,
  revoke: broker.revoke, revokeThread: broker.revokeThread, lookup: broker.lookup });

await import("../index.ts");
