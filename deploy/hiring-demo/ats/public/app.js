// Desk ATS UI: one state fetch, live updates over SSE, plain DOM rendering.
const STAGES = ["sourced", "matched", "screened", "rtr", "submitted", "interview", "offer", "onboarding"];
const LABELS = { sourced: "Sourced", matched: "Matched", screened: "Screened", rtr: "RTR", submitted: "Submitted", interview: "Interview", offer: "Offer", onboarding: "Onboarding" };
const SOURCES = { dice: "Dice", monster: "Monster", linkedin: "LinkedIn", vendor: "Vendor", database: "Database" };
const TABS = [
  ["requirements", "Requirements"], ["board", "Board"], ["candidates", "Candidates"], ["vendors", "Vendors"], ["boards", "Job boards"],
  ["inbox", "Inbox"], ["outbox", "Outbox"], ["interviews", "Interviews"], ["onboarding", "Onboarding"], ["timesheets", "Timesheets"],
];
const SOURCED_LIMIT = 30;

const ui = {
  data: null, board: null, tab: "board", reqId: null, drawer: null, jobBoard: "dice", filter: "",
  mailSel: { inbox: null, outbox: null }, seenInbox: 0, glow: new Map(), lastActivityAt: Infinity,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (t) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
const byId = (list, id) => list.find((x) => x.id === id);
const cand = (id) => byId(ui.data.candidates, id);
const reqOf = (id) => byId(ui.data.requirements, id);
const nameOf = (id) => cand(id)?.name ?? id;

function duration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

// ---- data ------------------------------------------------------------------------------------------------------
async function load() {
  const data = await (await fetch("/api/state")).json();
  ui.data = data;
  if (!ui.reqId || !reqOf(ui.reqId)) ui.reqId = [...data.requirements].sort((a, b) => b.receivedAt - a.receivedAt)[0]?.id ?? null;
  ui.board = ui.reqId ? await (await fetch(`/api/board/${ui.reqId}`)).json() : null;
  render();
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(load, 200);
}

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("desk", (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.candidateId) ui.glow.set(ev.candidateId, Date.now() + 2500);
    if (ev.name === "requirement_created" && ev.reqId) { ui.reqId = ev.reqId; ui.tab = "board"; }
    if (ev.name === "reset") { ui.reqId = null; ui.drawer = null; ui.mailSel = { inbox: null, outbox: null }; ui.seenInbox = 0; }
    refreshSoon();
  });
  es.onerror = () => { /* EventSource reconnects on its own */ };
}

// ---- shell -----------------------------------------------------------------------------------------------------
function renderTabs() {
  const unread = ui.data.emails.filter((e) => e.direction === "in").length - ui.seenInbox;
  $("tabs").innerHTML = TABS.map(([key, label]) =>
    `<button class="${ui.tab === key ? "on" : ""}" data-tab="${key}">${label}${key === "inbox" && unread > 0 && ui.tab !== "inbox" ? `<span class="badge">${unread}</span>` : ""}</button>`).join("");
}

function tickClock() {
  const el = $("clock");
  const r = ui.data && ui.reqId ? reqOf(ui.reqId) : null;
  if (!r) { el.textContent = "--:--"; el.className = "clock idle"; return; }
  const end = r.firstSubmittedAt ?? Date.now();
  el.textContent = duration(end - r.receivedAt);
  el.className = `clock${r.firstSubmittedAt ? " stopped" : ""}`;
  $("clockWrap").title = `${r.id} · time to submit${r.firstSubmittedAt ? " (stopped at first submission)" : " (running)"}`;
}

function render() {
  if (!ui.data) return;
  if (ui.tab === "inbox") ui.seenInbox = ui.data.emails.filter((e) => e.direction === "in").length;
  renderTabs();
  const views = { requirements, board, candidates, vendors, boards: jobBoards, inbox: () => mail("inbox"), outbox: () => mail("outbox"), interviews, onboarding, timesheets };
  const feedScroll = document.querySelector(".feed")?.scrollTop ?? 0;
  const colScroll = [...document.querySelectorAll(".cards")].map((c) => c.scrollTop);
  $("view").innerHTML = views[ui.tab]();
  const feed = document.querySelector(".feed");
  if (feed) feed.scrollTop = feedScroll;
  document.querySelectorAll(".cards").forEach((c, i) => { c.scrollTop = colScroll[i] ?? 0; });
  if (ui.drawer) renderDrawer();
  tickClock();
  ui.lastActivityAt = ui.data.activity.at(-1)?.at ?? 0;
}

