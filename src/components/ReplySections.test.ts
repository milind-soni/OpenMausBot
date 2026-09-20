// The reader's half of the section convention: the lead is the message and
// the detail is one click away. Rendered statically here for the same reason
// the rest of the transcript is — what matters is that the fold exists, is
// labelled with what is behind it, and actually keeps the detail out of the
// DOM until it is asked for.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReplySections } from "./ReplySections";

const render = (text: string) => renderToStaticMarkup(createElement(ReplySections, { text }));

describe("ReplySections", () => {
  it("shows the lead and folds the detail behind a labelled row", () => {
    const html = render(
      "The redirect is fixed and the suite passes.\n\n## What changed\n\nI moved the query string.\n\n## Files\n\nauth.ts",
    );
    expect(html).toContain("The redirect is fixed and the suite passes.");
    expect(html).toContain("Show detail");
    // the row names what is behind it, so opening it is an informed choice
    expect(html).toContain("What changed · Files");
    expect(html).not.toContain("I moved the query string");
    expect(html).not.toContain("auth.ts");
  });

  it("renders an unstructured reply whole, with nothing to fold", () => {
    const text = "Tests pass.\n\n- one\n- two";
    const html = render(text);
    expect(html).toContain("Tests pass.");
    expect(html).toContain("one");
    expect(html).toContain("two");
    expect(html).not.toContain("Show detail");
  });

  // The reader's half of the stripping guarantee. A reply with no headings is
  // rendered whole, so the payload that `splitReply` removed has to be gone
  // from this branch as well — it used to render the raw prop, which still
  // carried it, and nothing here caught that.
  it("keeps a stripped tool payload out of the reply the reader sees", () => {
    const html = render(
      'Opening the Run dialog for you.\n{ "action": "press", "keys": ["win", "r"] }\n\nFollow-up note.',
    );
    expect(html).toContain("Opening the Run dialog for you.");
    expect(html).toContain("Follow-up note.");
    expect(html).not.toContain("action");
  });

  it("still shows a reply that was nothing but leak", () => {
    // it is the only thing the message has; the voice is the half that stays
    // silent about it
    const html = render('We need to output tool use calls.\n{ "action": "press", "keys": ["win", "r"] }');
    expect(html).toContain("action");
  });

  it("keeps the lead's own heading as a label for a reply that opens with one", () => {
    const html = render("## Summary\n\nI fixed the redirect.\n\n## Detail\n\nThe query string.");
    expect(html).toContain("Summary");
    expect(html).toContain("I fixed the redirect.");
    expect(html).toContain("Show detail");
    expect(html).not.toContain("The query string.");
  });

  it("renders a reply that is only a lead with no fold row", () => {
    const html = render("## Notes\n\nEverything is fine.");
    expect(html).toContain("Everything is fine.");
    expect(html).not.toContain("Show detail");
  });

  it("carries mentions into both halves", () => {
    const html = renderToStaticMarkup(createElement(ReplySections, {
      text: "@Atlas fixed it.\n\n## Detail\n\n@Atlas also updated the suite.",
      mentionPeers: [{ name: "Atlas", color: "blue" }],
    }));
    // the lead's mention is decorated without the folded half being rendered
    expect(html).toContain('class="mention-highlight"');
    expect(html).toContain("@Atlas</span> fixed it.");
    expect(html).not.toContain("also updated the suite");
  });
});
