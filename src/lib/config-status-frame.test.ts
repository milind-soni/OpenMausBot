import { expect, it } from "vitest";
import { configStatusFromFrame, type ConfigStatusFrame } from "./config-status-frame";

const baseFrame: ConfigStatusFrame = {
  composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 10 }, localVm: { mode: "shared", maxInstances: 1 },
};

it("keeps person-paused bots and departments through a config broadcast", () => {
  const frame = { ...baseFrame, pausedByPerson: { bots: ["ada"], departments: ["Sales"] }, heldBots: ["ada", "bo"] };
  expect(configStatusFromFrame(frame)).toMatchObject({ pausedByPerson: frame.pausedByPerson, heldBots: frame.heldBots });
});

it("keeps empty pause lists after the person resumes the last bot or department", () => {
  const frame = { ...baseFrame, pausedByPerson: { bots: [], departments: [] }, heldBots: [] };
  expect(configStatusFromFrame(frame)).toMatchObject({ pausedByPerson: frame.pausedByPerson, heldBots: [] });
});

it("leaves older servers' missing pause fields absent and keeps plan pauses separate", () => {
  const config = configStatusFromFrame({ ...baseFrame, awakeLimit: 3, pausedBots: ["plan-limited"] });
  expect(config).not.toHaveProperty("pausedByPerson");
  expect(config).not.toHaveProperty("heldBots");
  expect(config).toMatchObject({ awakeLimit: 3, pausedBots: ["plan-limited"] });
});

it("keeps the server desktops' idle override through a config broadcast, and leaves it absent when unset", () => {
  expect(configStatusFromFrame({ ...baseFrame, vpsIdle: { timeoutMinutes: 60 } })).toMatchObject({ vpsIdle: { timeoutMinutes: 60 } });
  expect(configStatusFromFrame(baseFrame)).not.toHaveProperty("vpsIdle");
});
