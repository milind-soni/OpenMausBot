import { describe, expect, it } from "vitest";

import type { AdminActionRow } from "../admin-activity.ts";
import { VisibleSet, type Viewer } from "../bot-visibility.ts";
import type { DecisionRow } from "../decision-log.ts";
import type { RequestAuth } from "../request-auth.ts";
import { summarizeUsage, usageCsv, type UsageRow } from "../usage-ledger.ts";
import { createPrivateRecords } from "./private-records.ts";

const RUI = "rui@acme.test", ANA = "ana@acme.test";
const RUI_KEY = "p_ruiruiruiruiruiruirui1", ANA_KEY = "p_anaanaanaanaanaanaana1";
const bots = [
  { id: "quotes", threadId: "main", tasks: [{ threadId: "main" }, { threadId: "rui-chat" }, { threadId: "rui-run" }, { threadId: "ana-run" }] },
  { id: "ruis-maus", threadId: "rui-maus-chat", defaultBot: { person: RUI }, tasks: [{ threadId: "rui-maus-chat" }] },
];
const audienceOf = (threadId: string) =>
  threadId.startsWith("rui-") || threadId === "gone-chat" ? `member:${RUI_KEY}` as const : threadId.startsWith("ana-") ? `member:${ANA_KEY}` as const : threadId === "main" ? "team" as const : undefined;
const routines = [
  { id: "r-rui", botId: "quotes", name: "Salary check", resultsThreadId: "rui-chat" },
  { id: "r-ana", botId: "quotes", name: "Ana's digest", resultsThreadId: "ana-run" },
  { id: "r-team", botId: "quotes", name: "Standup", resultsThreadId: "main" },
];
const home = (routine: { resultsThreadId?: unknown }) => (routine.resultsThreadId === "rui-chat" ? RUI_KEY : routine.resultsThreadId === "ana-run" ? ANA_KEY : null);

function records(team = true) {
  const sets = new Map<string, VisibleSet>();
  return createPrivateRecords({
    visibleFor: (auth) => {
      const email = auth.kind === "session" ? auth.session.email ?? "" : "";
      const viewer: Viewer = { kind: "all", email };
      const person = email === RUI ? RUI_KEY : email === ANA ? ANA_KEY : null;
      if (!sets.has(email)) sets.set(email, new VisibleSet(bots, [], viewer, undefined, team ? { of: audienceOf, person, routineHome: home } : undefined));
      return sets.get(email)!;
    },
    botExists: (id) => bots.some((bot) => bot.id === id),
    routine: (id) => routines.find((routine) => routine.id === id),
  });
}
const admin = (email: string) => ({ kind: "session", scopes: ["admin", "client"], session: { id: `s-${email}`, email } }) as unknown as RequestAuth;
const row = (fields: Partial<UsageRow>): UsageRow => ({ at: "2026-11-10T10:00:00.000Z", botId: "quotes", botName: "Quotes", threadId: "main", instanceId: "claude", driverKind: "claudeAgent",
  model: "claude-sonnet-5", input: 10, output: 5, costUsd: 0.01, trigger: { kind: "user", email: RUI }, section: "Sales", ...fields });

const rows = [
  row({ threadId: "rui-chat", turnId: "turn-1", parent: { threadId: "rui-chat", turnId: "turn-0" } as UsageRow["parent"] }),
  row({ threadId: "rui-run", trigger: { kind: "routine", routineId: "r-rui", label: "Salary check", runId: "run-1", email: RUI } }),
  row({ threadId: "rui-maus-chat", botId: "ruis-maus", botName: "Confidant", section: "Rui's corner" }),
  row({ threadId: "gone-chat", botId: "left-maus", botName: "Old confidant" }),
  row({ threadId: "ana-run", trigger: { kind: "routine", routineId: "r-ana", label: "Ana's digest", email: ANA } }),
  row({ threadId: "main", trigger: { kind: "routine", routineId: "r-team", label: "Standup" } }),
  row({ threadId: "rui-chat", trigger: { kind: "bot", botId: "ruis-maus", email: RUI } }),
];

