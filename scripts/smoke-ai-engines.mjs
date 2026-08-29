// Harmless live smoke for the model-routing paths people actually select.
// Uses hidden temporary bots and deletes them even when a provider fails.

const portArg = process.argv.indexOf("--port");
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : process.env.OMB_PORT ?? 8799);
const base = `http://127.0.0.1:${port}`;
const timeoutMs = 180_000;

const cases = [
  { label: "Cursor · Grok", instanceId: "cursor", model: "cursor-grok-4.6-low-fast" },
  { label: "Cursor · Fable", instanceId: "cursor", model: "claude-fable-5-low" },
  { label: "Cursor · Codex", instanceId: "cursor", model: "gpt-5.6-sol-low-fast" },
  { label: "Cursor · Composer", instanceId: "cursor", model: "composer-2.5-fast" },
  { label: "Cursor · Gemini", instanceId: "cursor", model: "gemini-3.7-flash-low" },
  { label: "Grok CLI", instanceId: "grok", model: "grok-4.6" },
  { label: "Claude CLI", instanceId: "claude", model: "claude-fable-5" },
  { label: "Codex CLI", instanceId: "codex", model: "gpt-5.6-luna" },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${body.error ?? "unknown error"}`);
  return body;
}

async function waitForReply(botId, token) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await api("/api/bots");
    const bot = state.bots.find((candidate) => candidate.id === botId);
    if (!bot) throw new Error("temporary bot disappeared");
    const reply = [...bot.messages].reverse().find(
      (message) => message.role === "bot" && message.kind === "text" && message.text?.includes(token),
    );
    if (reply) return;
    if (!bot.busy) {
      const last = [...bot.messages].reverse().find((message) => message.kind !== "options");
      throw new Error(`settled without token; last=${JSON.stringify(last)?.slice(0, 240)}`);
    }
    await sleep(1_000);
  }
  throw new Error(`timed out after ${timeoutMs / 1_000}s`);
}

async function runCase(testCase) {
  const startedAt = Date.now();
  let botId;
  const token = `CENTIPEDE_SMOKE_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  try {
    const created = await api("/api/bots", { method: "POST", body: "{}" });
    botId = created.bot.id;
    await api(`/api/bots/${botId}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: `Smoke · ${testCase.label}`,
        description: "Temporary hidden provider verification; safe to delete.",
        hidden: true,
        notifications: false,
        computer: "off",
        composio: false,
        autoApprove: true,
        modelSelection: { instanceId: testCase.instanceId, model: testCase.model },
      }),
    });
    await api(`/api/bots/${botId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: `Reply with exactly ${token} and nothing else. Do not use tools.` }),
    });
    await waitForReply(botId, token);
    return { ...testCase, ok: true, seconds: Number(((Date.now() - startedAt) / 1_000).toFixed(1)) };
  } catch (error) {
    return { ...testCase, ok: false, seconds: Number(((Date.now() - startedAt) / 1_000).toFixed(1)), error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (botId) await api(`/api/bots/${botId}`, { method: "DELETE" }).catch(() => undefined);
  }
}

const results = [];
for (let index = 0; index < cases.length; index += 4) {
  results.push(...await Promise.all(cases.slice(index, index + 4).map(runCase)));
}

console.table(results.map(({ label, model, ok, seconds, error }) => ({ label, model, ok, seconds, error: error ?? "" })));
if (results.some((result) => !result.ok)) process.exitCode = 1;