// ---- board -----------------------------------------------------------------------------------------------------
function reqBar(r) {
  if (!r) return `<div class="req-bar"><span>No requirement selected</span></div>`;
  const options = [...ui.data.requirements].sort((a, b) => b.receivedAt - a.receivedAt)
    .map((x) => `<option value="${x.id}" ${x.id === r.id ? "selected" : ""}>${esc(x.id)} · ${esc(x.title)}</option>`).join("");
  const mode = { onsite: "Onsite", hybrid: "Hybrid", remote: "Remote" }[r.workMode];
  return `<div class="req-bar">
    <b>${esc(r.id)} · ${esc(r.title)}</b><span>${esc(r.client)}</span><span>${esc(r.location)} · ${mode}</span>
    <span>$${r.rate}/hr ${esc(r.employmentType)}</span><span>${r.skills.map(esc).join(" · ")} · ${r.minYears}+ yrs</span>
    <select id="reqPick" aria-label="Requirement">${options}</select></div>`;
}

function statusPills(entry) {
  const d = ui.data;
  const pills = [];
  const sub = d.submissions.find((s) => s.reqId === entry.reqId && s.candidateId === entry.candidate_id);
  if (sub?.status === "draft") pills.push(`<span class="pill wait">awaiting OK</span>`);
  if (sub?.status === "sent") pills.push(`<span class="pill ok">sent</span>`);
  const mine = (kind) => d.emails.filter((e) => e.kind === kind && e.candidateId === entry.candidate_id && e.reqId === entry.reqId);
  const screened = d.screens.some((s) => s.reqId === entry.reqId && s.candidateId === entry.candidate_id);
  if (!screened && mine("missed_call").length) pills.push(`<span class="pill wait">awaiting callback</span>`);
  if (!screened && mine("text_screen").length && !mine("text_screen_reply").length) pills.push(`<span class="pill wait">texted</span>`);
  if (entry.stage === "screened" && mine("rtr").length && !mine("rtr_reply").length) pills.push(`<span class="pill wait">RTR sent</span>`);
  return pills.join("");
}

function card(entry) {
  const glowing = (ui.glow.get(entry.candidate_id) ?? 0) > Date.now();
  const score = entry.score != null ? `<span class="pill score">${entry.score}</span>` : `<span class="pill kw" title="Keyword fit">${entry.keywordScore}</span>`;
  return `<div class="card${glowing ? " glow" : ""}" data-cand="${entry.candidate_id}">
    <b>${esc(entry.name)}</b>
    <div class="pills">${score}<span class="pill auth">${esc(entry.workAuth)}</span><span class="pill">${esc(SOURCES[entry.source] ?? entry.source)}</span>${statusPills(entry)}</div>
  </div>`;
}

function board() {
  const r = reqOf(ui.reqId);
  const entries = (ui.board?.entries ?? []).map((e) => ({ ...e, reqId: ui.reqId }));
  const cols = STAGES.map((stage) => {
    const list = entries.filter((e) => e.stage === stage);
    if (stage !== "sourced") list.sort((a, b) => (b.score ?? b.keywordScore) - (a.score ?? a.keywordScore));
    if (!list.length) return `<div class="col empty"><h5>${LABELS[stage]} <span class="n">0</span></h5></div>`;
    const shown = stage === "sourced" ? list.slice(0, SOURCED_LIMIT) : list;
    const more = list.length - shown.length;
    return `<div class="col"><h5>${LABELS[stage]} <span class="n">${list.length}</span></h5>
      <div class="cards">${shown.map(card).join("")}${more > 0 ? `<div class="more">+${more} more</div>` : ""}</div></div>`;
  }).join("");
  const feed = [...ui.data.activity].reverse().slice(0, 80).map((a) =>
    `<div class="ev${a.at > ui.lastActivityAt ? " fresh" : ""}${a.actor === "Desk ATS" ? " system" : a.actor === "Inbox" ? " inbox" : ""}"><time>${hhmm(a.at)}</time><b>${esc(a.actor)}</b> ${esc(a.text)}</div>`).join("");
  return `${reqBar(r)}<div class="board-wrap"><div class="board">${cols}</div>
    <aside class="rail"><h4>Bot activity</h4><div class="feed">${feed || `<div class="muted">No activity yet.</div>`}</div></aside></div>`;
}

