import { describe, expect, it } from "vitest";
import { readGrokFollowUp } from "./grok-follow-up.ts";

const read = (text: string) => readGrokFollowUp(text);

describe("Grok's ui.follow_up_behavior in config.toml", () => {
  it("reads basic and literal strings, bare and quoted keys, and comments after the value", () => {
    for (const line of [
      'follow_up_behavior = "steer"',
      "follow_up_behavior = 'steer'",
      '"follow_up_behavior" = "steer"',
      "'follow_up_behavior' = 'steer'",
      'follow_up_behavior = "steer" # while a turn runs',
      '  follow_up_behavior   =   "steer"  ',
    ]) {
      expect(read(`[ui]\n${line}\n`), line).toMatchObject({ present: true, value: "steer" });
    }
    expect(read('[ui]\nfollow_up_behavior = "queue"\n')).toMatchObject({ present: true, value: "queue" });
    expect(read("[ui]\nfollow_up_behavior = true\n")).toMatchObject({ present: true, value: undefined });
  });

  it("reads the key from a [ui] header with a comment or spaces, a dotted key, and an inline table", () => {
    expect(read('[ui] # display settings\nfollow_up_behavior = "steer"\n')).toMatchObject({ value: "steer" });
    expect(read('[ ui ]\nfollow_up_behavior = "steer"\n')).toMatchObject({ value: "steer" });
    expect(read('["ui"]\nfollow_up_behavior = "steer"\n')).toMatchObject({ value: "steer" });
    expect(read('ui.follow_up_behavior = "steer"\n')).toMatchObject({ present: true, value: "steer", uiElsewhere: true });
    expect(read('"ui"."follow_up_behavior" = \'steer\'\n')).toMatchObject({ present: true, value: "steer" });
    expect(read('ui = { screen_mode = "minimal", follow_up_behavior = "steer" }\n')).toMatchObject({ present: true, value: "steer", uiElsewhere: true });
  });

  it("ignores a key of the same name in any other table", () => {
    expect(read('[other]\nfollow_up_behavior = "steer"\n')).toMatchObject({ present: false });
    expect(read('[ui.sub]\nfollow_up_behavior = "steer"\n')).toMatchObject({ present: false });
    expect(read('[[marketplace.sources]]\nfollow_up_behavior = "steer"\n')).toMatchObject({ present: false });
    expect(read('[other]\nx = 1\n[ui]\nfollow_up_behavior = "queue"\n')).toMatchObject({ value: "queue" });
  });

  it("places an insertion point at the end of the [ui] header line", () => {
    const text = '[a]\nx = 1\n[ui] # display\nscreen_mode = "minimal"\n';
    expect(text.slice(read(text).insertAt!)).toBe('screen_mode = "minimal"\n');
    expect(read("[ui]").insertAt).toBe(4);
    expect(read("[ui]\r\nscreen_mode = 1\r\n").insertAt).toBe(6);
    expect(read("x = 1\n").insertAt).toBeUndefined();
  });

  it("counts any other definition of ui, so no [ui] table is added after it", () => {
    for (const text of ["ui = []\n", 'ui = "minimal"\n', "[[ui]]\nx = 1\n"]) {
      expect(read(text), text).toMatchObject({ uiElsewhere: true, present: false });
      expect(read(text).insertAt, text).toBeUndefined();
    }
  });

  it("steps over multi-line arrays and tables, and reports what it cannot place", () => {
    expect(read('args = [\n  "a",\n  "[ui]",\n]\n[ui]\nfollow_up_behavior = "steer"\n')).toMatchObject({ value: "steer", unclear: false });
    expect(read('args = [ # arguments\n  "a", # one\n]\n[ui]\nfollow_up_behavior = "queue"\n')).toMatchObject({ value: "queue", unclear: false });
    expect(read('args = ["a#b"]\n[ui]\nfollow_up_behavior = "steer" # on\n')).toMatchObject({ value: "steer" });
    expect(read('note = """\n[ui]\n"""\n')).toMatchObject({ unclear: true });
    expect(read("this is not toml\n")).toMatchObject({ unclear: true });
  });
});
