/**
 * Writes shared/settings-places.ts, the real places in Settings that bots cite, from Settings' own index and the English
 * catalog. Run with `node --experimental-strip-types scripts/gen-settings-places.ts`.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import en from "../src/locales/en.json" with { type: "json" };
import { settingsPlacesFile } from "../src/components/settings/settings-places.ts";

writeFileSync(fileURLToPath(new URL("../shared/settings-places.ts", import.meta.url)), settingsPlacesFile(en));
