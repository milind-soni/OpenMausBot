// A replay of one job a bot did: the person's request, each step it took (with the screenshots its recorded browser
// steps kept), and its answer, as one static page. It is built only from text already redacted where it was stored, and
// redacted again by the server; every value goes into the page escaped, and no markdown or HTML of the bot's is run.

export interface ReplayStep {
  /** Order in the replay, from 1. */
  n: number;
  at: number;
  kind: "browser" | "tool";
  /** What the step did, in words ("Clicked Sign up"). */
  action: string;
  /** The page's title, or a tool's one-line summary. */
  detail?: string;
  /** The page's host and path, never its query. */
  site?: string;
  ok: boolean;
  /** The step's screenshot, by the step number the evidence store gave it; absent when none was kept. */
  image?: { step: number; bytes: number };
  /** The page moved to a new address on this step. */
  navigated?: boolean;
}

export interface ReplayModel {
  title: string;
  bot: string;
  request: string;
  answer: string;
  startedAt: number;
  endedAt: number;
  steps: ReplayStep[];
}

/** Under a published page's 5 MB and 200 files (shared/published-page.ts), with room for the page itself. */
export const REPLAY_IMAGE_BYTES = 4_500_000;
export const REPLAY_MAX_IMAGES = 150;
export const REPLAY_MAX_STEPS = 400;
export const REPLAY_TEXT_MAX = 4_000;

/** Which steps keep their screenshot within the budget: failures first, then the first and last, then each new page,
 * then the rest spread evenly. A step is shown either way; only its picture is left out. */
export function chooseScreenshots(steps: readonly ReplayStep[], budget = REPLAY_IMAGE_BYTES, maxImages = REPLAY_MAX_IMAGES): Set<number> {
  const pictured = steps.filter((step) => step.image);
  const order: ReplayStep[] = [];
  const add = (step: ReplayStep | undefined) => { if (step && !order.includes(step)) order.push(step); };
  for (const step of pictured) if (!step.ok) add(step);
  add(pictured[0]);
  add(pictured.at(-1));
  for (const step of pictured) if (step.navigated) add(step);
  // The rest by halving: the middle one first, then the middles of each half, so any cut leaves them spread out.
  const rest = pictured.filter((step) => !order.includes(step));
  const queue: Array<[number, number]> = [[0, rest.length - 1]];
  while (queue.length) {
    const [low, high] = queue.shift()!;
    if (low > high) continue;
    const middle = (low + high) >> 1;
    add(rest[middle]);
    queue.push([low, middle - 1], [middle + 1, high]);
  }
  const kept = new Set<number>();
  let bytes = 0;
  for (const step of order) {
    if (kept.size >= maxImages) break;
    if (bytes + step.image!.bytes > budget) continue;
    bytes += step.image!.bytes;
    kept.add(step.n);
  }
  return kept;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
const clip = (text: string, max = REPLAY_TEXT_MAX) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The page. `imageSrc` is a step's picture as the page links it (a file beside it, or a data: URL), null for none. */
export function renderReplayHtml(model: ReplayModel, imageSrc: (step: ReplayStep) => string | null): string {
  const date = new Date(model.startedAt).toISOString().slice(0, 10);
  const pictured = model.steps.filter((step) => imageSrc(step) !== null).length;
  const steps = model.steps.map((step) => {
    const src = imageSrc(step);
    const place = step.site ? `<div class="site">${escapeHtml(clip(step.site, 300))}</div>` : "";
    const detail = step.detail ? `<div class="detail">${escapeHtml(clip(step.detail, 400))}</div>` : "";
    const picture = src ? `<img loading="lazy" alt="${escapeHtml(clip(step.action, 200))}" src="${escapeHtml(src)}">` : "";
    return `<li class="step${step.ok ? "" : " failed"}${src ? " pictured" : ""}" id="step-${step.n}">`
      + `<div class="head"><span class="n">${step.n}</span><span class="mark" aria-label="${step.ok ? "done" : "failed"}">${step.ok ? "✓" : "✗"}</span>`
      + `<span class="action">${escapeHtml(clip(step.action, 300))}</span></div>${place}${detail}${picture}</li>`;
  }).join("\n");
  const answer = model.answer ? `<section class="answer"><h2>Answer</h2><p>${escapeHtml(clip(model.answer)).replace(/\n/g, "<br>")}</p></section>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(clip(model.title, 200))}</title>
<style>
:root{--bg:#fafaf9;--card:#fff;--ink:#1c1917;--muted:#57534e;--line:#e7e5e4;--ok:#15803d;--bad:#b91c1c;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--card:#1c1917;--ink:#f5f5f4;--muted:#a8a29e;--line:#292524;--ok:#4ade80;--bad:#f87171;--accent:#a5b4fc}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:0 0 8px}
.meta{color:var(--muted);font-size:13px}.request{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:16px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.bar{display:flex;gap:8px;align-items:center;margin:8px 0 12px;position:sticky;top:0;background:var(--bg);padding:8px 0}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:4px 12px;cursor:pointer}
ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.step{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;overflow-wrap:anywhere}.step.current{outline:2px solid var(--accent)}
.head{display:flex;gap:8px;align-items:baseline}.n{color:var(--muted);font-size:12px;min-width:2ch}.mark{color:var(--ok)}.failed .mark{color:var(--bad)}.action{font-weight:500}
.site,.detail{color:var(--muted);font-size:13px;margin-left:calc(2ch + 24px)}
img{display:block;width:100%;height:auto;margin-top:8px;border:1px solid var(--line);border-radius:8px}
.answer{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-top:16px;overflow-wrap:anywhere}
footer{color:var(--muted);font-size:12px;margin-top:24px;text-align:center}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(clip(model.title, 200))}</h1>
<div class="meta">${escapeHtml(clip(model.bot, 100))} · ${date} · ${duration(model.endedAt - model.startedAt)} · ${model.steps.length} step${model.steps.length === 1 ? "" : "s"}</div>
${model.request && model.request !== model.title ? `<div class="request">${escapeHtml(clip(model.request))}</div>` : ""}
${pictured ? `<div class="bar"><button type="button" id="play">Play</button><button type="button" id="prev" aria-label="Previous step">←</button><button type="button" id="next" aria-label="Next step">→</button><span class="meta" id="where"></span></div>` : ""}
<ol>
${steps}
</ol>
${answer}
<footer>A replay of a bot's work, made with MausBot.</footer>
</main>
${pictured ? `<script>
(()=>{const s=[...document.querySelectorAll(".step.pictured")];let i=-1,t=null;const w=document.getElementById("where");
const go=(k)=>{if(!s.length)return;i=Math.max(0,Math.min(s.length-1,k));s.forEach((e,j)=>e.classList.toggle("current",j===i));s[i].scrollIntoView({behavior:"smooth",block:"start"});w.textContent=(i+1)+" of "+s.length};
const stop=()=>{clearInterval(t);t=null;document.getElementById("play").textContent="Play"};
document.getElementById("play").onclick=()=>{if(t){stop();return}document.getElementById("play").textContent="Pause";if(i>=s.length-1)i=-1;go(i+1);t=setInterval(()=>{i>=s.length-1?stop():go(i+1)},2000)};
document.getElementById("prev").onclick=()=>{stop();go(i-1)};document.getElementById("next").onclick=()=>{stop();go(i+1)};
addEventListener("keydown",(e)=>{if(e.key==="ArrowRight"){stop();go(i+1)}else if(e.key==="ArrowLeft"){stop();go(i-1)}});})();
</script>` : ""}
</body>
</html>
`;
}
