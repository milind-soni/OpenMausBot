import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

type SavedBot = { id: string; approvalMode?: string; alwaysAllow?: string[]; toolScope?: { allow: string[] | null; deny: string[] } };

it("has a permission taken back through the settings route on disk when the route answers, with the server killed at once", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as { bot: { id: string } };
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data;
  };
  try {
    const others = [];
    for (const name of ["Crash one", "Crash two", "Crash three"]) others.push((await api("POST", "/api/bots", { name, useDefaults: false }, 201)).bot);
    const target = others[1]!;
    await api("PATCH", `/api/bots/${others[0]!.id}`, { title: "Warm" });
    await api("PATCH", `/api/bots/${target.id}`, { approvalMode: "ask", toolScope: { allow: [], deny: ["native:bash"] } });
    fixture.child.kill("SIGKILL");
    await waitForExit(fixture.child);
    const saved = (JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")) as SavedBot[]).find((bot) => bot.id === target.id)!;
    expect(saved.approvalMode).toBe("ask");
    expect(saved.toolScope).toEqual({ allow: [], deny: ["native:bash"] });
  } finally {
    await fixture.close();
  }
}, 60_000);
