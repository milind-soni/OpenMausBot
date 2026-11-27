import { describe, expect, it, vi } from "vitest";

import { TEAM_LIBRARY_RAW_ROOT, type TeamCatalog } from "./team-library.ts";
import { withCatalogPictures } from "./team-library-pictures.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const catalogWith = (pictures: string[]): TeamCatalog => ({
  format: "openmaus.catalog", version: 1, repositoryUrl: "https://github.com/milind-soni/openmausbot-teams",
  teams: [{
    slug: "studio", name: "Studio", summary: "Pictures.", category: "Creative", manifest: "teams/studio/team.mausteam.json",
    readme: "teams/studio/README.md", members: pictures.length, skills: [], requires: { apps: [] },
    avatars: pictures.map((picture, index) => ({ key: `bot-${index}`, name: `Bot ${index}`, color: "cyan", picture })),
  }],
});

describe("the gallery's pictures", () => {
  it("hands each picture on as a data: URL, and leaves out one that isn't the picture its name says", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target === `${TEAM_LIBRARY_RAW_ROOT}/teams/studio/avatars/real.png`) return new Response(PNG);
      if (target === `${TEAM_LIBRARY_RAW_ROOT}/teams/studio/avatars/fake.png`) return new Response("<html>");
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const read = await withCatalogPictures(catalogWith(["teams/studio/avatars/real.png", "teams/studio/avatars/fake.png", "teams/studio/avatars/gone.png"]), fetcher);
    const [real, fake, gone] = read.teams[0]!.avatars!;
    expect(real!.picture).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    expect(fake!.picture).toBeUndefined();
    expect(gone!.picture).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
    // A picture read is kept; one that failed is tried again on the next load.
    await withCatalogPictures(catalogWith(["teams/studio/avatars/real.png", "teams/studio/avatars/gone.png"]), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
