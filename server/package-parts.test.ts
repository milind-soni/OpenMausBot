import { describe, expect, it } from "vitest";

import { createCustomMascotFitContext, suggestCustomMascotAnchor } from "../shared/custom-mascot-fitting.ts";
import { addOrSelectCustomMascot, createMascotProfile } from "../shared/mascot-profile.ts";
import { FACE_BOX } from "../shared/cursor-face-data.ts";
import type { PackageAgent } from "../shared/package-format.ts";
import { validateCustomMascotDefinition } from "./custom-mascot-validation.ts";
import { agentReleaseValues, mascotLookFields, partHash, releaseLook } from "./package-parts.ts";

function customProfile(name: string) {
  const outline = Array.from({ length: 48 }, (_, index) => {
    const angle = (index / 48) * Math.PI * 2;
    return [FACE_BOX / 2 + Math.cos(angle) * 60, FACE_BOX / 2 + Math.sin(angle) * 60] as const;
  });
  const anchor = suggestCustomMascotAnchor(createCustomMascotFitContext(outline));
  return addOrSelectCustomMascot(
    createMascotProfile(),
    validateCustomMascotDefinition({ name, outline, anchor }),
  );
}

describe("organization look stamps", () => {
  it("preserves omitted and explicit Cursor release encodings separately", () => {
    const legacyCursorLook = {
      color: "blue",
      mascotExpression: null,
      mascotBody: null,
      avatar: null,
      crop: null,
    };

    expect(releaseLook({ color: "blue" })).toEqual(legacyCursorLook);
    const explicitCursorLook = { ...legacyCursorLook, mascotBody: "cursor" };
    expect(releaseLook({ color: "blue", mascotBody: "cursor" })).toEqual(explicitCursorLook);
    expect(releaseLook({ color: "blue", mascotProfile: createMascotProfile() })).toEqual(explicitCursorLook);

    const writtenLook = { ...releaseLook({ color: "blue" }), ...mascotLookFields({ mascotProfile: createMascotProfile() }) };
    expect(partHash(writtenLook)).toBe(partHash(explicitCursorLook));
    expect(partHash(releaseLook({ color: "blue" }))).not.toBe(partHash(explicitCursorLook));

    const unchanged = { key: "lead", name: "Lead", title: "Before", appearance: { color: "blue" } } as PackageAgent;
    const first = agentReleaseValues(unchanged, new Map());
    const titleOnlyRelease = agentReleaseValues({ ...unchanged, title: "After" }, new Map());
    expect(partHash(titleOnlyRelease.look)).toBe(partHash(first.look));
    expect(partHash(titleOnlyRelease.title)).not.toBe(partHash(first.title));

    const explicit = { ...unchanged, appearance: { color: "blue", mascotBody: "cursor" } } as PackageAgent;
    expect(partHash(agentReleaseValues({ ...explicit, title: "After" }, new Map()).look)).toBe(partHash(explicitCursorLook));
  });

  it("stamps custom catalogs and non-default builtin selections", () => {
    const cursor = releaseLook({ color: "blue" });
    const cat = releaseLook({ color: "blue", mascotBody: "cat" });
    const custom = releaseLook({ color: "blue", mascotProfile: customProfile("Bunny") });
    const changed = releaseLook({ color: "blue", mascotProfile: customProfile("Different Bunny") });
    const customWithBuiltinSelected = mascotLookFields({ mascotProfile: { ...customProfile("Bunny"), selected: { kind: "builtin", bodyId: "star" } } });

    expect(cat.mascotBody).toBe("cat");
    expect(partHash(cat)).not.toBe(partHash(cursor));
    expect(custom.mascotBody).toBe("cursor");
    expect(custom.mascotProfile).toMatch(/^[a-f0-9]{64}$/);
    expect(custom.mascotProfile).not.toBe(changed.mascotProfile);
    expect(partHash(custom)).not.toBe(partHash(changed));
    expect(customWithBuiltinSelected.mascotBody).toBe("star");
    expect(mascotLookFields({ mascotProfile: createMascotProfile() })).not.toHaveProperty("mascotProfile");
  });
});
