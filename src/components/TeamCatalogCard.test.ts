import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TeamCatalogEntry } from "@/lib/team-catalog";
import { TeamCatalogCard } from "./TeamCatalogCard";

const entry: TeamCatalogEntry = {
  slug: "launch-crew", name: "Launch Crew", summary: "Ships launches.", category: "Marketing",
  manifest: "teams/launch-crew/team.mausteam.json", readme: "teams/launch-crew/README.md", members: 2, skills: [], requires: { apps: [] },
};
const shown = (author?: string) => renderToStaticMarkup(createElement(TeamCatalogCard, { entry: { ...entry, ...(author === undefined ? {} : { author }) }, busy: false, disabled: false, onAdd: () => {} }));

describe("a community template's card", () => {
  it("says who published it, and names nobody for a placeholder credit", () => {
    expect(shown("Jane Doe")).toContain("Published by Jane Doe");
    for (const nobody of [undefined, "Community", "MausBot user"]) expect(shown(nobody)).not.toContain("Published by");
  });
});
