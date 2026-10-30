import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHeldKeys } from "./cloud-held-keys.ts";
import { TRIAL_KEY_HELD } from "./trial-credit.ts";

const dirs: string[] = [];
const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), "omb-held-keys-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("a trial's moved AI keys", () => {
  it("are kept unused only while the Claude credit lasts, across a restart, and run once it is gone", () => {
    const dir = dataDir();
    let lasts = true;
    const held = createHeldKeys({ dataDir: dir, lasts: () => lasts });
    expect(held.refusal("openrouter")).toBeUndefined();
    expect(held.hold(["openrouter", "not an engine id"])).toBe(true);
    expect(held.refusal("openrouter")).toBe(TRIAL_KEY_HELD);
    expect(held.refusal("openai"), "only the engines a moved key runs").toBeUndefined();
    expect(createHeldKeys({ dataDir: dir, lasts: () => lasts }).refusal("openrouter"), "kept across a restart").toBe(TRIAL_KEY_HELD);
    lasts = false;
    expect(held.refusal("openrouter"), "the credit ran out: the key counts now").toBeUndefined();
  });

  it("are not held on a Cloud with no credit to keep", () => {
    const held = createHeldKeys({ dataDir: dataDir(), lasts: () => false });
    expect(held.hold(["openrouter"])).toBe(false);
    expect(held.refusal("openrouter")).toBeUndefined();
  });
});
