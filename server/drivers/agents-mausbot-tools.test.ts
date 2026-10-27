import { describe, expect, it } from "vitest";

import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";
import { MAUSBOT_TOOL_DEFINITIONS } from "./agents-mausbot-tools.ts";

const listed = (env: Record<string, string>) => availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "maus", OMB_CHIEF_OF_STAFF: "1", ...env }));

describe("MausBot's two notification tools on the wire", () => {
  const maus = listed({ OMB_MAUSBOT: "1" }).slice(-2) as Array<{ name: string; inputSchema: Record<string, any> }>;

  it("are listed last, in this order, only with OMB_MAUSBOT", () => {
    expect(maus.map((tool) => tool.name)).toEqual(["list_unread_notifications", "mark_notifications_read"]);
    for (const env of [{}, { OMB_MAUSBOT: "0" }, { OMB_MAUSBOT: "true" }] as Array<Record<string, string>>) {
      expect(listed(env).map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["mark_notifications_read"]));
    }
  });

  it("keep flat, closed schemas with the required fields", () => {
    expect(maus.map((tool) => [tool.inputSchema.type, tool.inputSchema.additionalProperties, Object.keys(tool.inputSchema.properties), tool.inputSchema.required ?? []])).toEqual([
      ["object", false, [], []],
      ["object", false, ["ids"], ["ids"]],
    ]);
    expect(maus[1]!.inputSchema.properties.ids).toMatchObject({ type: "array", maxItems: 40, items: { type: "string" } });
    expect(JSON.stringify(MAUSBOT_TOOL_DEFINITIONS)).not.toMatch(/"(oneOf|anyOf|allOf|const|format)"/);
  });
});