// ---- tables ----------------------------------------------------------------------------------------------------
function table(headers, rows) {
  return `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${headers.length}" class="muted">Nothing here yet.</td></tr>`}</tbody></table>`;
}

function requirements() {
  const counts = (id) => STAGES.map((s) => ui.data.pipeline.filter((p) => p.reqId === id && p.stage === s).length);
  const rows = [...ui.data.requirements].sort((a, b) => b.receivedAt - a.receivedAt).map((r) => {
    const c = counts(r.id);
    const max = Math.max(1, ...c);
    const tts = r.firstSubmittedAt ? duration(r.firstSubmittedAt - r.receivedAt) : `<span class="muted">open</span>`;
    return `<tr class="click${r.id === ui.reqId ? " sel" : ""}" data-req="${r.id}"><td><b>${esc(r.id)}</b></td><td>${esc(r.title)}</td><td>${esc(r.client)}</td>
      <td>${esc(r.location)}</td><td>$${r.rate}/hr ${esc(r.employmentType)}</td><td>${day(r.receivedAt)} ${hhmm(r.receivedAt)}</td><td>${tts}</td>
      <td><div class="mini" title="${STAGES.map((s, i) => `${LABELS[s]} ${c[i]}`).join(" · ")}">${c.map((n) => `<i style="height:${Math.max(2, (n / max) * 18)}px"></i>`).join("")}</div></td></tr>`;
  });
  return `<div class="page"><div class="panel"><h3>Open requirements <span class="muted">${ui.data.requirements.length}</span></h3>
    ${table(["Req", "Title", "Client", "Location", "Rate", "Received", "Time to submit", "Pipeline"], rows)}</div></div>`;
}

function candidateRows() {
  const q = ui.filter.trim().toLowerCase();
  const list = ui.data.candidates.filter((c) => !q || [c.name, c.title, c.location, c.workAuth, ...c.skills].join(" ").toLowerCase().includes(q));
  return { total: list.length, rows: list.slice(0, 150).map((c) =>
    `<tr class="click" data-cand="${c.id}"><td><b>${esc(c.name)}</b><div class="muted">${esc(c.id)}</div></td><td>${esc(c.title)}</td><td>${esc(c.location)}</td>
      <td><span class="pill auth">${esc(c.workAuth)}</span></td><td>${c.years}</td><td>$${c.rateExpectation}/hr</td><td>${esc(c.skills.slice(0, 4).join(", "))}</td><td>${esc(SOURCES[c.source] ?? c.source)}</td></tr>`) };
}

function candidates() {
  const { total, rows } = candidateRows();
  return `<div class="page"><div class="panel"><h3><span>Candidate database <span class="muted" id="candCount">${total}</span></span>
    <input id="candFilter" placeholder="Filter by name, skill, location, work auth" value="${esc(ui.filter)}"></h3>
    <div id="candTable">${table(["Name", "Title", "Location", "Auth", "Yrs", "Rate", "Skills", "Source"], rows)}</div></div></div>`;
}

function vendors() {
  const rows = ui.data.vendors.map((v) => `<tr><td><b>${esc(v.name)}</b><div class="muted">${esc(v.id)}</div></td><td>${esc(v.contact)}</td><td>${esc(v.email)}</td><td>${v.benchSize}</td></tr>`);
  return `<div class="page"><div class="panel"><h3>C2C vendor partners <span class="muted">${ui.data.vendors.length}</span></h3>${table(["Vendor", "Contact", "Email", "Bench"], rows)}</div></div>`;
}

function jobBoards() {
  const posts = ui.data.requirements.filter((r) => r.postedOn.includes(ui.jobBoard)).sort((a, b) => b.receivedAt - a.receivedAt);
  const items = posts.map((r) => `<div class="post"><h4>${esc(r.title)} <span class="muted">· ${esc(r.id)}</span></h4>
    <div class="muted">${esc(r.client)} · ${esc(r.location)} (${esc(r.workMode)}) · $${r.rate}/hr ${esc(r.employmentType)} · ${r.minYears}+ yrs</div>
    <p>${esc(r.jd)}</p><div class="pills" style="margin-top:6px">${r.skills.map((s) => `<span class="pill">${esc(s)}</span>`).join(" ")}</div></div>`).join("");
  return `<div class="page"><div class="subtabs">${["dice", "monster", "linkedin"].map((b) => `<button class="${b === ui.jobBoard ? "on" : ""}" data-jobboard="${b}">${SOURCES[b]} (demo)</button>`).join("")}</div>
    <div class="panel"><h3>${SOURCES[ui.jobBoard]} (demo): posted jobs <span class="muted">${posts.length}</span></h3>${items || `<div class="empty-state">No jobs posted here yet.</div>`}</div></div>`;
}

function mail(box) {
  const dir = box === "inbox" ? "in" : "out";
  const list = ui.data.emails.filter((e) => e.direction === dir).slice().reverse();
  if (!list.length) return `<div class="empty-state">${box === "inbox" ? "Inbox is empty." : "Nothing sent yet."}</div>`;
  const sel = byId(list, ui.mailSel[box]) ?? list[0];
  ui.mailSel[box] = sel.id;
  const who = (e) => box === "inbox" ? e.from.replace(/\s*<.*>/, "") : (e.candidateId ? nameOf(e.candidateId) : e.to.length > 2 ? `${e.to.length} recipients` : e.to.join(", "));
  const items = list.map((e) => `<div class="mail-item${e.id === sel.id ? " sel" : ""}" data-mail="${box}:${e.id}">
    <div class="from"><span>${esc(who(e))}</span><span class="muted">${hhmm(e.at)}</span></div>
    <div class="subj">${esc(e.subject)}</div><div class="kind">${esc(e.kind.replaceAll("_", " "))}${e.actor ? ` · ${esc(e.actor)}` : ""}</div></div>`).join("");
  const sub = ui.data.submissions.find((s) => s.status === "sent" && s.candidateId === sel.candidateId && sel.kind === "submission");
  const read = `<h2>${esc(sel.subject)}</h2><div class="hdr">From: ${esc(sel.from)}<br>To: ${esc(sel.to.join(", "))}<br>${day(sel.at)} ${hhmm(sel.at)}${sel.reqId ? ` · ${esc(sel.reqId)}` : ""}${sel.actor ? ` · sent by ${esc(sel.actor)}` : ""}</div>
    <pre>${esc(sel.body)}</pre>
    ${sel.attachments.length ? `<div class="attach">${sel.attachments.map((a) => `<a href="${esc(a.url)}" target="_blank">📎 ${esc(a.name)}</a>`).join("")}</div>` : ""}
    ${sub?.approvalQuote ? `<div class="approved">Approved by recruiter: "${esc(sub.approvalQuote)}"</div>` : ""}`;
  return `<div class="mail"><div class="mail-list">${items}</div><div class="mail-read">${read}</div></div>`;
}

function interviews() {
  const rows = [...ui.data.interviews].reverse().map((i) => `<tr class="click" data-cand="${i.candidateId}"><td><b>${esc(nameOf(i.candidateId))}</b></td>
    <td>${esc(reqOf(i.reqId)?.title ?? i.reqId)}<div class="muted">${esc(reqOf(i.reqId)?.client ?? "")}</div></td><td>Round ${i.round}</td><td>${esc(i.when)}</td>
    <td>${esc(i.interviewers)}</td><td>${esc(i.status)}</td><td>${esc(i.outcome ?? "")}${i.feedback ? `<div class="muted">${esc(i.feedback)}</div>` : ""}</td></tr>`);
  return `<div class="page"><div class="panel"><h3>Interviews</h3>${table(["Candidate", "Requirement", "Round", "When", "Interviewers", "Status", "Outcome"], rows)}</div></div>`;
}

function onboarding() {
  const yes = (b) => (b ? `<span class="verdict-pass">✓</span>` : `<span class="muted">—</span>`);
  const rows = ui.data.onboarding.map((o) => `<tr class="click" data-cand="${o.candidateId}"><td><b>${esc(nameOf(o.candidateId))}</b></td>
    <td>${esc(reqOf(o.reqId)?.title ?? o.reqId)}<div class="muted">${esc(reqOf(o.reqId)?.client ?? "")}</div></td>
    <td>${o.path === "W2" ? "W-2 offer letter" : "C2C MSA"}</td><td>${yes(o.offerDocSent)}</td><td>${esc(o.bgv.replace("_", " "))}</td>
    <td>${esc(o.laptopTracking ?? "—")}</td><td>${esc(o.startDate ?? "—")}</td><td>${yes(o.startConfirmed)}</td></tr>`);
  return `<div class="page"><div class="panel"><h3>Onboarding</h3>${table(["Consultant", "Requirement", "Path", "Offer doc", "Background check", "Laptop", "Start", "Confirmed"], rows)}</div></div>`;
}

function timesheets() {
  const rows = [...ui.data.timesheets].sort((a, b) => b.month.localeCompare(a.month)).map((t) => `<tr class="click" data-cand="${t.candidateId}">
    <td><b>${esc(nameOf(t.candidateId))}</b></td><td>${esc(t.month)}</td><td>${t.hours ?? "—"}</td><td>${esc(t.status)}</td></tr>`);
  return `<div class="page"><div class="panel"><h3>Timesheets</h3>${table(["Consultant", "Month", "Hours", "Status"], rows)}</div></div>`;
}

// ---- drawer ----------------------------------------------------------------------------------------------------
function renderDrawer() {
  const c = cand(ui.drawer);
  if (!c) return closeDrawer();
  const d = ui.data;
  const entries = d.pipeline.filter((p) => p.candidateId === c.id);
  const screens = d.screens.filter((s) => s.candidateId === c.id);
  const paperwork = d.paperwork.filter((p) => p.candidateId === c.id);
  const subs = d.submissions.filter((s) => s.candidateId === c.id);
  const check = (ok, label) => `<div class="check"><span class="${ok ? "y" : "n"}">${ok ? "✓" : "○"}</span>${label}</div>`;
  $("drawerBody").innerHTML = `
    <h2>${esc(c.name)}</h2><div class="meta">${esc(c.title)} · ${esc(c.location)}${c.relocate ? " (will relocate)" : ""}</div>
    <h4>Profile</h4><dl class="kv">
      <dt>Work auth</dt><dd>${esc(c.workAuth)}</dd><dt>Experience</dt><dd>${c.years} years</dd><dt>Rate</dt><dd>$${c.rateExpectation}/hr</dd>
      <dt>Notice</dt><dd>${c.noticeWeeks ? `${c.noticeWeeks} weeks` : "None"}</dd><dt>Availability</dt><dd>${esc(c.availability)}</dd>
      <dt>Education</dt><dd>${esc(c.education)}</dd><dt>Source</dt><dd>${esc(SOURCES[c.source] ?? c.source)}</dd>
      <dt>Prefers</dt><dd>${c.contactPreference === "phone" ? "Phone call" : "Text / email"}</dd>
      <dt>Contact</dt><dd>${esc(c.email)}<br>${esc(c.phone)}<br><a href="#" onclick="return false">${esc(c.linkedin)}</a></dd>
      <dt>Skills</dt><dd>${c.skills.map(esc).join(", ")}</dd></dl>
    <h4>Documents</h4><div class="attach" style="margin-top:0"><a href="/docs/${c.id}/resume" target="_blank">📄 Resume</a>
      ${c.workAuthDocs.map((a) => `<a href="${esc(a.url)}" target="_blank">📎 ${esc(a.name)}</a>`).join("")}</div>
    <h4>Requirements</h4>${entries.map((p) => `<div class="screen"><b>${esc(p.reqId)}</b> · ${esc(reqOf(p.reqId)?.title ?? "")} · <b>${LABELS[p.stage]}</b>
      ${p.score != null ? `<div>Match score <span class="pill score">${p.score}</span> ${esc(p.scoreReasons ?? "")}</div>` : ""}</div>`).join("") || `<div class="muted">Not on any requirement.</div>`}
    ${screens.length ? `<h4>Screens</h4>${screens.map((s) => `<div class="screen"><div><b>${s.channel === "voice" ? "📞 Phone" : "💬 Text"}</b> · ${esc(s.actor)} · ${hhmm(s.at)} · <span class="verdict-${s.verdict}">${esc(s.verdict)}</span></div>
      <dl class="kv" style="margin-top:4px"><dt>Interested</dt><dd>${s.answers.interested ? "Yes" : "No"}</dd><dt>Availability</dt><dd>${esc(s.answers.availability)}</dd>
      <dt>Notice</dt><dd>${esc(s.answers.noticePeriod)}</dd><dt>Pay</dt><dd>${esc(s.answers.payExpectation)}</dd><dt>Location OK</dt><dd>${s.answers.locationOk ? "Yes" : "No"}</dd>
      <dt>Work auth</dt><dd>${s.answers.workAuthConfirmed ? "Confirmed" : "Not confirmed"}</dd><dt>Notes</dt><dd>${esc(s.answers.notes)}</dd></dl></div>`).join("")}` : ""}
    ${paperwork.length ? `<h4>Paperwork</h4>${paperwork.map((p) => `<div class="screen"><b>${esc(p.reqId)}</b>${check(p.rtrSigned, "RTR signed")}${check(p.rateConfirmed != null, `Rate confirmed${p.rateConfirmed != null ? ` at $${p.rateConfirmed}/hr` : ""}`)}${check(p.ndaSigned, "NDA signed")}${check(p.workAuthDocs.length > 0 || c.workAuth === "USC", `Work-auth docs${c.workAuth === "USC" ? " (US citizen, none needed)" : ` (${p.workAuthDocs.length})`}`)}</div>`).join("")}` : ""}
    ${subs.length ? `<h4>Submissions</h4>${subs.map((s) => `<div class="screen"><b>${esc(s.reqId)}</b> → ${esc(s.to)} · $${s.billRate}/hr · <b>${s.status === "sent" ? "Sent" : "Draft, awaiting OK"}</b>
      ${s.approvalQuote ? `<div class="approved" style="margin-top:6px">Approved by recruiter: "${esc(s.approvalQuote)}"</div>` : ""}</div>`).join("")}` : ""}`;
  $("drawer").classList.add("open");
  $("drawer").setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  ui.drawer = null;
  $("drawer").classList.remove("open");
  $("drawer").setAttribute("aria-hidden", "true");
}

// ---- events ----------------------------------------------------------------------------------------------------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-tab],[data-req],[data-cand],[data-mail],[data-jobboard],[data-demo]");
  if (!t) return;
  if (t.dataset.tab) { ui.tab = t.dataset.tab; render(); return; }
  if (t.dataset.req) { ui.reqId = t.dataset.req; ui.tab = "board"; await load(); return; }
  if (t.dataset.cand) { ui.drawer = t.dataset.cand; renderDrawer(); return; }
  if (t.dataset.mail) { const [box, id] = t.dataset.mail.split(":"); ui.mailSel[box] = id; render(); return; }
  if (t.dataset.jobboard) { ui.jobBoard = t.dataset.jobboard; render(); return; }
  if (t.dataset.demo) {
    if (t.dataset.demo === "reset" && !confirm("Reset the demo to the seeded state?")) return;
    const res = await fetch(`/api/demo/${t.dataset.demo}`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    $("demoMsg").textContent = res.ok ? ({ "client-email": "Client email delivered.", morning: "Next-morning events delivered.", reset: "Reset done." })[t.dataset.demo] : body.error ?? "Failed";
    if (res.ok && t.dataset.demo === "client-email") { ui.tab = "inbox"; }
    refreshSoon();
  }
});

document.addEventListener("change", async (e) => {
  if (e.target.id === "reqPick") { ui.reqId = e.target.value; await load(); }
});

document.addEventListener("input", (e) => {
  if (e.target.id !== "candFilter") return;
  ui.filter = e.target.value;
  const { total, rows } = candidateRows();
  $("candCount").textContent = total;
  $("candTable").innerHTML = table(["Name", "Title", "Location", "Auth", "Yrs", "Rate", "Skills", "Source"], rows);
});

$("drawerClose").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
$("demoToggle").addEventListener("click", () => {
  const menu = $("demoMenu");
  menu.hidden = !menu.hidden;
  $("demo").classList.toggle("open", !menu.hidden);
  $("demoMsg").textContent = "";
});

setInterval(tickClock, 1000);
setInterval(() => {
  // Drop glow once it expires without waiting for the next event.
  const now = Date.now();
  for (const [id, until] of ui.glow) if (until < now) { ui.glow.delete(id); document.querySelectorAll(`.card.glow[data-cand="${id}"]`).forEach((el) => el.classList.remove("glow")); }
}, 500);

connect();
load();
