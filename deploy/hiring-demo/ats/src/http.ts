// HTTP surface: the UI's REST + SSE API, demo controls, SAMPLE document pages, the MCP endpoint and static files.
import express from "express";
import { fileURLToPath } from "node:url";

import { DeskError, type Desk } from "./desk.ts";
import { mcpHandler } from "./mcp.ts";
import type { Sim } from "./sim.ts";
import type { Store } from "./store.ts";
import type { Candidate } from "./types.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const DOC_TITLES: Record<string, string> = {
  h1b: "H-1B approval notice",
  i94: "I-94 arrival/departure record",
  ead: "Employment Authorization Document (EAD)",
  gc: "Permanent resident card",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function docPage(c: Candidate, docType: string): string {
  const isResume = docType === "resume";
  const title = isResume ? `${c.name} — resume` : `${DOC_TITLES[docType]} (SAMPLE)`;
  const body = isResume
    ? `<h1>${escapeHtml(c.name)}</h1><p class="meta">${escapeHtml(c.title)} · ${escapeHtml(c.location)} · ${escapeHtml(c.workAuth)} · ${c.years} yrs</p>
       <p class="meta">${escapeHtml(c.email)} · ${escapeHtml(c.phone)} · ${escapeHtml(c.linkedin)}</p>
       <h2>Skills</h2><p>${c.skills.map(escapeHtml).join(", ")}</p><h2>Experience</h2><p>${escapeHtml(c.resume)}</p>
       <h2>Education</h2><p>${escapeHtml(c.education)}</p>`
    : `<div class="mark">SAMPLE</div><h1>${escapeHtml(DOC_TITLES[docType]!)}</h1>
       <p class="big">Placeholder for ${escapeHtml(DOC_TITLES[docType]!)}: not a real document.</p>
       <p>Candidate: <b>${escapeHtml(c.name)}</b> (${escapeHtml(c.id)})</p>
       <p>In the real workflow the candidate's own copy is attached here. This demo uses made-up data only.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Inter",sans-serif;color:#16202a;max-width:760px;margin:40px auto;padding:0 20px;position:relative}
    h1{font-size:22px;margin:0 0 6px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:#5b6b7b;margin:22px 0 4px}
    .meta{color:#5b6b7b;margin:2px 0}.big{font-size:18px;font-weight:600}
    .mark{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-size:160px;font-weight:800;color:rgba(200,30,30,.13);transform:rotate(-28deg);pointer-events:none}
  </style></head><body>${body}</body></html>`;
}

export function createApp(deps: { store: Store; desk: Desk; sim: Sim }): express.Express {
  const { store, desk, sim } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/state", (_req, res) => {
    const { pending: _pending, script: _script, ...visible } = store.state;
    res.json(visible);
  });

  app.get("/api/events", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    const off = store.on((e) => res.write(`event: desk\ndata: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      off();
      clearInterval(ping);
    });
  });

  app.get("/api/board/:reqId", (req, res) => {
    try {
      res.json(desk.listPipeline({ req_id: req.params.reqId, sort: "keyword", limit: 200 }));
    } catch (err) {
      if (err instanceof DeskError) res.status(404).json({ error: err.message });
      else throw err;
    }
  });

  const demo = (fn: () => unknown) => (_req: express.Request, res: express.Response) => {
    try {
      res.json(fn());
    } catch (err) {
      if (err instanceof DeskError) res.status(409).json({ error: err.message });
      else throw err;
    }
  };
  app.post("/api/demo/client-email", demo(() => ({ email_id: sim.deliverClientEmail().id })));
  app.post("/api/demo/morning", demo(() => ({ email_ids: sim.deliverMorningEvents().map((e) => e.id) })));
  app.post("/api/demo/reset", demo(() => {
    store.reset();
    return { ok: true };
  }));

  app.get("/docs/:candidateId/:docType", (req, res) => {
    const { candidateId, docType } = req.params;
    if (docType !== "resume" && !DOC_TITLES[docType]) return void res.status(404).send("Unknown document type");
    const c = store.state.candidates.find((x) => x.id === candidateId)
      ?? store.state.script.vendorReplies.flatMap((r) => r.consultants).find((x) => x.id === candidateId);
    if (!c) return void res.status(404).send("Unknown candidate");
    res.type("html").send(docPage(c, docType));
  });

  app.all("/mcp", mcpHandler(desk, { sim, store }));
  app.use(express.static(PUBLIC_DIR));
  return app;
}
