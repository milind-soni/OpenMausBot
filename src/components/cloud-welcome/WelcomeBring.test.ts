import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WelcomeBring } from "./WelcomeBring";

const bring = (team: boolean) => renderToStaticMarkup(createElement(WelcomeBring, { name: "Acme", desktop: true, cloudHasWork: false, team,
  headingRef: { current: null }, onTeam: () => {}, onFinish: () => {} }));

describe("the first setup step's promise", () => {
  it("on a Team Cloud, never says the bots on this computer come here by themselves", () => {
    const html = bring(true);
    expect(html).toContain("Acme is your team’s: a bot you make or bring here is yours until you share it, and your own bots stay where they are.");
    expect(html).not.toContain("come here by themselves");
  });

  it("on My Cloud, says it as before", () => {
    expect(bring(false)).toContain("Bots on your computer come here by themselves from the MausBot app.");
  });
});
