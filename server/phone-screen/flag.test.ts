import { afterEach, describe, expect, it } from "vitest";

import type { BundledSkill } from "../skill-library.ts";
import { endHoldUnlessOn, usbPhoneOffered, usbPhoneTakeoverEnabled } from "./flag.ts";
import { createPhoneHold, type PhoneHold } from "./hold.ts";

const skill = (defaultEnabled: boolean, ...requiredCapabilities: string[]) => ({ manifest: { defaultEnabled, requiredCapabilities } }) as unknown as BundledSkill;
const engine = (phoneMcp?: boolean) => ({ adapter: { capabilities: { phoneMcp } } });
const ON = { features: { usbPhoneTakeover: true } };

describe("usbPhoneTakeoverEnabled", () => {
  it.each([
    [{}, false],
    [{ features: {} }, false],
    [{ features: null }, false],
    [{ features: { usbPhoneTakeover: false } }, false],
    [{ features: { usbPhoneTakeover: "true" } }, false],
    [ON, true],
  ])("%j → %s", (cfg, on) => {
    expect(usbPhoneTakeoverEnabled(cfg)).toBe(on);
  });
});

describe("usbPhoneOffered", () => {
  it.each([
    ["an engine that mounts the phone and a default-on phone skill", engine(true), [skill(true, "phoneMcp")], true],
    ["an engine that cannot mount the phone", engine(), [skill(true, "phoneMcp")], false],
    ["a phone skill that is off by default", engine(true), [skill(false, "phoneMcp")], false],
    ["no phone skill", engine(true), [skill(true, "computerMcp")], false],
  ])("%s → %s", (_what, instance, skills, offered) => {
    expect(usbPhoneOffered(instance, skills)).toBe(offered);
  });
});

describe("a saved config while a person holds the phone and no stream is open", () => {
  let hold: PhoneHold;
  const heldUnwatched = () => {
    hold = createPhoneHold();
    hold.take();
    hold.watched(false);
    return hold;
  };
  afterEach(() => hold.stop());

  it.each([
    ["turns the feature off", { features: { usbPhoneTakeover: false, browser: true } }],
    ["has no features", {}],
  ])("ends the hold at once and answers a waiting claim when it %s; the phone is free when the feature is on again", async (_what, saved) => {
    const waiting = heldUnwatched().wait(new AbortController().signal, 45_000);

    endHoldUnlessOn(hold, saved);
    expect(hold.held).toBe(false);
    await expect(waiting).resolves.toBe("handed-back");

    endHoldUnlessOn(hold, ON);
    expect(hold.held).toBe(false);
  });

  it("keeps the hold when it leaves the feature on", () => {
    endHoldUnlessOn(heldUnwatched(), { features: { usbPhoneTakeover: true, browser: false } });
    expect(hold.held).toBe(true);
  });
});
