import { describe, expect, it } from "vitest";

import { appsFromCreator, type AppGrants } from "./inherited-apps.ts";

const ADA = "ada@acme.test";
const OFF = { composio: false, connectorTools: {}, mcpServers: [] };
const chief = {
  createdBy: ADA, visibility: { people: [ADA] },
  composio: true, connectorTools: { gmail: { tools: ["GMAIL_FETCH_EMAILS"] } }, connectorScopes: { apps: { gmail: "read" as const } }, mcpServers: ["notes"],
};
const grants = ({ composio, connectorTools, connectorScopes, mcpServers }: AppGrants) => ({ composio, connectorTools, connectorScopes, mcpServers });

describe("the connected apps a bot a Chief creates starts with", () => {
  it("are the Chief's own, level for level", () => {
    expect(appsFromCreator(chief, { createdBy: ADA, visibility: { people: [ADA] } })).toEqual(grants(chief));
    expect(appsFromCreator({ connectorScopes: { apps: { slack: "read" } } }, {})).toEqual({ connectorScopes: { apps: { slack: "read" } } });
    expect(appsFromCreator({}, {}), "a Chief on every app makes a bot on every app").toEqual({});
  });

  it("go only to a bot with the Chief's owner", () => {
    expect(appsFromCreator(chief, { createdBy: "cleo@acme.test", visibility: { people: [ADA] } })).toEqual(OFF);
    expect(appsFromCreator(chief, { reportsTo: "cleo@acme.test", createdBy: ADA, visibility: { people: [ADA] } })).toEqual(OFF);
    expect(appsFromCreator(chief, { visibility: { people: [ADA] } }), "nobody's bot from Ada's Chief").toEqual(OFF);
    expect(appsFromCreator({ ...chief, createdBy: undefined, visibility: undefined }, { createdBy: ADA }), "Ada's bot from nobody's Chief").toEqual(OFF);
    expect(appsFromCreator({ ...chief, createdBy: undefined, defaultBot: { person: ADA } }, { createdBy: ADA, visibility: { people: [ADA] } })).toEqual(grants(chief));
  });

  it("go only to a bot exactly the Chief's people see", () => {
    expect(appsFromCreator(chief, { createdBy: ADA }), "everyone").toEqual(OFF);
    expect(appsFromCreator(chief, { createdBy: ADA, visibility: "admins" })).toEqual(OFF);
    expect(appsFromCreator(chief, { createdBy: ADA, visibility: { people: [ADA, "cleo@acme.test"] } })).toEqual(OFF);
    expect(appsFromCreator({ ...chief, createdBy: undefined, visibility: "everyone" }, {})).toEqual(grants(chief));
  });
});
