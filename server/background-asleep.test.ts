import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { asleepAnswer, BACKGROUND_HEADERS } from "../electron/cloud-power.mjs";
import { answerAsleep, backgroundWhileAsleep, registerCloudPower } from "./cloud-power.ts";

const power = (sleeping: boolean) => ({ sleeping: () => sleeping, sleepSignal: () => new AbortController().signal, sleptUntil: () => null }) as unknown as Parameters<typeof registerCloudPower>[0];

afterEach(() => registerCloudPower(null));

describe("a background read of the bots on a home that agreed to sleep", () => {
  it("is told the home sleeps, in the words the desktop app listens for", () => {
    registerCloudPower(power(true));
    expect(backgroundWhileAsleep("/api/bots", { ...BACKGROUND_HEADERS })).toBe(true);
    const headers = new Map<string, string>();
    let sent: { status: number; body: unknown } | null = null;
    const res = { setHeader: (name: string, value: string) => headers.set(name, value) } as unknown as ServerResponse;
    answerAsleep(res, (_res, status, body) => { sent = { status, body }; });
    expect(sent).toEqual({ status: 503, body: { error: "asleep" } });
    expect(asleepAnswer({ status: sent!.status, headers: { get: (name: string) => headers.get(name) ?? null } })).toBe(true);
  });

  it("leaves a person's own request, an awake home and a server that never sleeps alone", () => {
    registerCloudPower(power(true));
    expect(backgroundWhileAsleep("/api/bots", {})).toBe(false);
    registerCloudPower(power(false));
    expect(backgroundWhileAsleep("/api/bots", { ...BACKGROUND_HEADERS })).toBe(false);
    registerCloudPower(null);
    expect(backgroundWhileAsleep("/api/bots", { ...BACKGROUND_HEADERS })).toBe(false);
  });

  it("is answered before the bots are read", () => {
    const route = readFileSync(new URL("./routes/threads.ts", import.meta.url), "utf8");
    const list = route.slice(route.indexOf('if (method === "GET" && path === "/api/bots") {'));
    expect(list.indexOf("if (backgroundWhileAsleep(path, req.headers)) return answerAsleep(res, json);")).toBeLessThan(list.indexOf("store.bots"));
    expect(list.indexOf("if (backgroundWhileAsleep(path, req.headers)) return answerAsleep(res, json);")).toBeGreaterThan(0);
  });
});
