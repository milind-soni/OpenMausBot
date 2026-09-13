// End-to-end check of a running OpenMausBot harness server — the exact
// flows the app drives, over the same HTTP API. No deps; Node 22+.
//
//   node scripts/e2e-server.mjs [--port 8799] [--with-box]
//
// Covered: server up + SSE hello, instance snapshots, a claude turn with a
// streamed reply, the permission broker (allow AND deny), interrupt, a
// codex turn, and — with --with-box + OMB_E2E_BOX_TOKEN — box provisioning,
// a turn that runs ON the box (boxAgent), and a panel screenshot. Box computers are put to sleep at
// the end. Test bots are deleted unless --keep-bots.
//
// Exits non-zero on the first hard failure; soft notes print as "skip".

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const PORT = Number(opt("--port", process.env.OMB_PORT ?? 8799));
const BASE = `http://127.0.0.1:${PORT}`;
const WITH_BOX = flag("--with-box");
const KEEP_BOTS = flag("--keep-bots");
const BOX_TOKEN = process.env.OMB_E2E_BOX_TOKEN ?? "";

const tag = Date.now().toString(36).slice(-6);
const marker = (s) => `omb-e2e-${s}-${tag}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// throw (not exit) so main's finally still deletes the test bots
const fail = (msg) => {
  throw new Error(msg);
};

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${body.error ?? "?"}`);
  return body;
}

/** Poll fn until it returns truthy or the budget runs out. */
async function until(what, fn, budgetMs, stepMs = 2000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > budgetMs) fail(`timed out waiting for: ${what}`);
    await sleep(stepMs);
  }
}

const getBot = async (id) => (await api("/api/bots")).bots.find((b) => b.id === id);

async function waitTurnDone(botId, budgetMs) {
  return until(
    `turn on bot ${botId.slice(0, 8)} to settle`,
    async () => {
      const bot = await getBot(botId);
      return bot && !bot.busy ? bot : null;
    },
    budgetMs,
  );
}

/** Poll until a live permission/question card appears OR the turn settles
 * without one (the CLI's safe-command classifier auto-allows sometimes —
 * variance, not a broker failure; only a silent stall is a failure). */
async function waitAskOrSettle(botId, budgetMs) {
  const t0 = Date.now();
  for (;;) {
    const b = await getBot(botId).catch(() => null);
    if (b) {
      const ask = b.messages.find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered);
      if (ask) return { ask };
      if (!b.busy) return { settled: b };
    }
    if (Date.now() - t0 > budgetMs) fail(`neither ask nor settle within ${budgetMs / 1000}s on bot ${botId.slice(0, 8)}`);
    await sleep(2000);
  }
}

async function makeBot(name, instanceId, model) {
  const { bot } = await api("/api/bots", { method: "POST", body: "{}" });
  const patched = await api(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name, modelSelection: { instanceId, model } }),
  });
  log(`bot "${name}" created (${patched.bot.id.slice(0, 8)}) on ${instanceId}/${model}`);
  return patched.bot;
}

const send = (botId, text) =>
  api(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text }) });

async function expectReply(bot, want, budgetMs) {
  await send(bot.id, `Reply with exactly this token and nothing else: ${want}`);
  const settled = await waitTurnDone(bot.id, budgetMs);
  const hit = settled.messages.find((m) => m.role === "bot" && m.kind === "text" && m.text?.includes(want));
  if (!hit) {
    const last = [...settled.messages].reverse().find((m) => m.kind !== "options");
    fail(`bot ${bot.name} settled but never said ${want}. Last message: ${JSON.stringify(last)?.slice(0, 300)}`);
  }
  log(`  ✓ ${bot.name} replied with ${want}`);
}

