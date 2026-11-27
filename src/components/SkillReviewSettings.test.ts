import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SkillReviewEngineNote } from "./SkillReviewSettings";

// renderToStaticMarkup HTML-escapes apostrophes; decode before comparing.
const render = (engines: string[]) => renderToStaticMarkup(createElement(SkillReviewEngineNote, { engines })).replace(/&#x27;/g, "'");

describe("SkillReviewEngineNote", () => {
  it("says plainly which engines' bots won't learn skills, under the switch", () => {
    const markup = render(["Pi", "Groq"]);
    expect(markup).toContain("Bots on Pi, Groq won't learn skills this way: their AI can't run the background review.");
    expect(markup).toContain('data-testid="skill-review-engine-note"');
  });

  it("renders nothing when every engine in use can run the review", () => {
    expect(render([])).toBe("");
  });
});
