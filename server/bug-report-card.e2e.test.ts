// Nothing here reaches the OpenMausBot team's server, the user's data or port 8799: the desktop app sends reports,
// and this fixture only drafts and settles the card.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const asked = (turn: any): string => JSON.stringify(turn.prompt?.message?.content ?? "");

it("drafts a bug report card from a real turn, and runs the bot's next turn when the person sends it", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const url = fixture.info.url;
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Reporter" })).body.bot;
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "draft_bug_report", arguments: {
        summary: "Team tools did not connect",
        details: "coordinate_bots failed with ECONNREFUSED on every call. api_key=sk-live-1234567890abcdefXYZ was in the log.",
      } }], reply: "I drafted a bug report for you to review." },
      { reply: "Thanks, the report went to the OpenMausBot team." },
    ] } }));

    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Ask Scout to check the build.", "--url", url]);
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(1);
    const call = evidence()[0].evidence.find((entry: any) => entry.step?.tool === "draft_bug_report");
    expect(call.response.result.isError).toBeFalsy();
    expect(call.response.result.content[0].text).toContain("nothing is sent unless they press Send. Your turn ends now");

    const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as any[];
    await expect.poll(async () => (await messages()).some((message) => message.text === "I drafted a bug report for you to review."),
      { timeout: 15_000 }).toBe(true);
    const cards = (await messages()).filter((message) => message.kind === "bugreport");
    expect(cards).toHaveLength(1);
    expect(cards[0].from).toBeUndefined();
    expect(cards[0].bugReport.summary).toBe("Team tools did not connect");
    expect(cards[0].bugReport.details).toContain("coordinate_bots failed with ECONNREFUSED");
    expect(cards[0].bugReport.details).not.toContain("sk-live-1234567890abcdefXYZ");
    expect(cards[0].text).toBe("Reporter drafted a bug report for the OpenMausBot team: “Team tools did not connect”. Open this conversation in the OpenMausBot desktop app to review and send it.");
    expect((await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20", "--url", url]) as any).status).toBe("needs-user");

    expect(await api("POST", `/api/bots/${bot.id}/bug-report-cards/${cards[0].id}/sent`, { threadId: bot.threadId, reportId: "br_42" }))
      .toMatchObject({ status: 200, body: { sent: true, resumed: true } });
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(2);
    expect(asked(evidence()[1])).toContain("the person sent your bug report to the OpenMausBot team (report br_42)");
    await expect.poll(async () => (await messages()).some((message) => message.text === "Thanks, the report went to the OpenMausBot team."),
      { timeout: 15_000 }).toBe(true);
    expect((await messages()).find((message) => message.id === cards[0].id)?.bugReport).toMatchObject({ sent: true, reportId: "br_42", resumed: true });
    expect(await api("POST", `/api/bots/${bot.id}/bug-report-cards/${cards[0].id}/dismissed`, { threadId: bot.threadId }))
      .toMatchObject({ status: 409, body: { error: "this bug report draft was already sent" } });
  } finally {
    await fixture.close();
  }
}, 90_000);
