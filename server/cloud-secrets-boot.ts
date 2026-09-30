// The server's first import (server/index.ts): on an OMB Cloud home, the
// secrets the launcher hands over its pipe are read, and the pipe closed,
// before any other module is loaded, so no process the server starts can
// inherit it (cloud-secrets.ts, cloud-home-start.ts).
import { takeCloudSecrets } from "./cloud-secrets.ts";

export const BOOT_CLOUD_SECRETS: Readonly<Record<string, string>> = takeCloudSecrets();
