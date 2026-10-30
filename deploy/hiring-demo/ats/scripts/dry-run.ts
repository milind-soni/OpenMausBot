// Plays the bots' happy path for REQ-1042 over MCP, no MausBot needed. Used to check the UI end to end and as a
// fallback demo. Usage: node scripts/dry-run.ts [--pause=1000] [--base=http://127.0.0.1:4100]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const BASE = args.base ?? "http://127.0.0.1:4100";
const PAUSE = Number(args.pause ?? 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const client = new Client({ name: "dry-run", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));

async function tool<T = any>(name: string, a: Record<string, unknown> = {}): Promise<T> {
  const res = (await client.callTool({ name, arguments: a }, undefined, { timeout: 120_000 })) as { isError?: boolean; content: { text: string }[] };
  const text = res.content[0]?.text ?? "";
  if (res.isError) throw new Error(`${name}: ${text}`);
  console.log(`✓ ${name}`);
  await sleep(PAUSE);
  return JSON.parse(text) as T;
}

// 1. Client email (deliver it unless it's already in).
let inbox = await tool("list_inbox", { kind: "client_requirement" });
if (!inbox.emails.length) {
  await fetch(`${BASE}/api/demo/client-email`, { method: "POST" });
  await sleep(PAUSE);
  inbox = await tool("list_inbox", { kind: "client_requirement" });
}
const email = inbox.emails[0];

// 2. Desk Manager: create the requirement.
const { req_id } = await tool("create_requirement", {
  actor: "Desk Manager", source_email_id: email.id, title: "Senior Java Developer", client: "Contoso Health",
  client_contact: "dana.whitfield@contosohealth.example.com", location: "Dallas, TX", work_mode: "hybrid", rate: 68,
  employment_type: "C2C", skills: ["Spring Boot", "AWS", "Kafka"], min_years: 8,
  jd: "Spring Boot microservices on AWS (EKS, RDS, S3), event-driven flows on Kafka, claims platform. 8+ years Java. Nice to have: healthcare, Kubernetes.",
});

// 3. Sourcer + Vendor Bench.
await tool("post_job", { actor: "Job Board Sourcer", req_id, boards: ["dice", "monster", "linkedin"] });
const found = await tool("search_candidates", { query: 'java AND (spring OR "spring boot" OR kafka OR aws)', req_id, limit: 200 });
await tool("add_candidates_to_requirement", { actor: "Job Board Sourcer", req_id, candidate_ids: found.results.map((r: any) => r.candidate_id), source: "dice" });
await tool("send_vendor_mail", { actor: "Vendor Bench", req_id, vendor_ids: ["all"], subject: "Sr Java Developer - Dallas hybrid - $68/hr C2C", body: "Hi partners, please share bench consultants: Spring Boot, AWS, Kafka, 8+ yrs. RTR required." });
let replies: any[] = [];
for (let i = 0; i < 50 && replies.length < 6; i++) {
  await sleep(1000);
  replies = (await client.callTool({ name: "list_inbox", arguments: { kind: "vendor_reply", req_id } }).then((r: any) => JSON.parse(r.content[0].text))).emails;
}
for (const r of replies) await tool("import_vendor_resumes", { actor: "Vendor Bench", req_id, email_id: r.id });

// 4. Matcher: score the top 25 by keyword, shortlist 3 (Kiran first for the healthcare domain).
const top = await tool("list_pipeline", { req_id, stage: "sourced", sort: "keyword", limit: 25, include_resume: true });
const scores = top.entries.map((e: any) => ({
  candidate_id: e.candidate_id,
  score: e.name === "Kiran Rao" ? 97 : e.name === "Ana Souza" ? 94 : e.name === "Marcus Lee" ? 92 : Math.min(e.keywordScore, 89),
  reasons: e.name === "Kiran Rao" ? "All must-haves, 11 yrs, healthcare claims domain, Kubernetes; rate under max." : `Keyword fit ${e.keywordScore}; checked resume.`,
}));
await tool("score_candidates", { actor: "Matcher", req_id, scores });
const shortlist = [...scores].sort((a, b) => b.score - a.score).slice(0, 3).map((s) => s.candidate_id);

// 5. Phone Screener: missed-call text for the phone-preferring candidate, text screens for the rest.
const profiles = await Promise.all(shortlist.map((id) => tool("get_candidate", { candidate_id: id })));
const texted: string[] = [];
for (const p of profiles) {
  if (p.contactPreference === "phone") {
    await tool("send_candidate_message", { actor: "Phone Screener", req_id, candidate_id: p.id, kind: "missed_call", subject: "Missed you: Sr Java role in Dallas", body: `Hi ${p.name.split(" ")[0]}, tried calling about a Senior Java role (Spring Boot/AWS/Kafka, Dallas hybrid). Call back when you have 5 minutes?` });
  } else {
    await tool("send_candidate_message", { actor: "Phone Screener", req_id, candidate_id: p.id, kind: "text_screen", subject: "Quick screen: Sr Java, Dallas hybrid", body: "1) Interested? 2) Earliest start? 3) Notice period? 4) Rate (C2C)? 5) OK with 3 days onsite in Dallas? 6) Work authorization?" });
    texted.push(p.id);
  }
}
await tool("wait_for_replies", { candidate_ids: texted, kind: "text_screen_reply", timeout_seconds: 60 });
for (const p of profiles) {
  const a = p.screenAnswers ?? { interested: true, availability: "Can start Nov 10", noticePeriod: "2 weeks", payExpectation: "$66/hr C2C", locationOk: true, workAuthConfirmed: true, notes: "Phone screen (dry run): prefers Mon/Tue remote." };
  await tool("log_screen_result", { actor: "Phone Screener", req_id, candidate_id: p.id, channel: p.contactPreference === "phone" ? "voice" : "text",
    interested: a.interested, availability: a.availability, notice_period: a.noticePeriod, pay_expectation: a.payExpectation, location_ok: a.locationOk,
    work_auth_confirmed: a.workAuthConfirmed, notes: a.notes, verdict: "pass" });
}

// 6. Paperwork: RTR to all three, collect replies and docs.
for (const id of shortlist) await tool("send_candidate_message", { actor: "Paperwork", req_id, candidate_id: id, kind: "rtr", subject: `RTR + rate confirmation: ${req_id}`, body: "Please confirm we may represent you for this role at your rate, sign the NDA and attach your work authorization." });
const rtr = await tool("wait_for_replies", { candidate_ids: shortlist, kind: "rtr_reply", timeout_seconds: 60 });
for (const p of profiles) {
  const reply = rtr.arrived.find((e: any) => e.candidateId === p.id);
  await tool("record_paperwork", { actor: "Paperwork", req_id, candidate_id: p.id, rtr_signed: true, rate_confirmed: p.rateExpectation, nda_signed: true, work_auth_doc_urls: (reply?.attachments ?? []).map((x: any) => x.url) });
}

// 7. Submission Writer: draft, (recruiter approves), send.
const subs: string[] = [];
for (const p of profiles) {
  const d = await tool("draft_submission", { actor: "Submission Writer", req_id, candidate_id: p.id, bill_rate: 68,
    subject: `Submission: ${p.name} - Senior Java Developer (${req_id})`,
    body: `Hi Dana,\n\nPlease find ${p.name} for the Senior Java Developer role.\n\nName: ${p.name}\nEmail: ${p.email}\nLinkedIn: ${p.linkedin}\nNotice: ${p.noticeWeeks} weeks\nAvailability: ${p.availability}\nBill rate: $68/hr C2C\nEducation: ${p.education}\nWork authorization: ${p.workAuth} (attached)\n\nWhy: ${p.years} yrs, Spring Boot + AWS + Kafka.\n\nRecruiting Desk` });
  subs.push(d.submission_id);
}
for (const id of subs) await tool("send_submission", { actor: "Submission Writer", submission_id: id, approval_quote: "Approve all (dry run)" });

console.log(`Done: ${req_id} with ${subs.length} submissions sent.`);
await client.close();
