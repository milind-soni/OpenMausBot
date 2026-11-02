// The app's language packs (src/locales/*.json) hold every screen's words, about 13 MB. The server reads only the lines
// it writes itself, the "server." keys (server/server-lines.ts), so the server's bundles carry only those.
import { readFileSync } from "node:fs";

export const SERVER_KEY_PREFIX = "server.";
const PACK = /[\\/]src[\\/]locales[\\/][a-z0-9-]+\.json$/;

/** The pack with only the server's own keys. */
export function serverLinesOnly(pack) {
  return Object.fromEntries(Object.entries(pack).filter(([key]) => key.startsWith(SERVER_KEY_PREFIX)));
}

export const serverLocalePlugin = {
  name: "server-locale",
  setup(build) {
    build.onLoad({ filter: PACK }, (args) => ({
      contents: JSON.stringify(serverLinesOnly(JSON.parse(readFileSync(args.path, "utf8")))),
      loader: "json",
    }));
  },
};
