import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildExportScopeOptions } from "@/lib/team-files";
import { BotAvatar } from "./Avatar";
import { exportScopeAvatarProps } from "./TeamLibraryPanel";

describe("TeamLibrary export scope avatar presentation", () => {
  const bots = [
    { id: "ada", name: "Ada", color: "blue" as const, section: "Engineering" },
    { id: "bea", name: "Bea", color: "purple" as const, section: "Design" },
  ];

  it("uses a static BotAvatar for every existing individual option and falls back only for a missing id", () => {
    const options = buildExportScopeOptions({ projectFilter: "all", bots, groups: [] });
    const individual = options.filter((option) => option.category === "bot");

    expect(individual).toHaveLength(bots.length);
    for (const option of individual) {
      const props = exportScopeAvatarProps(option, bots);
      expect(props).toMatchObject({ bot: { id: option.botIds[0] }, state: "idle", size: 28, animated: false });
      const avatar = createElement(BotAvatar, props!);
      expect(avatar.type).toBe(BotAvatar);
      expect(avatar.props.animated).toBe(false);
      expect(renderToStaticMarkup(avatar)).toContain("<svg");
    }

    expect(exportScopeAvatarProps({
      key: "bot:missing",
      category: "bot",
      label: "Missing",
      detail: "Single bot",
      scope: { botIds: ["missing"], groupIds: [] },
      botIds: ["missing"],
    }, bots)).toBeUndefined();
  });
});
