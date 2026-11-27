// show_html calls the way a bot writes them, and MCP app calls as stored, modelled on the official MCP
// Apps example servers.

const COUNTER = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{margin:0;padding:16px;font-family:var(--font-sans);color:var(--color-text-primary);background:var(--color-background-primary)}
button{font:inherit;padding:8px 14px;border-radius:10px;border:1px solid var(--color-border-primary);background:transparent;color:inherit}
.count{font-size:40px;font-weight:600;margin:8px 0 12px}
</style></head><body>
<div>Cups of coffee today</div><div class="count" id="count">0</div>
<button id="more">One more</button> <button id="tell">Tell the bot</button> <button id="docs">How much is too much?</button>
<script>
let count = 0;
const shown = document.getElementById("count");
document.getElementById("more").onclick = () => { count += 1; shown.textContent = String(count); mausbot.setContext("The counter shows " + count + " cups."); };
document.getElementById("tell").onclick = () => mausbot.send("I have had " + count + " cups of coffee today.");
document.getElementById("docs").onclick = () => mausbot.open("https://www.fda.gov/consumers/consumer-updates/spilling-beans-how-much-caffeine-too-much");
</script></body></html>`;

const CHART = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>body{margin:0;padding:12px;background:var(--color-background-primary)}canvas{max-height:280px}</style></head>
<body><canvas id="chart"></canvas><script>
new Chart(document.getElementById("chart"), {
  type: "bar",
  data: { labels: ["Jan", "Feb", "Mar", "Apr"], datasets: [{ label: "Signups", data: [120, 180, 240, 310] }] },
  options: { responsive: true, plugins: { legend: { display: false } } },
});
</script></body></html>`;

const REPORT = `<html><head><style>
body{margin:0;padding:16px;font-family:var(--font-sans);color:var(--color-text-primary)}
table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid var(--color-border-primary);text-align:left}
</style></head><body><h2>Weekly spend</h2><table>
<tr><th>Bot</th><th>Runs</th><th>Cost</th></tr>
<tr><td>Scout</td><td>38</td><td>$21.40</td></tr><tr><td>Kiwi</td><td>52</td><td>$6.35</td></tr>
</table><p>Total: $27.75</p></body></html>`;

const FRAGMENT = `<div style="padding:12px;font-family:var(--font-sans)"><b>Tip:</b> press <kbd>⌘K</kbd> to search every chat.</div>`;

const GAME = `<!DOCTYPE html><html><head><style>
body{margin:0;padding:12px;font-family:var(--font-sans);color:var(--color-text-primary)}
.grid{display:grid;grid-template-columns:repeat(3,64px);gap:6px}
.grid button{height:64px;font-size:28px;border-radius:10px;border:1px solid var(--color-border-primary);background:var(--color-background-secondary);color:inherit}
</style></head><body><div class="grid" id="grid"></div><p id="status">Your move (X)</p><script>
const cells = Array(9).fill("");
const grid = document.getElementById("grid");
const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const winner = () => lines.map((l) => l.map((i) => cells[i]).join("")).find((s) => s === "XXX" || s === "OOO");
cells.forEach((_, i) => { const b = document.createElement("button"); b.onclick = () => play(i); grid.appendChild(b); });
function play(i) {
  if (cells[i] || winner()) return;
  cells[i] = "X"; const free = cells.map((c, j) => c ? -1 : j).filter((j) => j >= 0);
  if (!winner() && free.length) cells[free[Math.floor(free.length / 2)]] = "O";
  [...grid.children].forEach((b, j) => { b.textContent = cells[j]; });
  const won = winner();
  document.getElementById("status").textContent = won ? (won[0] === "X" ? "You win" : "I win") : free.length ? "Your move (X)" : "Draw";
  if (won) mausbot.setContext("Tic-tac-toe ended: " + (won[0] === "X" ? "the person won" : "the bot won") + ".");
}
</script></body></html>`;

export interface AppSample {
  html: string;
  title: string;
  height?: number;
  fallback_text?: string;
}

export const APP_SAMPLES: Record<string, AppSample> = {
  counter: { html: COUNTER, title: "Coffee counter", height: 200 },
  chart: { html: CHART, title: "Signups by month", height: 320, fallback_text: "Signups by month: Jan 120, Feb 180, Mar 240, Apr 310." },
  report: { html: REPORT, title: "Weekly spend" },
  fragment: { html: FRAGMENT, title: "Search tip" },
  game: { html: GAME, title: "Tic-tac-toe", height: 260 },
};

export interface McpAppSample {
  server: string;
  serverTitle: string;
  loopback: boolean;
  tool: { name: string; title?: string; description?: string; inputSchema: object; annotations?: object; _meta: object };
  resourceUri: string;
  html: string;
  /** `_meta.ui` of the UI resource's content item. */
  resourceMeta: { csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[] }; permissions?: object; prefersBorder?: boolean };
  toolInput: Record<string, unknown>;
  toolResult: { content: unknown[]; structuredContent?: unknown; _meta?: Record<string, unknown>; isError?: boolean };
}

const VIEW = (title: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body><div id="root">${title}</div><script type="module">/* an SDK-built view */</script></body></html>`;

export const MCP_APP_SAMPLES: Record<string, McpAppSample> = {
  // @modelcontextprotocol/server-basic-vanillajs, over stdio.
  basic: {
    server: "basic", serverTitle: "Basic Server", loopback: true,
    tool: {
      name: "get-time", title: "Get Time", description: "Returns the current server time.",
      inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: "ui://get-time/mcp-app.html" }, "ui/resourceUri": "ui://get-time/mcp-app.html" },
    },
    resourceUri: "ui://get-time/mcp-app.html",
    html: VIEW("Get Server Time"),
    resourceMeta: {},
    toolInput: {},
    toolResult: { content: [{ type: "text", text: "2026-10-14T09:30:00.000Z" }], structuredContent: { time: "2026-10-14T09:30:00.000Z" } },
  },
  // mcp.excalidraw.com
  excalidraw: {
    server: "excalidraw", serverTitle: "Excalidraw", loopback: false,
    tool: {
      name: "create_view", title: "Create view", description: "Draw a diagram.",
      inputSchema: { type: "object", properties: { elements: { type: "array" } } }, annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: "ui://excalidraw/mcp-app.html" } },
    },
    resourceUri: "ui://excalidraw/mcp-app.html",
    html: VIEW("Excalidraw"),
    resourceMeta: {
      csp: { resourceDomains: ["https://esm.sh"], connectDomains: ["https://esm.sh", "http://localhost:8080", "https://example.com/path"], frameDomains: ["https://www.youtube.com"] },
      permissions: { clipboardWrite: {} },
      prefersBorder: true,
    },
    toolInput: { elements: [{ type: "rectangle", x: 0, y: 0 }] },
    toolResult: { content: [{ type: "text", text: "Diagram ready: 1 element." }], structuredContent: { checkpoint: "c1" } },
  },
  // @modelcontextprotocol/server-debug: an error result.
  debugError: {
    server: "debug", serverTitle: "Debug Server", loopback: true,
    tool: {
      name: "debug-tool", title: "Debug Tool", inputSchema: { type: "object", properties: { fail: { type: "boolean" } } },
      _meta: { ui: { resourceUri: "ui://debug/mcp-app.html", visibility: ["model", "app"] } },
    },
    resourceUri: "ui://debug/mcp-app.html",
    html: VIEW("Debug Tool"),
    resourceMeta: { prefersBorder: false },
    toolInput: { fail: true },
    toolResult: { content: [{ type: "text", text: "Failed on purpose." }], isError: true },
  },
};
