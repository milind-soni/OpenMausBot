// MCP server (Streamable HTTP, stateless) that gives the MausBot bots the desk's tools. Server name: deskats.
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { DeskError, type Desk } from "./desk.ts";
import { DEMO_TOOL_SCHEMAS, TOOL_SCHEMAS, type DemoToolName, type ToolName } from "./schemas.ts";
import type { Sim } from "./sim.ts";
import type { Store } from "./store.ts";

export interface DemoControls {
  sim: Sim;
  store: Store;
}

const DEMO_DESCRIPTIONS: Record<DemoToolName, string> = {
  demo_new_requirement: "Demo control: a new client requirement email arrives in the ATS. The ATS then wakes the Desk Manager with it on its own, so after calling this, tell the person it landed and end your turn." + " Pass actor = your exact bot name.",
  demo_next_morning: "Demo control: the next morning's updates arrive (client interview feedback, an accepted offer, month-end timesheets). The ATS wakes the Desk Manager with them; end your turn after calling this." + " Pass actor = your exact bot name.",
  demo_reset: "Demo control: reset the ATS to its starting state (no requirement, no emails). Only when the person asks to reset the demo." + " Pass actor = your exact bot name.",
};

function runDemo(name: DemoToolName, demo: DemoControls): unknown {
  if (name === "demo_new_requirement") {
    try {
      const email = demo.sim.deliverClientEmail();
      return { email_id: email.id, from: email.from, subject: email.subject, note: "The ATS wakes the Desk Manager with this email on its own. End your turn." };
    } catch (err) {
      if (err instanceof DeskError) throw new DeskError("A requirement is already in. Ask the person to say \"reset the demo\" to start over.");
      throw err;
    }
  }
  if (name === "demo_next_morning") {
    const emails = demo.sim.deliverMorningEvents();
    return { email_ids: emails.map((e) => e.id), note: "The ATS wakes the Desk Manager with these on its own. End your turn." };
  }
  demo.store.reset();
  return { ok: true, note: "The ATS is back to its starting state." };
}

const ACTOR = " Pass actor = your exact bot name.";

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  get_desk_overview: "List every open requirement with its client, rate, clock and how many candidates sit in each stage.",
  get_requirement: "Get one requirement in full (skills, rate, JD, clock) with its stage counts, time_to_submit (mm:ss once the first submission is sent, else null) and every submission with its status.",
  list_pipeline: "List the candidates on a requirement. Filter by stage; sort by keyword fit or your score; include_resume adds the first 1,500 characters of each resume.",
  search_candidates: 'Boolean search over the whole candidate database (title, skills, resume, location): terms, "quoted phrases", AND, OR, NOT, parentheses. With req_id, results are ranked by keyword fit for that requirement.',
  get_candidate: "Get a candidate's full profile with their pipeline entries, screens, paperwork, submissions, interviews (with ids), onboarding, timesheets and emails.",
  list_vendors: "List the C2C vendor partners on the desk's bench list.",
  list_inbox: "List inbound emails (client requirements, vendor replies, candidate replies, client feedback), newest first. Filter by req_id, kind or since_id.",
  get_email: "Read one email in full, including attachments.",
  list_outbox: "List emails the desk has sent, newest first. Filter by req_id.",
  wait_for_replies: "Wait for candidates to reply to a text screen (text_screen_reply) or an RTR (rtr_reply) you already sent. Blocks up to timeout_seconds.",
  create_requirement: "Turn a client requirement email into a structured requirement. Starts the time-to-submit clock at the email's arrival time. Calling it again for the same email returns the same requirement." + ACTOR,
  post_job: "Post a requirement's JD to the job boards (Dice, Monster, LinkedIn)." + ACTOR,
  add_candidates_to_requirement: "Add candidates (up to 300) to a requirement in the Sourced column. Candidates already on it are skipped." + ACTOR,
  send_vendor_mail: 'Mass-mail C2C vendors about a requirement (vendor ids or ["all"]). Replies arrive in the inbox as vendor_reply emails. Only one vendor mail per requirement.' + ACTOR,
  import_vendor_resumes: "Import the consultants from a vendor_reply email into the database and onto the requirement as Sourced." + ACTOR,
  score_candidates: "Record your match scores (0–100, with reasons) for up to 50 candidates on a requirement in one call. Scores of 80+ move Sourced candidates to Matched." + ACTOR,
  move_candidate_stage: "Move a candidate on a requirement to another stage, with an optional note. Submitted is reached only through send_submission." + ACTOR,
  send_candidate_message: "Message a candidate about a requirement: missed_call (ask them to call back), text_screen (screening questions; they reply by text), rtr (right-to-represent and rate confirmation), or general." + ACTOR,
  log_screen_result: "Log a screening result (voice call or text) with every answer and a pass/hold/fail verdict. A pass moves the candidate to Screened." + ACTOR,
  record_paperwork: "Record RTR, confirmed rate, NDA and work-authorization documents for a candidate. When complete, the candidate moves to RTR." + ACTOR,
  draft_submission: "Draft the client submission email for a candidate with complete paperwork. Resume and work-auth documents are attached automatically. Lists any missing required fields." + ACTOR,
  send_submission: "Send a drafted submission to the client. Only call this after the recruiter approved it; put their answer word for word in approval_quote. Stops the clock on the first submission." + ACTOR,
  schedule_interview: "Schedule an interview round (1–3) and send the invite to the candidate and the client." + ACTOR,
  log_interview_feedback: "Log the client's feedback on an interview round: advance, reject, or offer." + ACTOR,
  update_onboarding: "Start or update onboarding for a candidate with an accepted offer: W2 offer letter or C2C MSA, background check, laptop tracking, start date." + ACTOR,
  request_timesheet: "Ask an onboarded consultant for their timesheet for a month (YYYY-MM). Their hours come back as a timesheet_reply email." + ACTOR,
  record_timesheet: "Record a month's hours and status (submitted, approved, billed) for an onboarded consultant." + ACTOR,
};

function buildServer(desk: Desk, demo?: DemoControls): McpServer {
  const server = new McpServer({ name: "deskats", version: "1.0.0" });
  for (const name of Object.keys(TOOL_SCHEMAS) as ToolName[]) {
    server.registerTool(name, { description: TOOL_DESCRIPTIONS[name], inputSchema: TOOL_SCHEMAS[name] }, async (args: unknown) => {
      try {
        const result = await desk.run(name, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof DeskError) return { isError: true, content: [{ type: "text" as const, text: err.message }] };
        throw err;
      }
    });
  }
  if (demo) {
    for (const name of Object.keys(DEMO_TOOL_SCHEMAS) as DemoToolName[]) {
      server.registerTool(name, { description: DEMO_DESCRIPTIONS[name], inputSchema: DEMO_TOOL_SCHEMAS[name] }, async () => {
        try {
          return { content: [{ type: "text" as const, text: JSON.stringify(runDemo(name, demo)) }] };
        } catch (err) {
          if (err instanceof DeskError) return { isError: true, content: [{ type: "text" as const, text: err.message }] };
          throw err;
        }
      });
    }
  }
  return server;
}

export function mcpHandler(desk: Desk, demo?: DemoControls): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    const server = buildServer(desk, demo);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
