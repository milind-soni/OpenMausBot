import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("isolated Windows canary package identity", () => {
  it("cannot register the production protocol or collide with the installed app", () => {
    const config = parse(readFileSync(join(ROOT, "electron-builder.isolated-canary.yml"), "utf8"));
    expect(config.extends).toBeUndefined();
    expect(config.appId).toBe("com.openmausbot.isolated-canary");
    expect(config.productName).toBe("OpenMausBot Isolated Canary");
    expect(config.protocols).toBeUndefined();
    expect(config.publish).toEqual([]);
    expect(config.extraMetadata.version).toBe("0.1.40-autorag-canary.1");
    expect(config.directories.output).toBe("release-isolated-canary");
    expect(config.win.target).toEqual([{ target: "portable", arch: ["x64"] }]);
    expect(config.win.executableName).toBe("OpenMausBot-Isolated-Canary");
  });
});
