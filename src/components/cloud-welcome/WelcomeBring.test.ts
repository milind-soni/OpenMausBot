import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WelcomeBring } from "./WelcomeBring";

const bring = (team: boolean) => renderToStaticMarkup(createElement(WelcomeBring, { name: "Acme", desktop: true, cloudHasWork: false, team,
  headingRef: { current: null }, onTeam: () => {}, onFinish: () => {} }));

describe("an empty Cloud opened in a browser", () => {
  const inBrowser = (team: boolean) => renderToStaticMarkup(createElement(WelcomeBring, { name: "Acme", desktop: false, cloudHasWork: false, team,
    headingRef: { current: null }, onTeam: () => {}, onFinish: () => {} }));

  it("on a Team Cloud, starts fresh and points at no desktop app to bring a person's own bots", () => {
    const html = inBrowser(true);
    expect(html).toContain('data-bring-choice="fresh"');
    expect(html).not.toContain("data-bring-desktop");
    expect(html).not.toContain("Your bots are already here");
  });

  it("on My Cloud, still says the desktop app brings everything", () => {
    expect(inBrowser(false)).toContain("Open the desktop app to bring your bots from your computer.");
  });
});

describe("the first setup step's promise", () => {
  it("on a Team Cloud, never says the bots on this computer come here by themselves", () => {
    const html = bring(true);
    expect(html).toContain("Acme is your team’s: its bots are shared with everyone in Acme, and your own bots stay where they are.");
    expect(html).not.toContain("come here by themselves");
  });

  it("on My Cloud, says it as before", () => {
    expect(bring(false)).toContain("Bots on your computer come here by themselves from the MausBot app.");
  });
});
