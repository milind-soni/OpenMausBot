import { describe, expect, it } from "vitest";

import {
  cleanReleaseLine, DEFAULT_SECTION, MAX_RELEASES, parseRelease, parseReleaseFeed, releaseFromMarkdown, releaseLeads, releaseLineParts, type ReleaseEntry,
} from "./release-notes.ts";

const NOTES = `## What's new in 0.1.175

### A calmer look
- **A new conversation starts when you send.** New conversation, a bot's \`+\` and Cmd/Ctrl+Shift+N open a blank chat.
- **Mascots hold still at rest,** with eased blinks and hover gaze.

### Bots and AIs
- **Pi bots no longer read your own \`~/.pi\` instructions.** They share only your login.
- Faster settings saves (#6801) by @someone in https://github.com/milind-soni/OpenMausBot/pull/6801
- Thanks to @someone and @other for the fixes.

### Fixes
- Many smaller fixes, among them:
  - Japanese input underlines;
  - file names with \`#\` or \`%\`.
- Faster app start-up.



**npm:** \`npx openmausbot@0.1.175\` · https://www.npmjs.com/package/openmausbot/v/0.1.175
`;

const entry = (sections: ReleaseEntry["sections"], version = "0.1.175"): ReleaseEntry => ({ version, date: "2026-11-21T05:17:00Z", sections });

