import { describe, expect, it } from "vitest";
import { releaseHighlights } from "./release-highlights";

// The shape of this repository's releases (v0.1.102), as Markdown and as the
// HTML the GitHub update feed carries.
const markdown = `## New

- **Several Google accounts for Antigravity.** Add more than one Google account inside the Antigravity card. (#2502)
- **Accounts live in their provider cards.** "Add Claude account" now sits inside the Claude card. (#2492)

## Fixes you may have hit

- **Faster start.** After the first launch, the app opens without waiting. (#2482)
- **Chats:**
  - Switching threads scrolls to the newest message again. (#2462)
- **Mentions say who they reach.** In the @ list, each bot shows its title. (#2457)`;

const html = `<h2>New</h2>
<ul>
<li><strong>Several Google accounts for Antigravity.</strong> Add more than one Google account. (<a href="https://github.com/x/y/pull/2502">#2502</a>)</li>
<li><strong>Chats:</strong>
<ul><li>Switching threads scrolls to the newest message again. (#2462)</li></ul>
</li>
<li>Errors in chats &amp; rooms show as a banner you can close. They stay until closed.</li>
</ul>`;

describe("releaseHighlights", () => {
  it("reads each item as its bold lead, skipping headings, group labels and references", () => {
    expect(releaseHighlights(markdown)).toEqual([
      "Several Google accounts for Antigravity.",
      "Accounts live in their provider cards.",
      "Faster start.",
      "Switching threads scrolls to the newest message again.",
    ]);
  });

  it("reads the HTML a GitHub feed carries the same way, an item without a lead as its first sentence", () => {
    expect(releaseHighlights(html)).toEqual([
      "Several Google accounts for Antigravity.",
      "Switching threads scrolls to the newest message again.",
      "Errors in chats & rooms show as a banner you can close.",
    ]);
  });

  it("stops at the limit and has nothing to say for empty or bullet-less notes", () => {
    expect(releaseHighlights(markdown, 2)).toHaveLength(2);
    expect(releaseHighlights(undefined)).toEqual([]);
    expect(releaseHighlights("   ")).toEqual([]);
    expect(releaseHighlights("Bug fixes and improvements.")).toEqual([]);
  });

  it("drops links to their label, author credits and long tails", () => {
    expect(releaseHighlights("* Fix [the loader](https://x.dev/a) by @someone in https://github.com/x/y/pull/1")).toEqual(["Fix the loader"]);
    const long = releaseHighlights(`- ${"word ".repeat(40)}`)[0]!;
    expect(long.length).toBeLessThanOrEqual(110);
    expect(long.endsWith("…")).toBe(true);
  });
});
