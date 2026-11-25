import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { request } from "../../scripts/mcp-server.ts";
import { readHandoffs } from "./handoff-rows.ts";

/** A fixture turn's launch instructions plus its own message, where changed parts arrive when the process was kept warm. */
export const told = (turn: any): string => {
  const content = turn.prompt?.message?.content;
  return `${turn.system}\n${typeof content === "string" ? content : JSON.stringify(content ?? "")}`;
};

/** With OMB_TEST_DESKTOP_OWNER_TOKEN it runs as the desktop app runs it, every change carrying the app's owner capability. */
export async function fixture(test: (f: any) => Promise<void>, fakeEnv: NodeJS.ProcessEnv = {}) {
  const desktopOwner = fakeEnv.OMB_TEST_DESKTOP_OWNER_TOKEN;
  const realFetch = globalThis.fetch;
  if (desktopOwner) globalThis.fetch = (input, init = {}) => realFetch(input, { ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), "x-openmausbot-desktop-owner": desktopOwner } });
  try { await fixtureSession(test, fakeEnv); } finally { globalThis.fetch = realFetch; }
}

async function fixtureSession(test: (f: any) => Promise<void>, fakeEnv: NodeJS.ProcessEnv) {
  const session = await launchVerificationServer({ ...process.env, ...fakeEnv }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Leadership")).bot;
    const lead = (await cli("new-bot", "--name", "Engineering lead", "--section", "Engineering")).bot;
    const specialist = (await cli("new-bot", "--name", "Reviewer", "--section", "Engineering")).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
    const planPath = join(session.info.dataDir, "room-plan.json");
    const plan: Record<string, any> = {
      [chief.id]: { steps: [{ arguments: { bot_ids: [lead.id], message: "Implement and independently verify the CSV export" } }], reply: "Assigned to Engineering", resumeReply: "The requested CSV export is implemented and verified" },
      [lead.id]: { steps: [{ arguments: { bot_ids: [specialist.id], message: "Independently verify the CSV export" } }], reply: "Sent for verification", resumeReply: "Implemented and reviewer confirmed checks" },
      [specialist.id]: { reply: "CSV boundary cases verified" },
    };
    const save = () => writeFileSync(planPath, JSON.stringify(plan));
    const nodes = () => readHandoffs(session.info.dataDir);
    const eventsOf = (id: string): string[] => {
      const db = new DatabaseSync(join(session.info.dataDir, "runtime.db"), { readOnly: true });
      try {
        return (db.prepare("SELECT kind FROM assignment_events WHERE assignment_id = ? ORDER BY id").all(id) as Array<{ kind: string }>).map(row => row.kind);
      } finally { db.close(); }
    };
    const evidence = () => existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages;
    const start = async () => { save(); return cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Please have Engineering build and independently verify a CSV export. Own the result."); };
    const wait = () => cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "30");
    await test({ session, cli, api, chief, lead, specialist, plan, save, start, wait, nodes, eventsOf, evidence, messages });
  } finally { await session.close(); }
}

export const sendReceipts = (f: any, botId: string) => f.evidence().filter((turn: any) => turn.botId === botId)
  .flatMap((turn: any) => turn.evidence.filter((entry: any) => entry.step))
  .map((entry: any) => JSON.parse(entry.response.result.content[0].text).receipts[0]);