describe("release notes Markdown to an entry", () => {
  it("keeps the sections and lines, folds nested lines into theirs, and leaves out credits and the npm line", () => {
    const release = releaseFromMarkdown(NOTES, { version: "0.1.175", date: "2026-11-21T05:17:00Z" });
    expect(release).toEqual(entry([
      { title: "A calmer look", items: [
        "**A new conversation starts when you send.** New conversation, a bot's `+` and Cmd/Ctrl+Shift+N open a blank chat.",
        "**Mascots hold still at rest,** with eased blinks and hover gaze.",
      ] },
      { title: "Bots and AIs", items: ["**Pi bots no longer read your own `~/.pi` instructions.** They share only your login."] },
      { title: "Fixes", items: ["Many smaller fixes, among them: Japanese input underlines; file names with `#` or `%`.", "Faster app start-up."] },
    ]));
    expect(parseRelease(release, { strict: true }).ok).toBe(true);
  });

  it("puts lines before any heading under a section of their own", () => {
    expect(releaseFromMarkdown("- One thing.\n- Another.", { version: "0.1.1", date: "2026-11-01T00:00:00Z" }).sections)
      .toEqual([{ title: DEFAULT_SECTION, items: ["One thing.", "Another."] }]);
  });

  it("drops HTML, links, pictures, script addresses and stray marks from hostile notes, and never lets markup through", () => {
    const hostile = [
      "### <img src=x onerror=alert(1)>Fixes",
      "- **Bold** and <script>alert(1)</script>plain <b>words</b>",
      "- [Click me](javascript:alert(1)) now",
      "- A JavaScript:alert(1) address and a jAvAsCrIpT : void(0) one",
      "- ![tracker](https://evil.example/pixel.png) A picture",
      "- See https://evil.example/x and data or <a href=\"https://evil.example\">this</a>",
      "- <scr<script>ipt>alert(1)</scr</script>ipt> nested",
      "- *single* _under_ ~~struck~~ **unpaired",
      "- `<script>` in code is only words",
      "- <iframe src=//evil.example></iframe>",
    ].join("\n");
    const release = releaseFromMarkdown(hostile, { version: "0.1.2", date: "2026-11-01T00:00:00Z" });
    expect(release.sections[0]!.title).toBe("Fixes");
    expect(release.sections[0]!.items).toEqual([
      "**Bold** and alert(1)plain words",
      "Click me now",
      "A address and a void(0) one",
      "A picture",
      "See and data or this",
      "alert(1) nested",
      "single under struck unpaired",
      "`<script>` in code is only words",
    ]);
    for (const item of release.sections[0]!.items) {
      const words = releaseLineParts(item).filter((part) => !part.code).map((part) => part.text).join("");
      expect(words).not.toMatch(/[<>]|javascript|:\/\//i);
    }
    expect(parseRelease(release, { strict: true }).ok).toBe(true);
  });

  it("replaces every control or direction character, not only the first", () => {
    expect(cleanReleaseLine("a\u202eb\u202ec\u200bd")).toBe("a b c d");
  });

  it("tidies spacing in the prose only, never inside code", () => {
    expect(cleanReleaseLine("Run  `a  b .c`  now .")).toBe("Run `a  b .c` now.");
  });

  it("each cleaned line is already clean", () => {
    for (const line of ["**A.** b `c` d", "Plain.", "x <b>y</b> [z](https://a.b)"]) expect(cleanReleaseLine(cleanReleaseLine(line))).toBe(cleanReleaseLine(line));
  });

  it("leads: the bold words a line opens with, else its first sentence, as plain sentences", () => {
    expect(releaseLeads(entry([{ title: "A", items: ["**Mascots hold still at rest,** with blinks.", "**Pi reads `~/.pi`** no more."] }]))).toEqual([
      "Mascots hold still at rest.", "Pi reads ~/.pi.",
    ]);
    expect(releaseLeads(entry([{ title: "A", items: ["Paste a link and a bot joins. It names itself.", "One."] }, { title: "B", items: ["Two!"] }]))).toEqual([
      "Paste a link and a bot joins.", "One.",
    ]);
  });
});

describe("drawing a line", () => {
  it("splits bold and code, code inside bold included, and leaves an unpaired mark as it is", () => {
    expect(releaseLineParts("**Pi reads `~/.pi`** no more, `x`.")).toEqual([
      { text: "Pi reads ", bold: true, code: false }, { text: "~/.pi", bold: true, code: true }, { text: " no more, ", bold: false, code: false },
      { text: "x", bold: false, code: true }, { text: ".", bold: false, code: false },
    ]);
    expect(releaseLineParts("2 ** 3 is `**` here")).toEqual([
      { text: "2 ** 3 is ", bold: false, code: false }, { text: "**", bold: false, code: true }, { text: " here", bold: false, code: false },
    ]);
  });
});

describe("the releases file", () => {
  const release = (version: string, extra: Record<string, unknown> = {}) => ({ ...entry([{ title: "Fixes", items: ["Faster."] }], version), ...extra });
  const feed = (releases: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, updatedAt: "2026-11-21T00:00:00Z", releases, ...extra });
  const NOW = Date.parse("2026-11-21T10:00:00Z");

  it("reads a sound file, newest first", () => {
    const parsed = parseReleaseFeed(feed([release("0.1.175"), release("0.1.173")]), { strict: true, nowMs: NOW });
    expect(parsed.ok && parsed.feed.releases.map((entry) => entry.version)).toEqual(["0.1.175", "0.1.173"]);
  });

  it("strictly, refuses a line with markup or a link, an unknown field, a repeat, the wrong order, and too many releases", () => {
    const refused = (value: unknown) => {
      const parsed = parseReleaseFeed(value, { strict: true, nowMs: NOW });
      return parsed.ok ? null : parsed.error;
    };
    expect(refused(feed([release("0.1.1", { sections: [{ title: "A", items: ["<b>x</b>"] }] })]))).toMatch(/tags/);
    expect(refused(feed([release("0.1.1", { sections: [{ title: "A", items: ["[x](https://a.b)"] }] })]))).toMatch(/links/);
    expect(refused(feed([release("0.1.1", { sections: [{ title: "A", items: ["see javascript:alert(1)"] }] })]))).toMatch(/links/);
    expect(refused(feed([release("0.1.1", { sections: [{ title: "A", items: ["x‮y"] }] })]))).toMatch(/control/);
    expect(refused(feed([release("0.1.1", { notes: "html" })]))).toMatch(/releases\.0/);
    expect(refused(feed([release("0.1.1"), release("0.1.1")]))).toMatch(/twice/);
    expect(refused(feed([release("0.1.1"), release("0.1.2")]))).toMatch(/newest first/);
    expect(refused(feed(Array.from({ length: MAX_RELEASES + 1 }, (_, index) => release(`0.1.${100 - index}`))))).toMatch(/releases/);
    expect(refused(feed([], { updatedAt: "2026-12-30T00:00:00Z" }))).toMatch(/future/);
    expect(refused({ version: 2, updatedAt: "2026-11-21T00:00:00Z", releases: [] })).toMatch(/version/);
  });

  it("leniently, as an install reads it, skips a bad release, keeps the rest in order and drops unknown fields", () => {
    const parsed = parseReleaseFeed(feed([release("0.1.1"), release("0.1.3", { sections: [] }), release("0.1.2", { extra: true })]), { nowMs: NOW });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.feed.releases.map((entry) => entry.version)).toEqual(["0.1.2", "0.1.1"]);
    expect(parsed.feed.releases[0]).not.toHaveProperty("extra");
    expect(parsed.skipped).toEqual([expect.stringMatching(/^releases\.1/)]);
  });
});