describe("what an admin reads of other people's records on a Team Cloud", () => {
  it("usage keeps every amount and person and says nothing of what was private", () => {
    const seen = rows.map(records().usageRow(admin(ANA)));
    const told = JSON.stringify(seen) + usageCsv(seen) + JSON.stringify(summarizeUsage(seen, "routine")) + JSON.stringify(summarizeUsage(seen, "bot"));
    for (const secret of ["rui-chat", "rui-run", "rui-maus-chat", "gone-chat", "Salary check", "r-rui", "run-1", "ruis-maus", "Confidant", "left-maus", "Old confidant", "Rui's corner", "turn-1", "turn-0"]) {
      expect(told, secret).not.toContain(secret);
    }
    expect(seen.map((one) => [one.input, one.output, one.costUsd, one.at, one.model])).toEqual(rows.map((one) => [one.input, one.output, one.costUsd, one.at, one.model]));
    expect(summarizeUsage(seen, "user").groups.find((group) => group.key === `user:${RUI}`)?.turns, "all of Rui's turns are still his").toBe(5);
    expect(summarizeUsage(seen, "routine").groups.map((group) => [group.key, group.label, group.turns]).sort()).toEqual([
      ["manual", "Not from a routine", 4], ["routine:private", "Private routine", 1], ["routine:r-ana", "Ana's digest", 1], ["routine:r-team", "Standup", 1],
    ]);
    expect(summarizeUsage(seen, "bot").groups.map((group) => [group.key, group.label, group.turns]).sort()).toEqual([["bot:private", "Private bot", 2], ["bot:quotes", "Quotes", 5]]);
    expect(usageCsv(seen).split("\n")[2]).toBe(`2026-11-10T10:00:00.000Z,Quotes,claude-sonnet-5,claudeAgent,Private routine,10,5,0,0.01,reported,,Sales,${RUI}`);
    expect(seen[5], "a shared routine's row is untouched").toBe(rows[5]);
  });

  it("the person themself reads their own rows whole, and everyone does off a team", () => {
    const own = rows.map(records().usageRow(admin(RUI)));
    expect(own.slice(0, 3)).toEqual(rows.slice(0, 3));
    expect(JSON.stringify(own[4]), "but not another person's private routine").not.toContain("Ana's digest");
    expect(rows.map(records(false).usageRow(admin(ANA)))).toEqual(rows);
  });

  it("a decision in someone's private chat keeps when, tool and outcome, and names their own MausBot to nobody", () => {
    const decision = (fields: Partial<DecisionRow>): DecisionRow => ({ at: "2026-11-10T10:00:00.000Z", threadId: "rui-chat", botId: "quotes", botName: "Quotes", tool: "Bash",
      summary: "rm -rf salary.xlsx", summaryCode: "notice.ran", summaryParams: { file: "salary.xlsx" }, rule: "rm .*", requestId: "req-1", decision: "allowed", source: "user", ...fields } as DecisionRow);
    const read = records().decisionRow(admin(ANA));
    expect(read(decision({}))).toEqual({ at: "2026-11-10T10:00:00.000Z", threadId: "", botId: "quotes", botName: "Quotes", tool: "Bash", decision: "allowed", source: "user" });
    expect(read(decision({ threadId: "rui-maus-chat", botId: "ruis-maus", botName: "Confidant" }))).toMatchObject({ threadId: "", botId: "private", botName: "Private bot" });
    expect(read(decision({ threadId: "gone-chat", botId: "left-maus", botName: "Old confidant" }))).toMatchObject({ botId: "private", botName: "Private bot" });
    const shared = decision({ threadId: "main" });
    expect(read(shared)).toBe(shared);
    const mine = decision({ threadId: "rui-maus-chat", botId: "ruis-maus", botName: "Confidant" });
    expect(records().decisionRow(admin(RUI))(mine)).toBe(mine);
  });

  it("an admin action on a person's own MausBot is listed to that person only", () => {
    const action = (id: string): AdminActionRow => ({ at: "2026-11-10T10:00:00.000Z", category: "bot", action: "bot.update", target: { kind: "bot", id, name: "Confidant" }, actor: { kind: "session" } as AdminActionRow["actor"] });
    expect([action("ruis-maus"), action("quotes"), action("deleted-team-bot")].map(records().adminActionShown(admin(ANA)))).toEqual([false, true, true]);
    expect(records().adminActionShown(admin(RUI))(action("ruis-maus"))).toBe(true);
    expect(records(false).adminActionShown(admin(ANA))(action("ruis-maus"))).toBe(true);
  });
});
