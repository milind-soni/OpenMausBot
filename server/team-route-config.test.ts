import { describe, expect, it } from "vitest";
import { teamRouteSettingsForTurn } from "./team-route-config.ts";

const validEnv = {
  JACK_CONTROL_PLANE_TEAM_ROUTE_ENABLED: "1",
  JACK_CONTROL_PLANE_TEAM_ROUTE_ENDPOINT: "https://jack.tailnet.example/v1/team-route/suggest",
  JACK_CONTROL_PLANE_MAUSBOT_TOKEN: "scoped-secret",
};

describe("Jack Control Plane team-route environment gate", () => {
  it("returns the scoped endpoint and token only for an eligible Chief turn", () => {
    expect(teamRouteSettingsForTurn(true, validEnv)).toEqual({
      endpoint: "https://jack.tailnet.example/v1/team-route/suggest",
      token: "scoped-secret",
    });
  });

  it.each([
    [false, validEnv],
    [true, { ...validEnv, JACK_CONTROL_PLANE_TEAM_ROUTE_ENABLED: "0" }],
    [true, { ...validEnv, JACK_CONTROL_PLANE_TEAM_ROUTE_ENDPOINT: "http://jack.tailnet.example/v1/team-route/suggest" }],
    [true, { ...validEnv, JACK_CONTROL_PLANE_TEAM_ROUTE_ENDPOINT: "https://user:pass@jack.tailnet.example/v1/team-route/suggest" }],
    [true, { ...validEnv, JACK_CONTROL_PLANE_TEAM_ROUTE_ENDPOINT: "https://jack.tailnet.example/other" }],
    [true, { ...validEnv, JACK_CONTROL_PLANE_MAUSBOT_TOKEN: "" }],
  ])("keeps the integration unavailable for an unapproved configuration", (eligible, env) => {
    expect(teamRouteSettingsForTurn(eligible, env)).toBeUndefined();
  });
});