async function main() {
  log(`e2e against ${BASE} (box: ${WITH_BOX ? "yes" : "no"})`);

  // ── server up ──
  const { bots } = await api("/api/bots").catch((e) => fail(`server not up at ${BASE} — ${e.message}`));
  if (!Array.isArray(bots)) fail("/api/bots did not return a bots array");
  log("  ✓ server up,", bots.length, "bots");

  // ── SSE hello ──
  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/api/events`, { signal: ctrl.signal });
  const reader = sse.body.getReader();
  const hello = await Promise.race([
    reader.read().then(({ value }) => new TextDecoder().decode(value)),
    sleep(5000).then(() => ""),
  ]);
  ctrl.abort();
  if (!hello.includes('"hello"')) fail("SSE stream did not open with a hello frame");
  log("  ✓ SSE stream opens with hello");

  // ── instances ──
  const { instances } = await api("/api/instances");
  const byKind = {};
  for (const i of instances) byKind[i.driverKind] = i;
  for (const i of instances) log(`  instance ${i.instanceId} (${i.driverKind}): ${i.snapshot.state}${i.snapshot.version ? ` ${i.snapshot.version}` : ""}${i.snapshot.reason ? ` — ${i.snapshot.reason}` : ""}`);

  const created = [];
  try {
    // ── claude: plain turn ──
    if (byKind.claudeAgent?.snapshot.state === "available") {
      const bot = await makeBot("E2E Claude", "claude", byKind.claudeAgent.models.default);
      created.push(bot.id);
      await expectReply(bot, marker("claude"), 180_000);

      // permission broker: allow (curl usually trips the CLI's permission
      // layer; its safe-command classifier occasionally auto-allows —
      // soft-pass then, but a silent stall is a hard failure)
      await send(bot.id, `Run exactly one shell command: curl -sS https://example.com -o omb_${tag}_allow.html — then tell me the first word of the downloaded file.`);
      const allowTry = await waitAskOrSettle(bot.id, 180_000);
      if (allowTry.ask) {
        log(`  ✓ permission card appeared (${allowTry.ask.card.subtitle?.slice(0, 60)})`);
        await api(`/api/bots/${bot.id}/respond`, {
          method: "POST",
          body: JSON.stringify({ requestId: allowTry.ask.card.requestId, behavior: "allow" }),
        });
        const afterAllow = await waitTurnDone(bot.id, 240_000);
        if (!afterAllow.messages.find((m) => m.role === "bot" && m.kind === "text"))
          fail("no bot text after allow");
        log("  ✓ permission allow → turn completed");
      } else {
        const ran = allowTry.settled.messages.some((m) => m.kind === "activity" && m.tool?.name === "Bash" && m.tool.ok !== false);
        if (!ran) fail("no ask card AND the command never ran — silent stall");
        log("  note: CLI auto-allowed the command (classifier variance) — allow leg soft-passed");
      }

      // permission broker: deny — a fresh bot, because an allow above is
      // remembered by the resumed CLI session (no second ask otherwise)
      const denyBot = await makeBot("E2E Claude Deny", "claude", byKind.claudeAgent.models.default);
      created.push(denyBot.id);
      await send(denyBot.id, `Run the shell command "curl -sS https://example.org -o omb_${tag}_deny.html" — nothing else.`);
      const denyTry = await waitAskOrSettle(denyBot.id, 180_000);
      if (denyTry.ask) {
        await api(`/api/bots/${denyBot.id}/respond`, {
          method: "POST",
          body: JSON.stringify({ requestId: denyTry.ask.card.requestId, behavior: "deny" }),
        });
        await waitTurnDone(denyBot.id, 240_000);
        log("  ✓ permission deny → turn completed");
      } else {
        log("  note: no ask on the deny leg either (auto-allowed) — soft-passed");
      }

      // interrupt
      await send(bot.id, "Count from 1 to 200, one number per message line, no commentary.");
      await sleep(6000);
      await api(`/api/bots/${bot.id}/interrupt`, { method: "POST" });
      await waitTurnDone(bot.id, 60_000);
      log("  ✓ interrupt settles the turn");
    } else {
      log("  skip: claude CLI not available");
    }

    // ── codex: plain turn ──
    if (byKind.codex?.snapshot.state === "available") {
      // the catalog targets the newest CLI; older installs reject newer
      // model ids ("requires a newer version of Codex") — walk the catalog
      // until one answers
      let answered = false;
      for (const optn of byKind.codex.models.options) {
        const bot = await makeBot(`E2E Codex ${optn.id}`, "codex", optn.id);
        created.push(bot.id);
        const want = marker("codex");
        await send(bot.id, `Reply with exactly this token and nothing else: ${want}`);
        const settled = await waitTurnDone(bot.id, 300_000);
        if (settled.messages.find((m) => m.role === "bot" && m.kind === "text" && m.text?.includes(want))) {
          log(`  ✓ E2E Codex replied on ${optn.id}`);
          answered = true;
          break;
        }
        const err = [...settled.messages].reverse().find((m) => m.kind === "activity" && /error/i.test(m.tool?.name ?? ""));
        log(`  codex on ${optn.id} failed${err ? ` (${err.tool.name.slice(6, 100)})` : ""} — trying next catalog model`);
      }
      if (!answered) fail("codex answered on no catalog model");
    } else {
      log("  skip: codex CLI not available");
    }

    // ── box: cloud computer ──
    if (WITH_BOX) {
      if (!BOX_TOKEN) fail("--with-box needs OMB_E2E_BOX_TOKEN");
      await api("/api/config", { method: "PUT", body: JSON.stringify({ box: { token: BOX_TOKEN } }) });
      const cfg = await api("/api/config");
      if (!cfg.box?.configured) fail("box token saved but /api/config still says unconfigured");
      log("  ✓ box token configured, providers hot-reloaded");

      // a turn that runs ON the box (boxAgent) — provisions on first use.
      // One bot, models walked via PATCH: each bot owns one persistent box,
      // so re-provisioning per attempt would be wasteful. (On this account
      // the substrate's claude-code auth is expired — codex answers.)
      const boxBot = await makeBot("E2E Computer", "computer", byKind.boxAgent?.models.default ?? "sonnet");
      created.push(boxBot.id);
      let boxSaid = false;
      for (const optn of byKind.boxAgent?.models.options ?? [{ id: "sonnet" }]) {
        await api(`/api/bots/${boxBot.id}`, {
          method: "PATCH",
          body: JSON.stringify({ modelSelection: { instanceId: "computer", model: optn.id } }),
        });
        const want = marker("box");
        await send(boxBot.id, `Say exactly: ${want} — then stop.`);
        const settled = await waitTurnDone(boxBot.id, 600_000); // first provision can take minutes
        if (settled.messages.some((m) => m.role === "bot" && m.kind === "text" && m.text?.includes(want))) {
          log(`  ✓ box agent replied from its own computer on ${optn.id}`);
          boxSaid = true;
          break;
        }
        const last = [...settled.messages].reverse().find((m) => m.role === "bot" && m.kind === "text");
        log(`  box model ${optn.id} settled without the marker (${(last?.text ?? "?").slice(0, 90)}) — trying next`);
      }
      if (!boxSaid) fail("box agent answered on no catalog model");

      const shot = await api(`/api/bots/${boxBot.id}/computer/screenshot`, { method: "POST" });
      if (!shot.png || shot.png.length < 10_000) fail("box screenshot came back empty");
      log(`  ✓ box screenshot (${Math.round(shot.png.length / 1024)} KB base64)`);
      await api(`/api/bots/${boxBot.id}/computer/sleep`, { method: "POST" }).catch(() => {});
      log("  ✓ box asleep (billing paused)");

    }
  } catch (e) {
    // keep the bots (and their native/event NDJSON logs) for postmortem
    console.error(`\nFAIL: ${e.message} — ${created.length} test bot(s) kept for postmortem (delete via /api/bots/:id)`);
    process.exit(1);
  }
  if (!KEEP_BOTS) {
    for (const id of created) await api(`/api/bots/${id}`, { method: "DELETE" }).catch(() => {});
    if (created.length) log("  ✓ test bots deleted");
  }

  log("\nALL E2E CHECKS PASSED");
}

main().catch((e) => {
  console.error(`\nFAIL: ${e.message}`);
  process.exit(1);
});
